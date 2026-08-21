// Exercises the model-facing tool surface: schema, config validation, the
// renderer, the presentation card, and the error results the model actually
// sees when a patch is refused.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as tool from '../src/index.ts'

const testSignal = new AbortController().signal
let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write `content` to `sample.ts` in a fresh temp root and return both paths. */
async function fixture(content: string): Promise<{ root: string; path: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-semantic-patcher-tool-'))
  const path = join(root, 'sample.ts')
  await writeFile(path, content)
  return { root, path }
}

async function setup(config?: object): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, config)
  return ctx
}

let callCounter = 0
function callPatch(ctx: Context, args: { path: string; symbol: string; newBody: string }) {
  return ctx.tools.execute({
    signal: testSignal,
    callId: CallId(`patch-${++callCounter}`),
    name: 'patch_symbol_body',
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('patch_symbol_body tool surface', () => {
  it('registers a tool whose schema takes the three required arguments', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'patch_symbol_body')
    expect(schema).toBeDefined()
    expect(schema?.description).toContain('located in the parsed syntax tree')
  })

  it('exposes the namespace plugin export shape with no stray default', () => {
    expect(tool.name).toBe('plugin-semantic-patcher')
    expect(tool.inject).toEqual(['tools'])
    expect(typeof tool.apply).toBe('function')
    expect('default' in tool).toBe(false)
  })

  it('applies a patch end to end and returns the canonical result value', async () => {
    const { root: base, path } = await fixture('export function target() {\n  return 1\n}\n')
    const ctx = await setup({ cwd: base })
    const result = await callPatch(ctx, { path, symbol: 'target', newBody: '{\n  return 2\n}' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected patch_symbol_body success')
    expect(result.value).toEqual({ path, symbol: 'target', kind: 'function', line: 1, endLine: 3 })
    expect(await readFile(path, 'utf8')).toBe('export function target() {\n  return 2\n}\n')
  })

  it('renders a multi-line replacement as a line range', async () => {
    const { root: base, path } = await fixture('export function target() {\n  return 1\n}\n')
    const ctx = await setup({ cwd: base })
    const result = await callPatch(ctx, { path, symbol: 'target', newBody: '{\n  return 2\n}' })
    expect(text(result)).toBe(`Replaced the body of function target in ${path} (lines 1-3)`)
  })

  it('renders a single-line replacement as one line', async () => {
    const { root: base, path } = await fixture('class Foo {\n  bar() { return 1 }\n}\n')
    const ctx = await setup({ cwd: base })
    const result = await callPatch(ctx, { path, symbol: 'bar', newBody: '{ return 2 }' })
    expect(text(result)).toBe(`Replaced the body of method Foo.bar in ${path} (line 2)`)
  })

  it('surfaces an ambiguous symbol as an error result naming the candidates', async () => {
    const { root: base, path } = await fixture('class Foo {\n  run() {}\n}\nclass Bar {\n  run() {}\n}\n')
    const ctx = await setup({ cwd: base })
    const result = await callPatch(ctx, { path, symbol: 'run', newBody: '{}' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Disambiguate with one of: Foo.run, Bar.run')
  })

  it('surfaces a missing symbol as an error result naming the candidates', async () => {
    const { root: base, path } = await fixture('function alpha() {}\n')
    const ctx = await setup({ cwd: base })
    const result = await callPatch(ctx, { path, symbol: 'missing', newBody: '{}' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('candidates: alpha (function)')
  })

  it('refuses a file above the configured maxBytes', async () => {
    const { root: base, path } = await fixture('function target() { return 1 }\n')
    const ctx = await setup({ cwd: base, maxBytes: 4 })
    const result = await callPatch(ctx, { path, symbol: 'target', newBody: '{}' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('exceeding the 4-byte patch limit')
  })

  it('defaults the root to the process working directory when cwd is unset', async () => {
    const { path } = await fixture('function target() { return 1 }\n')
    const ctx = await setup()
    // The temp fixture is outside the repo checkout the tests run from, so the
    // default root is what refuses it — proving the fallback is the one in use.
    const result = await callPatch(ctx, { path, symbol: 'target', newBody: '{}' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(`outside the repository root ${process.cwd()}`)
  })

  it('accepts a bare apply call with no configuration argument', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    tool.apply(ctx)
    expect(ctx.tools.get('patch_symbol_body')).toBeDefined()
  })

  it('presents the call as a generic edit card naming the symbol and file', async () => {
    const ctx = await setup()
    const def = ctx.tools.get('patch_symbol_body')
    expect(def?.presentCall?.({ path: 'src/a.ts', symbol: 'Foo.bar', newBody: '{}' })).toEqual({
      card: 'generic',
      title: 'Patch symbol body',
      kind: 'edit',
      rawInput: 'Foo.bar in src/a.ts',
      locations: [{ path: 'src/a.ts' }],
    })
  })

  it('fails loud at load when maxBytes is not a positive integer', async () => {
    await expect(setup({ maxBytes: 0 })).rejects.toThrow(/maxBytes/)
  })
})
