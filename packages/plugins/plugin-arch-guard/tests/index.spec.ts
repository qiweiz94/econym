import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as tool from '../src/index.ts'
import { formatVerdict } from '../src/index.ts'

const testSignal = new AbortController().signal

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function setup(config?: object): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, config)
  return ctx
}

describe('formatVerdict', () => {
  it('renders an allowed verdict', () => {
    expect(formatVerdict({ allowed: true, rule: 'legal-cross-package-import' })).toBe('allowed (legal-cross-package-import)')
  })

  it('renders a blocked verdict with its suggestion', () => {
    expect(formatVerdict({ allowed: false, rule: 'layer-violation', suggestion: 'move it down a tier' }))
      .toBe('blocked (layer-violation): move it down a tier')
  })

  it('renders a blocked verdict with no suggestion', () => {
    expect(formatVerdict({ allowed: false, rule: 'layer-violation' })).toBe('blocked (layer-violation)')
  })
})

describe('plugin-arch-guard apply()', () => {
  it('registers check_module_boundary and scans config.root when given one', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-arch-guard-index-'))
    await mkdir(join(root, 'packages/core/demo'), { recursive: true })
    await writeFile(
      join(root, 'packages/core/demo/package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-demo', exports: { '.': { default: './lib/index.js' } } }),
      'utf8',
    )

    const ctx = await setup({ root })
    const result = await ctx.tools.execute({
      signal: testSignal,
      callId: CallId('index-spec-scoped-root'),
      name: 'check_module_boundary',
      arguments: { sourcePath: 'packages/core/demo/src/index.ts', targetImport: '@deepseek-ai/dsh-demo' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected check_module_boundary success')
    expect(result.value).toEqual({ allowed: true, rule: 'self-package-import' })
  })

  it('defaults to scanning the process cwd when config.root is omitted', async () => {
    // Calls apply() directly with a raw {} config, bypassing Cordis's own
    // schema-default resolution (which would already have filled `root` from
    // the Config schema's own `.default(process.cwd())` before apply ran) —
    // this is the only way to observe apply()'s own `?? process.cwd()` branch.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    tool.apply(ctx, {})
    const result = await ctx.tools.execute({
      signal: testSignal,
      callId: CallId('index-spec-default-root'),
      name: 'check_module_boundary',
      arguments: { sourcePath: 'packages/plugins/plugin-arch-guard/src/guard.ts', targetImport: '@deepseek-ai/dsh-tools' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected check_module_boundary success')
    expect(result.value).toEqual({ allowed: true, rule: 'legal-cross-package-import' })
  })

  it('presents the call as a generic read card naming the proposed import', async () => {
    const ctx = await setup()
    const def = ctx.tools.get('check_module_boundary')!
    expect(def.presentCall?.({ sourcePath: 'packages/plugins/plugin-arch-guard/src/guard.ts', targetImport: '@deepseek-ai/dsh-tools' })).toEqual({
      card: 'generic',
      title: 'Check module boundary',
      kind: 'read',
      rawInput: 'packages/plugins/plugin-arch-guard/src/guard.ts -> @deepseek-ai/dsh-tools',
      locations: [{ path: 'packages/plugins/plugin-arch-guard/src/guard.ts' }],
    })
  })
})
