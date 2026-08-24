/**
 * The `get_session_telemetry` snapshot vocabulary: the compact operating
 * figures the recorder folds out of one session's durable log plus the
 * subagent lifecycle stream.
 *
 * Every optional member is absent — never zero — when the log has not yet
 * produced the evidence it needs, so a reader can tell "no data" from "a
 * measured zero".
 *
 * @module @econym/dsh-plugin-telemetry-recorder/types
 */

/** Provider-reported token buckets accumulated over a set of turns; the four are disjoint. */
export interface TelemetryTokenBuckets {
  /** Uncached prompt tokens (`TokenUsage.inputTokens`). */
  inputTokens: number
  /** Prompt tokens served from the provider's prefix cache. */
  cacheReadTokens: number
  /** Prompt tokens written into the provider's prefix cache. */
  cacheWriteTokens: number
  /** Completion tokens, reasoning output included. */
  outputTokens: number
}

/** Token throughput over the closed turns still inside the rolling window. */
export interface TelemetryTokenVelocity {
  /** Closed turns the average was taken over. */
  turns: number
  /** All four buckets summed across those turns. */
  totalTokens: number
  /** `totalTokens / turns`, rounded to one decimal. */
  tokensPerTurn: number
}

/** Prompt-cache effectiveness over the same window, prompt side only. */
export interface TelemetryPromptCache {
  /** `cacheReadTokens / promptTokens`, rounded to four decimals. */
  hitRatio: number
  /** Uncached input, cache reads, and cache writes summed — the window's whole prompt cost. */
  promptTokens: number
  /** Cache-read tokens inside `promptTokens`. */
  cacheReadTokens: number
}

/**
 * How much of the route's advertised context the newest request's prompt
 * occupied. Capacity and pressure are independent last-wins records, not one
 * atomic observation: a route switch can pair a fresh capacity with the
 * previous route's prompt until the next request reports usage.
 */
export interface TelemetryContextHeadroom {
  /** Newest `request/context.contextWindow` seen in the log. */
  contextWindow: number
  /** Newest reported prompt size: uncached input plus cache reads and writes. */
  promptTokens: number
  /** `contextWindow - promptTokens`, floored at zero. */
  headroomTokens: number
  /** `promptTokens / contextWindow`, rounded to four decimals and capped at 1. */
  usedRatio: number
}

/** Wall-clock `turn/start` → `turn/end` spans over the window's closed turns. */
export interface TelemetryTurnLatency {
  /** Closed turns measured. */
  samples: number
  /** Arithmetic mean span, rounded to whole milliseconds. */
  meanMs: number
  /** Lower-median span (the `floor((n-1)/2)`-th of the sorted spans), in whole milliseconds. */
  medianMs: number
  /** Longest span, in whole milliseconds. */
  maxMs: number
}

/** Delegation counts for one subagent provider. */
export interface TelemetrySubagentProviderCounts {
  /** The `ctx.subagents` provider name that established the children. */
  provider: string
  /** Runs this provider started for the calling session. */
  started: number
  /** Runs that reached a terminal outcome. */
  ended: number
  /** `started - ended`: runs still in flight. */
  active: number
}

/** Subagent delegation counts attributed to the calling session. */
export interface TelemetrySubagentCounts {
  /** Runs started across every provider. */
  started: number
  /** Runs settled across every provider. */
  ended: number
  /** Runs still in flight across every provider. */
  active: number
  /** Per-provider breakdown, ordered by first-seen provider name. */
  byProvider: TelemetrySubagentProviderCounts[]
}

/** One compact reading of the calling session's operating telemetry. */
export interface TelemetrySnapshot {
  /** The configured rolling-window size in closed turns. */
  windowTurns: number
  /** Closed turns currently inside the window (never above `windowTurns`). */
  closedTurns: number
  /** The open turn's number while one is in flight; absent between turns. */
  openTurn?: number
  /** Absent until the window holds a closed turn. */
  tokenVelocity?: TelemetryTokenVelocity
  /** Absent until a request inside the window reported prompt-side usage. */
  promptCache?: TelemetryPromptCache
  /** Absent until the log carries both an advertised capacity and a reported prompt. */
  contextHeadroom?: TelemetryContextHeadroom
  /** Absent until the window holds a closed turn. */
  turnLatency?: TelemetryTurnLatency
  /** Delegation counts attributed to this session. */
  subagents: TelemetrySubagentCounts
  /**
   * Runs the recorder saw start but could not attribute to any session,
   * process-wide: the child had no live local agent when `subagent/start`
   * fired, so its `parentSession` lineage was unreadable. Reported so a
   * zero-count `subagents` block is never mistaken for "no delegation
   * happened".
   */
  unattributedSubagentRuns: number
}
