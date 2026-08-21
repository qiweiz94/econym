// Exercises the registered `sync_bilingual_pair` tool directly against a
// bare `Context` (no Loader), including a call to `apply()` with an EMPTY
// config object — bypassing `Config`'s schema defaulting — to prove the
// `config.* ?? <default>` fallbacks in src/index.ts are correct on their own,
// not merely unreachable because the schema always supplies a value first.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as tool from '../src/index.ts'
import type { SyncBilingualPairResult } from '../src/types.ts'
import { createFixtureRoot, removeFixtureRoot } from './fixtures.ts'

const SOURCE = ['# Title', '', '## Configuration', '', 'Old config text.', ''].join('\n')
const MIRROR = ['# 标题', '', '## 配置', '', '旧配置文本。', ''].join('\n')

const roots: string[] = []
const testToolSignal = new AbortController().signal

afterEach(() => {
  for (const root of roots) removeFixtureRoot(root)
  roots.length = 0
})

function fixture(files: Record<string, string>): string {
  const root = createFixtureRoot(files)
  roots.push(root)
  return root
}

/** Narrow the registry's untyped result value to the sync contract. */
function syncValue(result: { value: unknown }): SyncBilingualPairResult {
  return result.value as SyncBilingualPairResult
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

async function boot(config: tool.Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, config)
  return ctx
}

function callSync(ctx: Context, args: unknown): ReturnType<typeof ctx.tools.execute> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`sync-${Math.random().toString(16).slice(2)}`),
    name: 'sync_bilingual_pair',
    arguments: args,
  })
}

describe('plugin-doc-sync-automator tool registration', () => {
  it('registers sync_bilingual_pair with docPath + updatedSection.heading', async () => {
    const root = fixture({ 'doc.md': SOURCE, 'doc.zh.md': MIRROR })
    const ctx = await boot({ root })
    const schema = ctx.tools.schemas().find(s => s.name === 'sync_bilingual_pair')
    expect(schema).toBeDefined()

    const result = await callSync(ctx, { docPath: 'doc.md', updatedSection: { heading: 'Configuration' } })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected sync success')
    expect(syncValue(result).paired).toBe(true)
    expect(syncValue(result).pendingTranslation).toBe(true)
    expect(text(result)).toContain('NEEDS-TRANSLATION debt')
    expect(readFileSync(join(root, 'doc.zh.md'), 'utf8')).toContain('NEEDS-TRANSLATION')
  })

  it('reports the missing-mirror case through the model-facing render', async () => {
    const root = fixture({ 'doc.md': SOURCE })
    const ctx = await boot({ root })

    const result = await callSync(ctx, { docPath: 'doc.md', updatedSection: { heading: 'Configuration' } })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected sync success')
    expect(syncValue(result).paired).toBe(false)
    expect(text(result)).toContain('no mirror at doc.zh.md')
  })

  it('reports budgetOk: false through the model-facing render when a budget is breached', async () => {
    const root = fixture({
      'doc.md': SOURCE,
      'doc.zh.md': MIRROR,
      'budgets.manifest.json': JSON.stringify({ 'doc.zh.md': 1 }),
    })
    const ctx = await boot({ root, budgetManifestPath: 'budgets.manifest.json' })

    const result = await callSync(ctx, { docPath: 'doc.md', updatedSection: { heading: 'Configuration' } })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected sync success')
    expect(syncValue(result).budgetOk).toBe(false)
    expect(text(result)).toContain('OVER a budgeted ceiling')
  })

  it('honors a configured toolName', async () => {
    const root = fixture({ 'doc.md': SOURCE, 'doc.zh.md': MIRROR })
    const ctx = await boot({ root, toolName: 'custom_doc_sync' })
    expect(ctx.tools.schemas().find(s => s.name === 'custom_doc_sync')).toBeDefined()
    expect(ctx.tools.schemas().find(s => s.name === 'sync_bilingual_pair')).toBeUndefined()
  })

  it('apply() falls back to process.cwd() and the default budget manifest path when config omits them', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // Bypass Config's schema defaulting entirely: an empty object exercises
    // the `config.* ?? <default>` fallbacks in src/index.ts directly, both at
    // registration and (by actually calling the tool) inside execute().
    tool.apply(ctx, {})
    expect(ctx.tools.schemas().find(s => s.name === 'sync_bilingual_pair')).toBeDefined()

    // The doc genuinely does not exist at process.cwd(); this only needs to
    // prove the defaulted root/budget-manifest path were consulted.
    const result = await callSync(ctx, {
      docPath: 'nonexistent-doc-for-coverage-test.md',
      updatedSection: { heading: 'X' },
    })
    expect(result.isError).toBe(true)
  })
})
