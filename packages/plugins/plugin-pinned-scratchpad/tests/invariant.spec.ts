import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PinnedScratchpad from '@econym/dsh-plugin-pinned-scratchpad'
import * as ScratchpadInvariant from '@econym/dsh-plugin-pinned-scratchpad/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ScratchpadInvariant)
  return ctx
}

function event(entries: unknown): SessionEvent {
  return { type: 'scratchpad/write', seq: 0, time: 0, data: { entries } } as SessionEvent
}

describe('scratchpad snapshot invariants', () => {
  it('accepts historical and live snapshots regardless of the configured byte budget', async () => {
    // 60 bytes of budget cannot admit this store, but the durable shape is
    // budget-independent: history written under a larger budget must replay.
    const entries = [
      { key: 'goal', value: 'ship the measurement fix end to end' },
      { key: 'branch', value: 'lane/fix\nsecond line stays legal in a value' },
    ]
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PinnedScratchpad, { totalBudget: 60 })
    ctx.sessions.create().append('scratchpad/write', { entries: [...entries] })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(ScratchpadInvariant).then(() => undefined)).resolves.toBeUndefined()
    expect(() => { ctx.emit('session/event', {} as Session, event(entries)) }).not.toThrow()
  })

  it.each([
    ['not-an-array', /must be an array/],
    [[null], /entries must be objects/],
    [[42], /entries must be objects/],
    [[{ key: 42, value: 'v' }], /key must be non-empty/],
    [[{ key: '', value: 'v' }], /key must be non-empty/],
    [[{ key: ' padded ', value: 'v' }], /already trimmed/],
    [[{ key: 'two\nlines', value: 'v' }], /single-line/],
    [[{ key: 'cr\rkey', value: 'v' }], /single-line/],
    [[{ key: 'same', value: 'a' }, { key: 'same', value: 'b' }], /repeats key/],
    [[{ key: 'k', value: 42 }], /value for "k" must be non-empty/],
    [[{ key: 'k', value: '' }], /value for "k" must be non-empty/],
    [[{ key: 'k', value: ' padded ' }], /must be non-empty and already trimmed/],
  ])('rejects an incoherent durable scratchpad snapshot', async (entries, message) => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, event(entries)) }).toThrow(message)
  })

  it('ignores unrelated dispatches and session events', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('tools/change')
      ctx.emit('session/event', {} as Session, {
        type: 'turn/start', seq: 0, time: 0, data: { turn: 1 },
      })
    }).not.toThrow()
  })

  it('rejects an invalid existing snapshot on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('scratchpad/write', {
      entries: [
        { key: 'duplicate', value: 'a' },
        { key: 'duplicate', value: 'b' },
      ],
    })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(ScratchpadInvariant).then(() => undefined)).rejects.toThrow(/repeats key "duplicate"/)
  })
})
