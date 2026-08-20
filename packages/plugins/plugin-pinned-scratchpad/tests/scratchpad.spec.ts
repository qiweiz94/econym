import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

import * as plugin from '../src/index.ts'
import type { ScratchpadEntry } from '../src/types.ts'

const testToolSignal = new AbortController().signal

/**
 * Drives the REAL plugin body: mounts the plugin on a real `ToolRuntime` and
 * `SystemPrompt`, invokes the registered `scratchpad_update` tool through
 * `ctx.tools.execute` with a fake parent Agent carrying a real `Session`, and
 * reads the section back through a real prompt assembly — so the appended
 * snapshot and the rendered block are both observable on shipping code (only
 * the agent wrapper is a stand-in).
 */

/** A parent Agent backed by a real Session — the tool and section read `agent.session`. */
function agentWithSession(id = 'scratchpad-agent'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

async function setup(config: Partial<plugin.Config> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(plugin, { totalBudget: 1000, ...config })
  return ctx
}

let callCounter = 0
function callUpdate(ctx: Context, args: unknown, over: { agent?: Agent | undefined } = {}) {
  const agent = 'agent' in over ? over.agent : agentWithSession(`caller-${++callCounter}`)
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name: 'scratchpad_update',
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

/** The block the section renders for `entries` — the quantity `totalBudget` bounds. */
function block(entries: readonly ScratchpadEntry[]): string {
  return ['<agent_scratchpad>', ...entries.map(e => `${e.key}: ${e.value}`), '</agent_scratchpad>'].join('\n')
}

async function sectionText(ctx: Context, agent?: Agent): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble(agent === undefined ? {} : { agent })
  const section = assembly.sections.find(s => s.name === 'scratchpad:pinned')
  expect(section).toBeDefined()
  return section!.text
}

function lastSnapshot(agent: Agent): ScratchpadEntry[] | undefined {
  const event = agent.session.events.findLast(e => e.type === 'scratchpad/write')
  return event?.data.entries
}

describe('dsh-plugin-pinned-scratchpad', () => {
  it('registers a `scratchpad_update` tool with a required key and a string-or-null value', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'scratchpad_update')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown>; required?: string[] }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['key', 'value'])
    expect((schema!.parameters as { required?: string[] }).required?.sort()).toEqual(['key', 'value'])
    expect(schema!.description).toContain('<agent_scratchpad>')
    expect(schema!.description).toContain('byte budget')
  })

  it('appends a scratchpad/write event carrying the whole store to the calling session', async () => {
    const ctx = await setup()
    const agent = agentWithSession('writer')
    const result = await callUpdate(ctx, { key: 'goal', value: 'ship the fix' }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected scratchpad_update success')
    const entries = [{ key: 'goal', value: 'ship the fix' }]
    expect(result.value).toEqual({
      action: 'set',
      key: 'goal',
      entries,
      usage: { usedBytes: Buffer.byteLength(block(entries), 'utf8'), budgetBytes: 1000 },
    })
    expect(text(result)).toContain('Scratchpad set "goal": 1 entry using')
    expect(lastSnapshot(agent)).toEqual(entries)
  })

  it('upserts an existing key in place, preserving insertion order', async () => {
    const ctx = await setup()
    const agent = agentWithSession('upserter')
    await callUpdate(ctx, { key: 'a', value: '1' }, { agent })
    await callUpdate(ctx, { key: 'b', value: '2' }, { agent })
    const result = await callUpdate(ctx, { key: 'a', value: 'one' }, { agent })
    expect(result.isError).toBe(false)
    expect(lastSnapshot(agent)).toEqual([
      { key: 'a', value: 'one' },
      { key: 'b', value: '2' },
    ])
    expect(text(result)).toContain('2 entries using')
  })

  it('stores the trimmed key and value, not the raw input', async () => {
    const ctx = await setup()
    const agent = agentWithSession('trimmer')
    const result = await callUpdate(ctx, { key: '  branch  ', value: '  lane/fix  ' }, { agent })
    expect(result.isError).toBe(false)
    expect(lastSnapshot(agent)).toEqual([{ key: 'branch', value: 'lane/fix' }])
  })

  it('deletes an entry with value null and reports the shrunk usage', async () => {
    const ctx = await setup()
    const agent = agentWithSession('deleter')
    await callUpdate(ctx, { key: 'a', value: '1' }, { agent })
    await callUpdate(ctx, { key: 'b', value: '2' }, { agent })
    const result = await callUpdate(ctx, { key: 'a', value: null }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected delete success')
    expect(result.value).toEqual({
      action: 'delete',
      key: 'a',
      entries: [{ key: 'b', value: '2' }],
      usage: { usedBytes: Buffer.byteLength(block([{ key: 'b', value: '2' }]), 'utf8'), budgetBytes: 1000 },
    })
    expect(text(result)).toContain('Scratchpad deleted "a": 1 entry using')
    expect(lastSnapshot(agent)).toEqual([{ key: 'b', value: '2' }])
  })

  it('rejects deleting a key that does not exist, naming the current keys', async () => {
    const ctx = await setup()
    const agent = agentWithSession('missing-delete')
    await callUpdate(ctx, { key: 'kept', value: 'x' }, { agent })
    const result = await callUpdate(ctx, { key: 'gone', value: null }, { agent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('"gone" does not exist')
    expect(text(result)).toContain('"kept"')
    // The rejected call must not reach the durable log.
    expect(agent.session.events.filter(e => e.type === 'scratchpad/write')).toHaveLength(1)
  })

  it('names (none) when deleting from an empty store', async () => {
    const ctx = await setup()
    const result = await callUpdate(ctx, { key: 'gone', value: null })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('current keys: (none)')
  })

  it.each([
    { label: 'an empty key', args: { key: '   ', value: 'x' }, fragment: 'non-empty' },
    { label: 'a multi-line key (\\n)', args: { key: 'a\nb', value: 'x' }, fragment: 'single line' },
    { label: 'a multi-line key (\\r)', args: { key: 'a\rb', value: 'x' }, fragment: 'single line' },
    { label: 'an empty value', args: { key: 'a', value: '   ' }, fragment: 'pass null to delete' },
    { label: 'a non-string non-null value', args: { key: 'a', value: 7 }, fragment: 'value' },
    { label: 'a missing key argument', args: { value: 'x' }, fragment: 'key' },
  ])('rejects $label as an isError result', async ({ args, fragment }) => {
    const ctx = await setup()
    const result = await callUpdate(ctx, args)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(fragment)
  })

  it('rejects a non-agent caller (the store has no owning session)', async () => {
    const ctx = await setup()
    const result = await callUpdate(ctx, { key: 'a', value: '1' }, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('owning agent session')
  })

  describe('byte budget (write-time, fail-loud)', () => {
    it('accepts an update whose rendered block exactly meets the budget', async () => {
      const entries = [{ key: 'k', value: 'value' }]
      const exact = Buffer.byteLength(block(entries), 'utf8')
      const ctx = await setup({ totalBudget: exact })
      const agent = agentWithSession('exact')
      const result = await callUpdate(ctx, { key: 'k', value: 'value' }, { agent })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected exact-budget success')
      expect(result.value).toEqual({
        action: 'set',
        key: 'k',
        entries,
        usage: { usedBytes: exact, budgetBytes: exact },
      })
    })

    it('rejects an update one byte over the budget, naming budget and current usage, without logging', async () => {
      const exact = Buffer.byteLength(block([{ key: 'k', value: 'value' }]), 'utf8')
      const ctx = await setup({ totalBudget: exact })
      const agent = agentWithSession('overflow')
      const result = await callUpdate(ctx, { key: 'k', value: 'value!' }, { agent })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain(`would need ${exact + 1} bytes but totalBudget is ${exact} bytes`)
      expect(text(result)).toContain('currently 0 used')
      expect(agent.session.events.some(e => e.type === 'scratchpad/write')).toBe(false)
    })

    it('counts multibyte characters in bytes, not characters', async () => {
      const ascii = [{ key: 'k', value: 'aaaa' }]
      const ctx = await setup({ totalBudget: Buffer.byteLength(block(ascii), 'utf8') })
      expect((await callUpdate(ctx, { key: 'k', value: 'aaaa' })).isError).toBe(false)
      // Same character count, three bytes per character: over budget.
      const result = await callUpdate(ctx, { key: 'k', value: '备备备备' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('bytes')
    })

    it('reports the pre-update usage when a later write overflows', async () => {
      const first = [{ key: 'a', value: 'small' }]
      const used = Buffer.byteLength(block(first), 'utf8')
      const ctx = await setup({ totalBudget: used })
      const agent = agentWithSession('second-write')
      await callUpdate(ctx, { key: 'a', value: 'small' }, { agent })
      const result = await callUpdate(ctx, { key: 'b', value: 'more' }, { agent })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain(`currently ${used} used`)
      expect(lastSnapshot(agent)).toEqual(first)
    })

    it('still deletes when a seeded store exceeds the configured budget', async () => {
      // A log written under a larger budget replays under a smaller one; the
      // budget gates the SET path only, so pruning back under budget stays possible.
      const ctx = await setup({ totalBudget: 60 })
      const agent = agentWithSession('over-budget-seed')
      agent.session.append('scratchpad/write', { entries: [
        { key: 'big', value: 'x'.repeat(200) },
        { key: 'keep', value: 'y' },
      ] })
      const set = await callUpdate(ctx, { key: 'keep', value: 'z' }, { agent })
      expect(set.isError).toBe(true)
      const del = await callUpdate(ctx, { key: 'big', value: null }, { agent })
      expect(del.isError).toBe(false)
      expect(lastSnapshot(agent)).toEqual([{ key: 'keep', value: 'y' }])
    })

    it('fails loud at load when totalBudget cannot admit any entry', async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await expect(ctx.plugin(plugin, { totalBudget: 5 }).then(() => undefined))
        .rejects.toThrow(/totalBudget must be at least \d+ bytes/)
    })
  })

  describe('the scratchpad:pinned prompt section', () => {
    it('renders the owning agent\'s current entries inside <agent_scratchpad>', async () => {
      const ctx = await setup()
      const agent = agentWithSession('sectioned')
      await callUpdate(ctx, { key: 'goal', value: 'ship' }, { agent })
      await callUpdate(ctx, { key: 'branch', value: 'lane/fix' }, { agent })
      expect(await sectionText(ctx, agent)).toBe(block([
        { key: 'goal', value: 'ship' },
        { key: 'branch', value: 'lane/fix' },
      ]))
    })

    it('renders after the stable sections so updates leave the prompt prefix byte-identical', async () => {
      const ctx = await setup()
      const agent = agentWithSession('tail')
      const before = renderPrompt(await ctx.systemPrompt.assemble({ agent }))
      await callUpdate(ctx, { key: 'goal', value: 'ship' }, { agent })
      const after = renderPrompt(await ctx.systemPrompt.assemble({ agent }))
      expect(after.startsWith(before)).toBe(true)
      expect(after.endsWith('</agent_scratchpad>')).toBe(true)
    })

    it('contributes nothing before the first write and for an agent-less assembly', async () => {
      const ctx = await setup()
      const agent = agentWithSession('empty-store')
      expect(await sectionText(ctx, agent)).toBe('')
      expect(await sectionText(ctx)).toBe('')
      expect(renderPrompt(await ctx.systemPrompt.assemble({ agent }))).not.toContain('<agent_scratchpad>')
    })

    it('empties again once the last entry is deleted', async () => {
      const ctx = await setup()
      const agent = agentWithSession('emptied')
      await callUpdate(ctx, { key: 'only', value: 'entry' }, { agent })
      await callUpdate(ctx, { key: 'only', value: null }, { agent })
      expect(await sectionText(ctx, agent)).toBe('')
    })
  })

  describe('durability: the store is folded from the session log alone', () => {
    it('reconstructs the same section content on a fresh mount over the replayed log', async () => {
      const ctx = await setup()
      const agent = agentWithSession('original')
      await callUpdate(ctx, { key: 'a', value: '1' }, { agent })
      await callUpdate(ctx, { key: 'b', value: '2' }, { agent })
      await callUpdate(ctx, { key: 'a', value: 'one' }, { agent })
      await callUpdate(ctx, { key: 'b', value: null }, { agent })
      const original = await sectionText(ctx, agent)
      expect(original).toBe(block([{ key: 'a', value: 'one' }]))

      // Fresh mount, fresh session seeded from the durable log: same content.
      const resumedCtx = await setup()
      const resumed = agentWithSession('resumed')
      const seeded = Session.create(SessionId('resumed-log'), agent.session.events)
      ;(resumed as { session: Session }).session = seeded
      expect(await sectionText(resumedCtx, resumed)).toBe(original)
    })

    it('folds the latest snapshot, so a later mutation replaces the replayed store', async () => {
      const ctx = await setup()
      const agent = agentWithSession('latest-wins')
      await callUpdate(ctx, { key: 'a', value: 'stale' }, { agent })
      await callUpdate(ctx, { key: 'a', value: 'fresh' }, { agent })
      expect(await sectionText(ctx, agent)).toBe(block([{ key: 'a', value: 'fresh' }]))
    })
  })

  it('presents the call with a stable title and the raw args', async () => {
    const ctx = await setup()
    const def = ctx.tools.get('scratchpad_update')!
    const args = { key: 'goal', value: 'ship' }
    expect(def.presentCall?.(args)).toEqual({ card: 'generic', title: 'Update scratchpad', kind: 'other', rawInput: args })
  })

  it('unregisters the tool AND the prompt section when its fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(plugin, { totalBudget: 1000 })
    expect(ctx.tools.schemas().some(s => s.name === 'scratchpad_update')).toBe(true)
    expect((await ctx.systemPrompt.assemble()).sections.some(s => s.name === 'scratchpad:pinned')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'scratchpad_update')).toBe(false)
    expect((await ctx.systemPrompt.assemble()).sections.some(s => s.name === 'scratchpad:pinned')).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    // A default export would make Loader unwrap only apply and drop `inject`.
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('plugin-pinned-scratchpad')
    expect(plugin.inject).toEqual(['tools', 'systemPrompt'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(plugin) as Record<string, unknown>
    expect(unwrapped).toBe(plugin)
    expect(unwrapped.name).toBe('plugin-pinned-scratchpad')
    expect(unwrapped.inject).toEqual(['tools', 'systemPrompt'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
