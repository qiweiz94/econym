// The fold that answers `get_session_telemetry`: synthetic session logs with a
// controlled clock drive every rolling-window, cache-ratio, headroom and
// latency branch. Absence is asserted as absence throughout — a figure the log
// has produced no evidence for must be missing, never a measured-looking zero.
// Only `Date` is faked, so cordis' own async plugin lifecycle runs normally.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as TelemetryPlugin from '@econym/dsh-plugin-telemetry-recorder'
import type { Config, TelemetrySnapshot } from '@econym/dsh-plugin-telemetry-recorder'

let context: Context | undefined
let clock = 1_000_000

beforeEach(() => {
  clock = 1_000_000
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock)
})

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  vi.useRealTimers()
})

/** Move the faked wall clock the session stamps events with. */
function advance(ms: number): void {
  clock += ms
  vi.setSystemTime(clock)
}

async function harness(config: Config = {}): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TelemetryPlugin, config)
  return { ctx, session: ctx.sessions.create(SessionId('telemetry-subject')) }
}

/**
 * Call the registered tool. Only the Agent identity is faked — the session it
 * carries is the real one whose log the fold reads.
 */
async function read(ctx: Context, session: Session | undefined, callId = 'telemetry-read'): Promise<{
  isError: boolean
  value: TelemetrySnapshot
  text: string
}> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(callId),
    name: 'get_session_telemetry',
    arguments: {},
    ...session === undefined ? {} : { agent: { id: session.id, session } as unknown as Agent },
  })
  return {
    isError: result.isError,
    value: result.value as unknown as TelemetrySnapshot,
    text: result.content.map(block => block.type === 'text' ? block.text : '').join(''),
  }
}

