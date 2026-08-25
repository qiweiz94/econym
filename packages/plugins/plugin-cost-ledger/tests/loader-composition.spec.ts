import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId, createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as CostLedger from '@econym/dsh-plugin-cost-ledger'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.length = 0
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots.length = 0
})

/**
 * Boot a cordis.yml mounting the session store and the cost-ledger plugin
 * with the given config lines. The export path is generated inside the temp
 * root and returned; when `useExport` is set, the config line is added here.
 */
async function boot(configLines: readonly string[], useExport = false): Promise<{ ctx: Context; exportPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cost-ledger-'))
  roots.push(root)
  const exportPath = join(root, 'cost-export.jsonl')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@econym/dsh-plugin-cost-ledger'",
    ...(configLines.length > 0 || useExport ? ['  config:', ...configLines, ...(useExport ? [`    exportPath: '${exportPath}'`] : [])] : []),
    '',
  ].join('\n'))

  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@econym/dsh-plugin-cost-ledger', CostLedger],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, exportPath }
}

/** One assistant step with explicit usage, appended to the given session. */
function appendUsage(session: SessionType, turn: number, provider: string, model: string): void {
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'composed answer' }],
      source: { kind: 'model', provider, model },
    }),
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 250_000,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 0,
      reasoningTokens: 10_000,
    },
  }, { surfaceOp: 'append' })
}

describe('plugin-cost-ledger real Loader composition through cordis.yml', () => {
  it('prices a configured hand-declared model end to end and exports its steps as JSONL', async () => {
    const { ctx, exportPath } = await boot([
      '    pricing:',
      '      ox-alpha-free:',
      '        input: 0.2',
      '        output: 1.2',
      '        cacheRead: 0.05',
      '        cacheWrite: 0.1',
    ], true)

    const session = ctx.sessions.create(SessionId('composed-cost-ledger'))
    appendUsage(session, 1, 'opencode-go', 'ox-alpha-free')

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('cost-ledger-e2e'),
      name: 'get_cost_ledger',
      arguments: {},
      agent: { id: session.id, session } as unknown as import('@deepseek-ai/dsh-agent').Agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected get_cost_ledger success')

    expect(result.value.models).toHaveLength(1)
    const alpha = result.value.models[0]
    // (1M×0.2 + 0.25M×1.2 + 0.5M×0.05 + 0M×0.1) / 1M = $0.525
    expect(alpha.estimatedCostUsd).toBe(0.525)
    expect(alpha.reasoningTokens).toBe(10_000)
    expect(result.value.totals.estimatedCostUsd).toBe(0.525)
    expect(result.value.exportedLines).toBe(1)

    // One JSONL line per priced assistant step, addressed by durable seq.
    const exported = await readFile(exportPath, 'utf8')
    const line = JSON.parse(exported.trim().split('\n')[0]!)
    expect(line).toMatchObject({
      seq: 0,
      provider: 'opencode-go',
      model: 'ox-alpha-free',
      inputTokens: 1_000_000,
      outputTokens: 250_000,
      estimatedCostUsd: 0.525,
    })

    // A second call exports nothing new (watermark advanced).
    const again = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('cost-ledger-e2e-2'),
      name: 'get_cost_ledger',
      arguments: {},
      agent: { id: session.id, session } as unknown as import('@deepseek-ai/dsh-agent').Agent,
    })
    expect(again.isError).toBe(false)
    if (again.isError) throw new Error('expected second get_cost_ledger success')
    expect(again.value.exportedLines).toBe(0)
  })

  it('reports an unpriced model with null cost and a whole-total of null', async () => {
    const { ctx } = await boot([])
    const session = ctx.sessions.create(SessionId('composed-unpriced'))
    appendUsage(session, 1, 'opencode-go', 'never-heard-of-it')

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('cost-ledger-unpriced'),
      name: 'get_cost_ledger',
      arguments: {},
      agent: { id: session.id, session } as unknown as import('@deepseek-ai/dsh-agent').Agent,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected get_cost_ledger success')
    expect(result.value.unpricedModels).toEqual(['never-heard-of-it'])
    expect(result.value.totals.estimatedCostUsd).toBeNull()
  })

  it('fails loud at load on an inverted or out-of-range peakHours window', async () => {
    // An inverted window passes the per-element schema but is rejected by apply().
    await expect(boot(['    peakHours: [[10, 6]]'])).rejects.toThrow(/invalid peakHours window/)
    // An out-of-range hour is rejected by the schema before apply() runs.
    await expect(boot(['    peakHours: [[24, 5]]'])).rejects.toThrow(/expected number <= 23/)
  })
})
