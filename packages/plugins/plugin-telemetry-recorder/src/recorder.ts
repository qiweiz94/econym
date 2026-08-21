/**
 * The in-process telemetry fold: one replay-aware per-session accumulator over
 * the durable session log, plus process-wide subagent delegation bookkeeping
 * folded from the `subagent/start` / `subagent/end` observe pair.
 *
 * The recorder is a plain owned object, not a cordis service. Its only
 * consumer is this package's own `get_session_telemetry` tool, and a Context
 * service key with no external Consumer would ship a one-role capability seam
 * (`packages/AGENTS.md`: a public service method with one internal caller
 * passes a private capability closure instead). It copies `dsh-token-meter`'s
 * state mechanics — a `WeakMap` keyed by `Session` and a catch-up replay from
 * a consumed-event cursor — so a session that was resumed, forked, or already
 * running when this plugin mounted reports its real history rather than zeros.
 *
 * @module @deepseek-ai/dsh-plugin-telemetry-recorder/recorder
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: merges the `agents` Context key the parent lookup reads.
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: merges the `subagent/start` and `subagent/end` Events members.
import type {} from '@deepseek-ai/dsh-subagent'
import type {
  TelemetrySnapshot,
  TelemetrySubagentCounts,
  TelemetrySubagentProviderCounts,
  TelemetryTokenBuckets,
} from './types.ts'

/** One closed turn retained in the rolling window. */
interface ClosedTurn {
  /** Span from the turn's `turn/start` to its `turn/end`, in milliseconds. */
  durationMs: number
  /** Provider-reported tokens attributed to the turn. */
  tokens: TelemetryTokenBuckets
}

/** The turn currently open, with the usage it has accrued so far. */
interface OpenTurn {
  turn: number
  startTime: number
  tokens: TelemetryTokenBuckets
  /**
   * The newest usage report already folded into {@link tokens}, kept so a step
   * that reports usage twice (a `usage` stream chunk and then the assembled
   * `assistant/message`) replaces its earlier value instead of doubling it.
   */
  lastSample?: { step: number; buckets: TelemetryTokenBuckets }
}

/** Per-session fold state; `consumedEvents` is the replay cursor into `session.events`. */
interface RecorderState {
  consumedEvents: number
  closed: ClosedTurn[]
  open: OpenTurn | null
  contextWindow?: number
  lastPromptTokens?: number
}

/** Delegation counters for one provider, mutated in place while runs come and go. */
interface ProviderCounts {
  started: number
  ended: number
  active: number
}

/** A started run awaiting its terminal event. */
interface OpenRun {
  provider: string
  /** The delegating parent's session id, or undefined when the child was unattributable. */
  parent: SessionId | undefined
}

const zeroBuckets = (): TelemetryTokenBuckets => ({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
})

/**
 * Round to a fixed number of decimals without exposing float noise.
 * @param value - the raw quotient or mean.
 * @param digits - decimals to keep.
 * @returns the rounded number.
 */
function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * The usage one event reports, from either place a step reports it.
 * @param event - the session event to inspect.
 * @returns the reported usage, or undefined when the event reports none.
 */
function usageOf(event: SessionEvent): TokenUsage | undefined {
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') return event.data.chunk.usage
  if (event.type === 'assistant/message') return event.data.usage
  return undefined
}

/** The prompt-side cost of one usage report: everything the request sent. */
const promptTokensOf = (buckets: TelemetryTokenBuckets): number =>
  buckets.inputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens

/** Every bucket summed — the turn's whole provider-reported token cost. */
const totalTokensOf = (buckets: TelemetryTokenBuckets): number =>
  promptTokensOf(buckets) + buckets.outputTokens

/**
 * Add one usage report's buckets into an accumulator, optionally backing out
 * the report it supersedes.
 * @param target - accumulator mutated in place.
 * @param next - the buckets to add.
 * @param previous - the superseded buckets to subtract first, when any.
 */
