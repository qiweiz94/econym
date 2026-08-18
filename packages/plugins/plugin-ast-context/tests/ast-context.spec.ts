import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { AstSymbolExtractor } from '../src/extractor.ts'
import * as tool from '../src/index.ts'

const testSignal = new AbortController().signal
let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function fixture(content: string): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-ast-context-'))
  const path = join(root, 'sample.ts')
  await writeFile(path, content)
  return path
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool)
  return ctx
}

let callCounter = 0
function callOutline(ctx: Context, path: string) {
  return ctx.tools.execute({
    signal: testSignal,
    callId: CallId(`outline-${++callCounter}`),
    name: 'get_file_outline',
    arguments: { path },
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

const SOURCE = `import { x } from './x.ts'
export function quux(a: number): string { return '' }
export class Baz {
  qux() {}
  field = 1
}
export interface Foo {
  bar(): string
}
export type T = string
export enum E { A }
function local() {}
const anon = () => 1
`

describe('AstSymbolExtractor', () => {
  it('reports top-level declarations in source order with 1-based spans', () => {
    const symbols = new AstSymbolExtractor().extract(SOURCE)
    expect(symbols.map(s => s.name)).toEqual(['quux', 'Baz', 'Foo', 'T', 'E', 'local'])
    expect(symbols[0]).toEqual({
      kind: 'function', name: 'quux', line: 2, endLine: 2, children: [],
    })
    expect(symbols[1]).toEqual({
      kind: 'class', name: 'Baz', line: 3, endLine: 6, children: [
        { kind: 'function', name: 'qux', line: 4, endLine: 4, children: [] },
      ],
    })
    expect(symbols[2]).toEqual({
      kind: 'interface', name: 'Foo', line: 7, endLine: 9, children: [
        { kind: 'function', name: 'bar', line: 8, endLine: 8, children: [] },
      ],
    })
    expect(symbols[3]).toEqual({ kind: 'type', name: 'T', line: 10, endLine: 10, children: [] })
    expect(symbols[4]).toEqual({ kind: 'enum', name: 'E', line: 11, endLine: 11, children: [] })
    // `local` is a plain (non-exported) declaration; `anon` is a lexical
    // declaration and is deliberately not part of the outline.
    expect(symbols[5]).toEqual({ kind: 'function', name: 'local', line: 12, endLine: 12, children: [] })
  })

  it('ignores class fields and nested bodies beyond the member list', () => {
    const symbols = new AstSymbolExtractor().extract('export class Outer {\n  inner() {}\n  value = 1\n}\n')
    expect(symbols[0]?.children.map(c => c.name)).toEqual(['inner'])
  })

  it('throws when the text does not parse as a TypeScript program', () => {
    expect(() => new AstSymbolExtractor().extract('export function broken( {')).toThrow(/syntax errors/)
  })

  it('returns an empty outline for an empty file', () => {
    expect(new AstSymbolExtractor().extract('')).toEqual([])
  })

  it('omits anonymous default exports (they parse as expressions, not declarations)', () => {
    const symbols = new AstSymbolExtractor().extract('export default function () {}\n')
    expect(symbols).toEqual([])
  })
})

describe('dsh-plugin-ast-context', () => {
  it('registers a `get_file_outline` tool whose schema takes a required path', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'get_file_outline')
    expect(schema).toBeDefined()
    const compiled = schema!.parameters as unknown as {
      properties?: Record<string, { type?: string; description?: string }>
      required?: string[]
    }
    expect(Object.keys(compiled.properties ?? {})).toEqual(['path'])
    expect(compiled.properties?.path?.type).toBe('string')
    expect(typeof compiled.properties?.path?.description).toBe('string')
    expect(compiled.required).toEqual(['path'])
  })

  it('outlines a real file end to end through the tool registry', async () => {
    const path = await fixture('export function single(a: number): number { return a }\n')
    const ctx = await setup()
    const result = await callOutline(ctx, path)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected get_file_outline success')
    expect(result.value).toEqual({
      path,
      symbols: [{ kind: 'function', name: 'single', line: 1, endLine: 1, children: [] }],
    })
    expect(text(result)).toBe(`1 symbol in ${path}\nfunction single (line 1)`)
  })

  it('renders line ranges and indents members for multi-line symbols', async () => {
    const path = await fixture('export class Baz {\n  qux() {}\n}\n')
    const ctx = await setup()
    const result = await callOutline(ctx, path)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(`1 symbol in ${path}\nclass Baz (lines 1-3)\n  function qux (line 2)`)
  })

  it('pluralizes the renderer for files with several symbols', async () => {
    const path = await fixture('export function a() {}\nexport function b() {}\n')
    const ctx = await setup()
    const result = await callOutline(ctx, path)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(`2 symbols in ${path}\nfunction a (line 1)\nfunction b (line 2)`)
  })

  it('returns isError for an unreadable path', async () => {
    const ctx = await setup()
    const result = await callOutline(ctx, join(tmpdir(), 'dsh-ast-context-missing', 'nope.ts'))
    expect(result.isError).toBe(true)
  })

  it('returns isError for a file with syntax errors', async () => {
    const path = await fixture('export function broken( {')
    const ctx = await setup()
    const result = await callOutline(ctx, path)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('syntax errors')
  })

  it('presents the call as a generic read card with the file location', async () => {
    const ctx = await setup()
    const def = ctx.tools.get('get_file_outline')!
    expect(def.presentCall?.({ path: '/tmp/sample.ts' })).toEqual({
      card: 'generic',
      title: 'Outline file',
      kind: 'read',
      rawInput: '/tmp/sample.ts',
      locations: [{ path: '/tmp/sample.ts' }],
    })
  })

  it('unregisters the tool when its contributing fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(tool)
    expect(ctx.tools.schemas().some(s => s.name === 'get_file_outline')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'get_file_outline')).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('plugin-ast-context')
    expect(tool.inject).toEqual(['tools'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tool) as Record<string, unknown>
    expect(unwrapped).toBe(tool)
    expect(unwrapped.name).toBe('plugin-ast-context')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
