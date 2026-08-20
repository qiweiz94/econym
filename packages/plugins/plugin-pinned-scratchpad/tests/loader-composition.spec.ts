// Proves the plugin survives a REAL Loader composition and that totalBudget is
// real configurability, not a constant: a cordis.yml booted through the Loader
// mounts the namespace plugin (name/inject/apply), the registered tool writes a
// durable snapshot for a registered agent, the prompt section renders it, and
// budget misconfiguration fails the boot loud.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PinnedScratchpad from '@deepseek-ai/dsh-plugin-pinned-scratchpad'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('scratchpad-loader-agent')
  const session = Session.create(id)
  const value: Agent = {
    id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a cordis.yml carrying the given pinned-scratchpad config block.
 * @param configLines - YAML lines nested under the plugin's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-scratchpad-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-plugin-pinned-scratchpad'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-plugin-pinned-scratchpad', PinnedScratchpad],
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
  return ctx
}

describe('plugin-pinned-scratchpad real Loader composition through cordis.yml', () => {
  it('writes, renders, and reports usage end to end under the default budget', async () => {
    const ctx = await boot([])
    const owner = agent(ctx)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composed-set'),
      name: 'scratchpad_update',
      arguments: { key: 'goal', value: 'ship the plugin' },
      agent: owner,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected scratchpad_update success')
    expect(result.value).toMatchObject({
      action: 'set',
      key: 'goal',
      entries: [{ key: 'goal', value: 'ship the plugin' }],
      usage: { budgetBytes: 1000 },
    })
    expect(owner.session.events.findLast(e => e.type === 'scratchpad/write')?.data.entries)
      .toEqual([{ key: 'goal', value: 'ship the plugin' }])

    const assembly = await ctx.systemPrompt.assemble({ agent: owner })
    expect(assembly.sections.find(s => s.name === 'scratchpad:pinned')?.text)
      .toBe('<agent_scratchpad>\ngoal: ship the plugin\n</agent_scratchpad>')
  }, 30_000)

  it('a configured small budget rejects an oversized write end to end, naming both counts', async () => {
    const ctx = await boot(['    totalBudget: 50'])
    const owner = agent(ctx)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('composed-overflow'),
      name: 'scratchpad_update',
      arguments: { key: 'notes', value: 'a value far longer than fifty bytes of rendered block' },
      agent: owner,
    })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('totalBudget is 50 bytes')
    expect(owner.session.events.some(e => e.type === 'scratchpad/write')).toBe(false)
  }, 30_000)

  it.each([
    { label: 'is not a positive integer', configLines: ['    totalBudget: 0'], failure: /totalBudget/ },
    { label: 'is not integral', configLines: ['    totalBudget: 99.5'], failure: /totalBudget/ },
    { label: 'cannot admit any entry', configLines: ['    totalBudget: 5'], failure: /totalBudget must be at least \d+ bytes/ },
  ])('fails loading when totalBudget $label', async ({ configLines, failure }) => {
    // The budget is self-contained, so misconfiguration fails at load: the
    // entry's apply (or its z schema) rejects and boot never reaches a running tool.
    await expect(boot(configLines)).rejects.toThrow(failure)
  }, 30_000)
})