function accrue(
  target: TelemetryTokenBuckets,
  next: TelemetryTokenBuckets,
  previous?: TelemetryTokenBuckets,
): void {
  target.inputTokens += next.inputTokens - (previous?.inputTokens ?? 0)
  target.cacheReadTokens += next.cacheReadTokens - (previous?.cacheReadTokens ?? 0)
  target.cacheWriteTokens += next.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0)
  target.outputTokens += next.outputTokens - (previous?.outputTokens ?? 0)
}

/**
 * Owned telemetry accumulator for one plugin fiber.
 *
 * Session state is lazily created on the first {@link snapshot} for that
 * session and then kept current by the fiber's `session/event` listener, so
 * the recorder holds nothing for sessions nobody has asked about.
 */
export class TelemetryRecorder {
  private readonly states = new WeakMap<Session, RecorderState>()
  private readonly runs = new Map<string, OpenRun>()
  private readonly perSession = new Map<SessionId, Map<string, ProviderCounts>>()
  private unattributedRuns = 0

  /**
   * @param ctx - the plugin fiber's context, used to resolve a started child's live agent.
   * @param windowTurns - closed turns retained by the rolling window; at least 1.
   */
  constructor(private readonly ctx: Context, private readonly windowTurns: number) {}

  /**
   * Catch a session up to its durable tail, but only when the session is
   * already observed. An unobserved session is left alone so the recorder does
   * not accumulate state for every session in the process.
   * @param session - the session whose log may have grown.
   */
  observe(session: Session): void {
    if (this.states.has(session)) this.sync(session)
  }

  /**
   * Record a started delegation against its delegating parent session.
   *
   * The lifecycle payload carries the child's id, not the parent's, so the
   * parent is recovered from the live child agent's session header. A child
   * with no live local agent (a remote provider, or one already gone) is
   * counted as unattributed instead of being dropped silently.
   * @param runId - the run identity shared with the terminal event.
   * @param provider - the establishing `ctx.subagents` provider name.
   * @param childId - the child agent's id.
   */
  startRun(runId: string, provider: string, childId: SessionId): void {
    const parent = this.ctx.get('agents')?.get(childId)?.session.header.parentSession
    this.runs.set(runId, { provider, parent })
    if (parent === undefined) {
      this.unattributedRuns += 1
      return
    }
    const counts = this.counts(parent, provider)
    counts.started += 1
    counts.active += 1
  }

  /**
   * Settle a delegation previously seen by {@link startRun}. An end with no
   * recorded start (the run began before this fiber mounted) changes nothing.
   * @param runId - the run identity shared with the start event.
   */
  endRun(runId: string): void {
    const run = this.runs.get(runId)
    if (run === undefined) return
    this.runs.delete(runId)
    if (run.parent === undefined) return
    const counts = this.counts(run.parent, run.provider)
    counts.ended += 1
    counts.active -= 1
  }

  /**
   * Drop a disposed session's delegation counters so the process-wide map
   * cannot grow without bound. In-flight runs keep their entry: their terminal
   * event still has to find a recorded start.
   * @param sessionId - the disposed session's id.
   */
  forget(sessionId: SessionId): void {
    this.perSession.delete(sessionId)
  }

  /**
   * Read the calling session's current telemetry.
   * @param session - the session to measure, replayed to its durable tail first.
   * @returns a detached snapshot; optional members are absent when unmeasured.
   */
  snapshot(session: Session): TelemetrySnapshot {
    const state = this.sync(session)
    const closed = state.closed
    const totals = zeroBuckets()
    let maxMs = 0
    let sumMs = 0
    for (const turn of closed) {
      accrue(totals, turn.tokens)
      sumMs += turn.durationMs
      if (turn.durationMs > maxMs) maxMs = turn.durationMs
    }
    const spans = closed.map(turn => turn.durationMs).sort((left, right) => left - right)
    const promptTokens = promptTokensOf(totals)

    return {
      windowTurns: this.windowTurns,
      closedTurns: closed.length,
      ...state.open === null ? {} : { openTurn: state.open.turn },
      ...closed.length === 0 ? {} : {
        tokenVelocity: {
          turns: closed.length,
          totalTokens: totalTokensOf(totals),
          tokensPerTurn: round(totalTokensOf(totals) / closed.length, 1),
        },
        turnLatency: {
          samples: closed.length,
          meanMs: Math.round(sumMs / closed.length),
          // oxlint-disable-next-line typescript/no-non-null-assertion -- a non-empty array has a lower-median element
          medianMs: Math.round(spans[Math.floor((spans.length - 1) / 2)]!),
          maxMs: Math.round(maxMs),
        },
      },
      ...promptTokens === 0 ? {} : {
        promptCache: {
          hitRatio: round(totals.cacheReadTokens / promptTokens, 4),
          promptTokens,
          cacheReadTokens: totals.cacheReadTokens,
        },
      },
      ...state.contextWindow === undefined || state.lastPromptTokens === undefined ? {} : {
        contextHeadroom: {
          contextWindow: state.contextWindow,
          promptTokens: state.lastPromptTokens,
          headroomTokens: Math.max(0, state.contextWindow - state.lastPromptTokens),
          usedRatio: round(Math.min(1, state.lastPromptTokens / state.contextWindow), 4),
        },
      },
      subagents: this.subagentCounts(session.id),
      unattributedSubagentRuns: this.unattributedRuns,
    }
  }