/** Append an assembled assistant message reporting `usage` for one step. */
function reportUsage(session: Session, turn: number, step: number, usage: TokenUsage): void {
  session.append('assistant/message', {
    turn,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
    usage,
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
}

/** Report the same step's usage through the streaming `usage` chunk instead. */
function reportUsageChunk(session: Session, turn: number, step: number, usage: TokenUsage): void {
  session.append('assistant/chunk', { turn, step, chunk: { type: 'usage', usage } })
}

/** Run one complete turn, advancing the clock by `durationMs` inside it. */
function runTurn(session: Session, turn: number, durationMs: number, usage?: TokenUsage): void {
  session.append('turn/start', { turn })
  if (usage !== undefined) reportUsage(session, turn, 1, usage)
  advance(durationMs)
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('telemetry recorder fold', () => {
  it('omits every window figure on an empty log and reports zero delegations', async () => {
    const { ctx, session } = await harness()
    const { isError, value, text } = await read(ctx, session)

    expect(isError).toBe(false)
    expect(value.windowTurns).toBe(10)
    expect(value.closedTurns).toBe(0)
    expect(value.openTurn).toBeUndefined()
    expect(value.tokenVelocity).toBeUndefined()
    expect(value.promptCache).toBeUndefined()
    expect(value.contextHeadroom).toBeUndefined()
    expect(value.turnLatency).toBeUndefined()
    expect(value.subagents).toEqual({ started: 0, ended: 0, active: 0, byProvider: [] })
    expect(value.unattributedSubagentRuns).toBe(0)
    expect(text).toContain('session telemetry over the last 0 of 10 closed turns')
    expect(text).toContain('subagents started/ended/active: 0/0/0')
    expect(text).not.toContain('token velocity')
    expect(text).not.toContain('unattributed')
  })

  it('reports the open turn while one is in flight and drops it once it closes', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })

    expect((await read(ctx, session, 'open')).value.openTurn).toBe(1)
    expect((await read(ctx, session, 'open-text')).text).toContain('open turn: 1')

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect((await read(ctx, session, 'closed')).value.openTurn).toBeUndefined()
  })

  it('averages token velocity and turn latency over the closed turns', async () => {
    const { ctx, session } = await harness()
    runTurn(session, 1, 100, { inputTokens: 10, outputTokens: 5 })
    runTurn(session, 2, 300, { inputTokens: 20, outputTokens: 5 })

    const { value, text } = await read(ctx, session)
    expect(value.tokenVelocity).toEqual({ turns: 2, totalTokens: 40, tokensPerTurn: 20 })
    expect(value.turnLatency).toEqual({ samples: 2, meanMs: 200, medianMs: 100, maxMs: 300 })
    expect(text).toContain('token velocity: 20 tokens/turn (40 over 2)')
    expect(text).toContain('turn latency: mean 200 ms, median 100 ms, max 300 ms')
  })

  it('takes the lower median of an odd number of turns', async () => {
    const { ctx, session } = await harness()
    runTurn(session, 1, 500, { inputTokens: 1, outputTokens: 0 })
    runTurn(session, 2, 100, { inputTokens: 1, outputTokens: 0 })
    runTurn(session, 3, 300, { inputTokens: 1, outputTokens: 0 })

    expect((await read(ctx, session)).value.turnLatency)
      .toEqual({ samples: 3, meanMs: 300, medianMs: 300, maxMs: 500 })
  })

  it('computes the prompt-cache hit ratio from prompt-side buckets only', async () => {
    const { ctx, session } = await harness()
    runTurn(session, 1, 0, { inputTokens: 20, outputTokens: 500, cacheReadTokens: 60, cacheWriteTokens: 20 })

    const { value, text } = await read(ctx, session)
    expect(value.promptCache).toEqual({ hitRatio: 0.6, promptTokens: 100, cacheReadTokens: 60 })
    expect(text).toContain('prompt cache: 60% hit (60 of 100 prompt tokens)')
  })

  it('ignores step boundaries and non-usage chunks inside a turn', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'partial' },
    })
    reportUsage(session, 1, 1, { inputTokens: 6, outputTokens: 4 })
    session.append('step/end', { turn: 1, step: 1 })
    advance(50)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const { value } = await read(ctx, session)
    expect(value.tokenVelocity).toEqual({ turns: 1, totalTokens: 10, tokensPerTurn: 10 })
    expect(value.turnLatency).toEqual({ samples: 1, meanMs: 50, medianMs: 50, maxMs: 50 })
  })

  it('omits the cache ratio when the closed turns reported no prompt tokens', async () => {
    const { ctx, session } = await harness()
    runTurn(session, 1, 0, { inputTokens: 0, outputTokens: 12 })

    const { value } = await read(ctx, session)
    expect(value.tokenVelocity?.totalTokens).toBe(12)
    expect(value.promptCache).toBeUndefined()
  })

  it('replaces a step\'s earlier usage report instead of double counting it', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    reportUsageChunk(session, 1, 1, { inputTokens: 10, outputTokens: 1 })
    reportUsage(session, 1, 1, { inputTokens: 10, outputTokens: 7 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect((await read(ctx, session)).value.tokenVelocity?.totalTokens).toBe(17)
  })

  it('accumulates distinct steps of the same turn', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    reportUsage(session, 1, 1, { inputTokens: 10, outputTokens: 1 })
    reportUsage(session, 1, 2, { inputTokens: 4, outputTokens: 2 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect((await read(ctx, session)).value.tokenVelocity?.totalTokens).toBe(17)
  })

  it('attributes no usage reported outside the open turn', async () => {
    const { ctx, session } = await harness()
    reportUsage(session, 1, 1, { inputTokens: 9, outputTokens: 9 })
    session.append('turn/start', { turn: 2 })
    reportUsage(session, 7, 1, { inputTokens: 5, outputTokens: 5 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    expect((await read(ctx, session)).value.tokenVelocity)
      .toEqual({ turns: 1, totalTokens: 0, tokensPerTurn: 0 })
  })

  it('ignores a turn/end whose number does not match the open turn', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })

    const { value } = await read(ctx, session)
    expect(value.closedTurns).toBe(0)
    expect(value.openTurn).toBe(1)
  })

  it('ignores a turn/end with no open turn at all', async () => {
    const { ctx, session } = await harness()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect((await read(ctx, session)).value.closedTurns).toBe(0)
  })

  it('abandons an unclosed turn when the next one opens', async () => {
    const { ctx, session } = await harness()
    session.append('turn/start', { turn: 1 })
    reportUsage(session, 1, 1, { inputTokens: 50, outputTokens: 50 })
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    const { value } = await read(ctx, session)
    expect(value.closedTurns).toBe(1)
    expect(value.tokenVelocity?.totalTokens).toBe(0)
  })

  it('evicts the oldest closed turn once the window is full', async () => {
    const { ctx, session } = await harness({ windowTurns: 2 })
    runTurn(session, 1, 10, { inputTokens: 1000, outputTokens: 0 })
    runTurn(session, 2, 20, { inputTokens: 10, outputTokens: 0 })
    runTurn(session, 3, 30, { inputTokens: 20, outputTokens: 0 })

    const { value } = await read(ctx, session)
    expect(value.windowTurns).toBe(2)
    expect(value.closedTurns).toBe(2)
    expect(value.tokenVelocity).toEqual({ turns: 2, totalTokens: 30, tokensPerTurn: 15 })
    expect(value.turnLatency).toEqual({ samples: 2, meanMs: 25, medianMs: 20, maxMs: 30 })
  })

  it('pairs the newest advertised capacity with the newest reported prompt', async () => {
    const { ctx, session } = await harness()
    session.append('request/context', { provider: 'mock', model: 'mock-1', contextWindow: 1000 })
    runTurn(session, 1, 0, { inputTokens: 100, outputTokens: 40, cacheReadTokens: 150 })

    const { value, text } = await read(ctx, session)
    expect(value.contextHeadroom)
      .toEqual({ contextWindow: 1000, promptTokens: 250, headroomTokens: 750, usedRatio: 0.25 })
    expect(text).toContain('context headroom: 750 tokens left of 1000 (25% used)')
  })

  it('floors headroom at zero and caps the used ratio at one when the prompt exceeds capacity', async () => {
    const { ctx, session } = await harness()
    session.append('request/context', { provider: 'mock', model: 'mock-1', contextWindow: 100 })
    runTurn(session, 1, 0, { inputTokens: 400, outputTokens: 1 })

    expect((await read(ctx, session)).value.contextHeadroom)
      .toEqual({ contextWindow: 100, promptTokens: 400, headroomTokens: 0, usedRatio: 1 })
  })

  it('omits headroom when no route advertised a capacity', async () => {
    const { ctx, session } = await harness()
    session.append('request/context', { provider: 'mock', model: 'mock-1' })
    runTurn(session, 1, 0, { inputTokens: 400, outputTokens: 1 })

    expect((await read(ctx, session)).value.contextHeadroom).toBeUndefined()
  })

  it('omits headroom when a capacity is advertised but nothing reported a prompt', async () => {
    const { ctx, session } = await harness()
    session.append('request/context', { provider: 'mock', model: 'mock-1', contextWindow: 1000 })

    expect((await read(ctx, session)).value.contextHeadroom).toBeUndefined()
  })

  it('clears a previously advertised capacity when a later route advertises none', async () => {
    const { ctx, session } = await harness()
    session.append('request/context', { provider: 'mock', model: 'mock-1', contextWindow: 1000 })
    runTurn(session, 1, 0, { inputTokens: 10, outputTokens: 1 })
    session.append('request/context', { provider: 'mock', model: 'mock-2' })

    expect((await read(ctx, session)).value.contextHeadroom).toBeUndefined()
  })

  it('replays history appended before the first read and stays current afterwards', async () => {
    const { ctx, session } = await harness()
    // No read has happened yet, so the recorder holds no state for this session.
    runTurn(session, 1, 0, { inputTokens: 10, outputTokens: 10 })
    expect((await read(ctx, session, 'first')).value.closedTurns).toBe(1)

    runTurn(session, 2, 0, { inputTokens: 10, outputTokens: 10 })
    expect((await read(ctx, session, 'second')).value.closedTurns).toBe(2)
  })

  it('leaves an unobserved session unfolded while another session is read', async () => {
    const { ctx, session } = await harness()
    const other = ctx.sessions.create(SessionId('telemetry-other'))
    await read(ctx, session, 'warm')

    runTurn(other, 1, 0, { inputTokens: 3, outputTokens: 3 })
    runTurn(session, 1, 0, { inputTokens: 4, outputTokens: 4 })

    expect((await read(ctx, session, 'subject')).value.tokenVelocity?.totalTokens).toBe(8)
    expect((await read(ctx, other, 'other')).value.tokenVelocity?.totalTokens).toBe(6)
  })

  it('fails the call when no agent accompanies the execution', async () => {
    const { ctx } = await harness()
    const result = await read(ctx, undefined, 'agentless')

    expect(result.isError).toBe(true)
    expect(result.text).toContain('needs the calling agent')
  })

  it('rejects a non-positive window at load', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(TelemetryPlugin, { windowTurns: 0 })).rejects.toThrow(/windowTurns/)
  })
})