  /** Resolve (creating on first use) one provider's counters for one parent session. */
  private counts(sessionId: SessionId, provider: string): ProviderCounts {
    let byProvider = this.perSession.get(sessionId)
    if (byProvider === undefined) {
      byProvider = new Map()
      this.perSession.set(sessionId, byProvider)
    }
    let counts = byProvider.get(provider)
    if (counts === undefined) {
      counts = { started: 0, ended: 0, active: 0 }
      byProvider.set(provider, counts)
    }
    return counts
  }

  /** Project one session's delegation counters into the snapshot's reporting form. */
  private subagentCounts(sessionId: SessionId): TelemetrySubagentCounts {
    const byProvider: TelemetrySubagentProviderCounts[] = []
    const total: ProviderCounts = { started: 0, ended: 0, active: 0 }
    for (const [provider, counts] of this.perSession.get(sessionId) ?? []) {
      byProvider.push({ provider, ...counts })
      total.started += counts.started
      total.ended += counts.ended
      total.active += counts.active
    }
    return { ...total, byProvider }
  }

  /** Catch one session's fold up to the current durable tail, creating state on first use. */
  private sync(session: Session): RecorderState {
    let state = this.states.get(session)
    if (state === undefined) {
      state = { consumedEvents: 0, closed: [], open: null }
      this.states.set(session, state)
    }
    while (state.consumedEvents < session.events.length) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- contiguous session seqs index the durable log
      this.fold(state, session.events[state.consumedEvents]!)
      state.consumedEvents += 1
    }
    return state
  }

  /** Apply one durable event to the session fold. */
  private fold(state: RecorderState, event: SessionEvent): void {
    if (event.type === 'turn/start') {
      // A turn never nests; a start while one is open abandons the older
      // record rather than attributing two turns' usage to one span.
      state.open = { turn: event.data.turn, startTime: event.time, tokens: zeroBuckets() }
      return
    }
    if (event.type === 'request/context') {
      const contextWindow = event.data.contextWindow
      if (contextWindow === undefined) delete state.contextWindow
      else state.contextWindow = contextWindow
      return
    }
    if (event.type === 'turn/end') {
      const open = state.open
      if (open === null || open.turn !== event.data.turn) return
      state.open = null
      state.closed.push({ durationMs: Math.max(0, event.time - open.startTime), tokens: open.tokens })
      if (state.closed.length > this.windowTurns) state.closed.shift()
      return
    }
    const usage = usageOf(event)
    if (usage === undefined) return
    const buckets: TelemetryTokenBuckets = {
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      outputTokens: usage.outputTokens,
    }
    state.lastPromptTokens = promptTokensOf(buckets)
    const open = state.open
    // `assistant/chunk` and `assistant/message` both carry turn/step coordinates.
    const data = event.data as { turn: number; step: number }
    if (open === null || open.turn !== data.turn) return
    accrue(open.tokens, buckets, open.lastSample?.step === data.step ? open.lastSample.buckets : undefined)
    open.lastSample = { step: data.step, buckets }
  }
}