describe('subagent delegation counters', () => {
  /** Emit a lifecycle edge on the carrier the subagent seam publishes on. */
  function emitStart(ctx: Context, runId: string, provider: string, childId: SessionId): void {
    ctx.emit(scopeTarget(ctx as unknown as SubagentRuntime, undefined), 'subagent/start', {
      runId: SubagentRunId(runId),
      provider,
      id: childId,
      local: true,
    })
  }

  function emitEnd(ctx: Context, runId: string, provider: string, childId: SessionId): void {
    ctx.emit(scopeTarget(ctx as unknown as SubagentRuntime, undefined), 'subagent/end', {
      runId: SubagentRunId(runId),
      provider,
      id: childId,
      local: true,
      stopReason: 'completed',
    })
  }

  /** Register a live child agent whose session declares its parent lineage. */
  function liveChild(ctx: Context, id: string, parent?: SessionId): SessionId {
    const childId = SessionId(id)
    const session = ctx.sessions.create(childId, {
      meta: { ...parent === undefined ? {} : { parentSession: parent } },
    })
    const agent = { id: childId, session } as unknown as Agent
    ctx.agents.register(agent)
    return childId
  }

  async function delegationHarness(): Promise<{ ctx: Context; session: Session }> {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TelemetryPlugin)
    return { ctx, session: ctx.sessions.create(SessionId('telemetry-parent')) }
  }

  it('attributes a run to the delegating parent and settles it on the terminal edge', async () => {
    const { ctx, session } = await delegationHarness()
    const child = liveChild(ctx, 'child-1', session.id)

    emitStart(ctx, 'run-1', 'inproc', child)
    const started = await read(ctx, session, 'started')
    expect(started.value.subagents).toEqual({
      started: 1,
      ended: 0,
      active: 1,
      byProvider: [{ provider: 'inproc', started: 1, ended: 0, active: 1 }],
    })
    expect(started.text).toContain('subagents started/ended/active: 1/0/1 — inproc 1/0/1')

    emitEnd(ctx, 'run-1', 'inproc', child)
    expect((await read(ctx, session, 'ended')).value.subagents).toEqual({
      started: 1,
      ended: 1,
      active: 0,
      byProvider: [{ provider: 'inproc', started: 1, ended: 1, active: 0 }],
    })
  })

  it('keeps a separate breakdown per provider and totals them', async () => {
    const { ctx, session } = await delegationHarness()
    emitStart(ctx, 'run-a', 'inproc', liveChild(ctx, 'child-a', session.id))
    emitStart(ctx, 'run-b', 'remote', liveChild(ctx, 'child-b', session.id))
    emitStart(ctx, 'run-c', 'inproc', liveChild(ctx, 'child-c', session.id))
    emitEnd(ctx, 'run-b', 'remote', SessionId('child-b'))

    expect((await read(ctx, session)).value.subagents).toEqual({
      started: 3,
      ended: 1,
      active: 2,
      byProvider: [
        { provider: 'inproc', started: 2, ended: 0, active: 2 },
        { provider: 'remote', started: 1, ended: 1, active: 0 },
      ],
    })
  })

  it('does not attribute another session\'s delegations', async () => {
    const { ctx, session } = await delegationHarness()
    const stranger = ctx.sessions.create(SessionId('telemetry-stranger'))
    emitStart(ctx, 'run-x', 'inproc', liveChild(ctx, 'child-x', stranger.id))

    expect((await read(ctx, session)).value.subagents)
      .toEqual({ started: 0, ended: 0, active: 0, byProvider: [] })
  })

  it('counts a child with no readable lineage as unattributed', async () => {
    const { ctx, session } = await delegationHarness()
    emitStart(ctx, 'run-orphan', 'remote', liveChild(ctx, 'child-orphan'))

    const { value, text } = await read(ctx, session)
    expect(value.subagents).toEqual({ started: 0, ended: 0, active: 0, byProvider: [] })
    expect(value.unattributedSubagentRuns).toBe(1)
    expect(text).toContain('unattributed subagent runs: 1')

    // Its terminal edge is recognised but changes no attributed counter.
    emitEnd(ctx, 'run-orphan', 'remote', SessionId('child-orphan'))
    expect((await read(ctx, session, 'after-end')).value.unattributedSubagentRuns).toBe(1)
  })

  it('counts a run whose child has no live agent as unattributed', async () => {
    const { ctx, session } = await delegationHarness()
    emitStart(ctx, 'run-remote', 'remote', SessionId('never-registered'))

    expect((await read(ctx, session)).value.unattributedSubagentRuns).toBe(1)
  })

  it('counts every run as unattributed when no agent registry is mounted', async () => {
    const { ctx, session } = await harness()
    emitStart(ctx, 'run-registryless', 'inproc', SessionId('child-registryless'))

    expect((await read(ctx, session)).value.unattributedSubagentRuns).toBe(1)
  })

  it('ignores a terminal edge for a run it never saw start', async () => {
    const { ctx, session } = await delegationHarness()
    emitEnd(ctx, 'run-unknown', 'inproc', SessionId('child-unknown'))

    const { value } = await read(ctx, session)
    expect(value.subagents).toEqual({ started: 0, ended: 0, active: 0, byProvider: [] })
    expect(value.unattributedSubagentRuns).toBe(0)
  })

  it('drops a disposed session\'s counters', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TelemetryPlugin)

    const parent = ctx.sessions.prepare(SessionId('telemetry-transient'))
    const detach = ctx.sessions.enter(parent)
    ctx.sessions.announce(parent)
    emitStart(ctx, 'run-transient', 'inproc', liveChild(ctx, 'child-transient', parent.id))
    expect((await read(ctx, parent, 'before-dispose')).value.subagents.started).toBe(1)

    detach()
    const revived = ctx.sessions.create(SessionId('telemetry-transient'))
    expect((await read(ctx, revived, 'after-dispose')).value.subagents)
      .toEqual({ started: 0, ended: 0, active: 0, byProvider: [] })
  })
})
