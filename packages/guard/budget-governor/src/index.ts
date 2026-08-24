/**
 * Budget governor: a circuit breaker for runaway delegated child agent runs.
 * It tracks every locally published subagent run announced by
 * `subagent/start`, watches the child session's own events for configured
 * ceilings — cumulative token growth, consecutive tool failures, same-file
 * edit churn. In the default `enforce` mode a tripped run is terminated
 * through the child Agent's public cancellation seam (`cancel({ kind: 'hook',
 * … })`); the aborted run settles through the ordinary delegation machinery
 * (an `isError` tool result that preserves partial output). In `observe` mode
 * the run is left to continue and only reported. In both modes the governor
 * injects one structured, logged report into the parent agent so the parent
 * model learns a ceiling was crossed. A run reports at most once per turn and
 * is re-armed on its next turn, so a continuable child stays governed across
 * its parent's follow-ups. The root agent is never governed:
 * only sessions announced by the subagent lifecycle events are tracked.
 * Remote runs (`local: false`) expose no local agent or session events and
 * are not governed. Named exports preserve loader injection metadata.
 * Decision record: the budget-governor Agent Note.
 * @module @econym/dsh-budget-governor
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
// Type-only: declares `ctx.tokenMeter` for the injected measurement service.
import type {} from '@deepseek-ai/dsh-token-meter'
import { ConsecutiveFailureCounter, EditChurnWindow } from './detectors.ts'
import type { EditChurnConfig } from './types.ts'

export type { EditChurnConfig, EditToolSpec } from './types.ts'
export { ConsecutiveFailureCounter, EditChurnWindow } from './detectors.ts'

export const name = 'budget-governor'
export const inject = ['subagents', 'agents', 'tokenMeter']

/**
 * Runtime configuration; at least one ceiling must be configured. Declared
 * here (not in `./types.ts`) so it merges with the runtime schema value of
 * the same name declared immediately below — a re-exported type-only binding
 * cannot merge with a same-named value export (TS2395/TS2323).
 */
export interface Config {
  /**
   * What a tripped ceiling does. `enforce` (default) cancels the child run;
   * `observe` only reports and warns, leaving the run to continue — a cautious
   * deployment that wants the signal without the intervention. Both modes
   * inject the same model-visible notice into the parent.
   */
  mode?: 'enforce' | 'observe'
  /**
   * Flag a child run whose session measures above this many tokens
   * (`ctx.tokenMeter.measure` — the model-visible request surface, not
   * provider-billed spend). Integer >= 1.
   */
  maxChildTokens?: number
  /** Flag a child run after this many consecutive failed tool calls. Integer >= 1. */
  maxConsecutiveToolFailures?: number
  /** Flag a child run that keeps re-editing one file (see {@link EditChurnConfig}). */
  editChurn?: EditChurnConfig
}

/**
 * Runtime configuration schema. The loader validates it; `apply` re-checks the
 * fail-loud constraints so a direct caller gets the same rejection.
 */
export const Config: z<Config> = z.object({
  mode: z.union([z.const('enforce' as const), z.const('observe' as const)]).default('enforce'),
  maxChildTokens: z.number(),
  maxConsecutiveToolFailures: z.number(),
  // Preserve omission; a materialized `{}` would read as a half-configured ceiling.
  editChurn: z.object({
    maxSameFileEdits: z.number().required(),
    window: z.number().required(),
    tools: z.array(z.object({
      name: z.string().required(),
      pathArgument: z.string().required(),
    })).required(),
  }).default(undefined as unknown as EditChurnConfig),
})

/** The ceiling vocabulary used in the report's one-line summary. */
type CeilingKind = 'token ceiling' | 'consecutive tool failures' | 'file edit churn'

/** Validated configuration with the edit-tool list folded into a lookup map. */
interface ResolvedConfig {
  readonly mode: 'enforce' | 'observe'
  readonly maxChildTokens?: number
  readonly maxConsecutiveToolFailures?: number
  readonly editChurn?: {
    readonly maxSameFileEdits: number
    readonly window: number
    /** Edit tool name → path argument key. */
    readonly tools: ReadonlyMap<string, string>
  }
}

/** Fail loud on a non-integer or out-of-range ceiling. */
function requireInteger(field: string, value: number, min: number): number {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`budget-governor: invalid ${field} ${value} — must be an integer >= ${min}`)
  }
  return value
}

/**
 * Validate the configuration per the fail-loud contract.
 * @param config - raw plugin config (loader-validated or caller-supplied).
 * @returns the validated ceilings with the edit-tool lookup map built.
 * @throws when no ceiling is configured or any configured ceiling is invalid.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  if (config.maxChildTokens === undefined && config.maxConsecutiveToolFailures === undefined
    && config.editChurn === undefined) {
    throw new Error(
      'budget-governor: no ceiling is configured — set at least one of '
      + '`maxChildTokens`, `maxConsecutiveToolFailures`, or `editChurn`, or remove the plugin',
    )
  }
  const resolved: {
    mode: 'enforce' | 'observe'
    maxChildTokens?: number
    maxConsecutiveToolFailures?: number
    editChurn?: { maxSameFileEdits: number; window: number; tools: ReadonlyMap<string, string> }
  } = { mode: config.mode ?? 'enforce' }
  if (config.maxChildTokens !== undefined) {
    resolved.maxChildTokens = requireInteger('maxChildTokens', config.maxChildTokens, 1)
  }
  if (config.maxConsecutiveToolFailures !== undefined) {
    resolved.maxConsecutiveToolFailures
      = requireInteger('maxConsecutiveToolFailures', config.maxConsecutiveToolFailures, 1)
  }
  if (config.editChurn !== undefined) {
    const churn = config.editChurn
    const maxSameFileEdits = requireInteger('editChurn.maxSameFileEdits', churn.maxSameFileEdits, 2)
    const window = requireInteger('editChurn.window', churn.window, 2)
    if (window < maxSameFileEdits) {
      throw new Error(
        `budget-governor: editChurn.window ${window} is smaller than `
        + `editChurn.maxSameFileEdits ${maxSameFileEdits} — that ceiling could never trip`,
      )
    }
    if (churn.tools.length === 0) {
      throw new Error('budget-governor: editChurn.tools must name at least one edit tool')
    }
    const tools = new Map<string, string>()
    for (const tool of churn.tools) {
      if (tool.name.length === 0 || tool.pathArgument.length === 0) {
        throw new Error(
          'budget-governor: every editChurn tool needs a non-empty `name` and `pathArgument`',
        )
      }
      if (tools.has(tool.name)) {
        throw new Error(`budget-governor: duplicate editChurn tool "${tool.name}"`)
      }
      tools.set(tool.name, tool.pathArgument)
    }
    resolved.editChurn = { maxSameFileEdits, window, tools }
  }
  return resolved
}

/** One governed run's live state, created at `subagent/start` and dropped at `subagent/end`. */
interface RunState {
  /** The published local child, resolved during the start notification. */
  readonly child: Agent
  failures?: ConsecutiveFailureCounter
  churn?: EditChurnWindow
  /** In-flight call id → tool name, kept only for failure-report evidence. */
  pendingCalls?: Map<CallId, string>
  /**
   * Whether a ceiling has already tripped in the CURRENT turn — one report per
   * turn. Cleared and its per-turn detectors re-armed at the next `turn/start`,
   * so a continuable child the governor already acted on is governed afresh on
   * its parent's next follow-up rather than running unwatched.
   */
  trippedThisTurn: boolean
  /** Detector-failure warnings are limited to one per run. */
  warned: boolean
}

/** Build the per-run detectors from config (used at start and at each re-arm). */
function armRun(run: RunState, resolved: ResolvedConfig): void {
  run.trippedThisTurn = false
  if (resolved.maxConsecutiveToolFailures === undefined) {
    delete run.failures
    delete run.pendingCalls
  } else {
    run.failures = new ConsecutiveFailureCounter(resolved.maxConsecutiveToolFailures)
    run.pendingCalls = new Map<CallId, string>()
  }
  if (resolved.editChurn === undefined) {
    delete run.churn
  } else {
    run.churn = new EditChurnWindow(resolved.editChurn.maxSameFileEdits, resolved.editChurn.window)
  }
}

/** Parse the model's raw argument JSON and extract one string-valued path argument. */
function extractPath(rawArguments: string, pathArgument: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    // Malformed argument JSON never reaches a tool; the loop's own error result
    // feeds the failure detector instead, so churn simply skips the call.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const value = (parsed as Record<string, unknown>)[pathArgument]
  return typeof value === 'string' ? value : undefined
}

/** The model-visible report injected into the parent agent when a ceiling trips. */
function ceilingReport(childId: SessionId, reason: string, mode: 'enforce' | 'observe'): string {
  const lead = mode === 'enforce'
    ? 'A delegated subagent run was terminated by the budget governor.'
    : 'A delegated subagent run crossed a budget-governor ceiling (observe mode — the run was NOT stopped).'
  const tail = mode === 'enforce'
    ? 'The delegation\'s tool result reports the cancellation and preserves any partial '
      + 'output produced before termination. Do not repeat the same delegation unchanged; '
      + 'revise or split the task before delegating again.'
    : 'The run continues. Consider whether the delegation is making progress; revise or '
      + 'split the task if it is not.'
  return `${lead}\n- child: ${childId}\n- ceiling: ${reason}\n${tail}`
}

/**
 * Install the governor's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; the fail-loud checks re-run here.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const runs = new Map<SessionId, RunState>()

  /**
   * Record the trip; in `enforce` mode cancel the child; in both modes report
   * to the live parent. One trip per turn: the flag is cleared at re-arm.
   */
  function trip(run: RunState, session: Session, kind: CeilingKind, reason: string): void {
    run.trippedThisTurn = true
    const acted = resolved.mode === 'enforce' ? 'terminated' : 'flagged (observe mode)'
    if (resolved.mode === 'enforce') {
      run.child.cancel({ kind: 'hook', reason: `budget-governor: ${reason}` })
    }
    ctx.logger.info(`budget-governor: ${acted} child run ${session.id}: ${reason}`)
    const parentId = session.header.parentSession
    const parent = parentId === undefined ? undefined : ctx.agents.get(parentId)
    if (parent === undefined) {
      ctx.logger.warn(
        `budget-governor: child run ${session.id} ${acted} (${reason}) `
        + 'but its parent agent is not live; no report was delivered',
      )
      return
    }
    parent.inject(createUserMessage({
      content: [{ type: 'text', text: ceilingReport(session.id, reason, resolved.mode) }],
      source: { kind: 'plugin', plugin: name, form: 'notice', summary: `subagent ${kind}: ${acted}` },
    }))
  }

  /** Feed one child-session event to the run's detectors; a crossed ceiling trips. */
  function observe(run: RunState, session: Session, event: SessionEvent): void {
    // A new turn re-arms a run the governor already acted on: a continuable
    // child's parent follow-up is governed fresh, not left unwatched (the token
    // ceiling, being cumulative, re-trips at once if the run is still over).
    if (event.type === 'turn/start') {
      /* v8 ignore next -- re-arm fires only for a continuable governed child's
         post-trip turn; no shipped composition creates a continuable child yet
         (fork binds one-shot, see the fork-continuable-prefix-reuse TODO), so
         the true branch is forward-looking. Wire a continuable-child test when
         such a composition ships. */
      if (run.trippedThisTurn) armRun(run, resolved)
      return
    }
    // One report per turn; further events wait for the next re-arm.
    if (run.trippedThisTurn) return
    switch (event.type) {
      case 'tool/call': {
        run.pendingCalls?.set(event.data.callId, event.data.name)
        const churnConfig = resolved.editChurn
        if (run.churn === undefined || churnConfig === undefined) return
        const pathArgument = churnConfig.tools.get(event.data.name)
        if (pathArgument === undefined) return
        const path = extractPath(event.data.arguments, pathArgument)
        if (path !== undefined && run.churn.observe(path)) {
          trip(run, session, 'file edit churn',
            `${run.churn.current} edits to ${path} within the last ${churnConfig.window} `
            + `edit-tool calls (ceiling ${churnConfig.maxSameFileEdits})`)
        }
        return
      }
      case 'tool/result': {
        const block = event.data.message.content[0]
        const toolName = run.pendingCalls?.get(block.toolCallId)
        run.pendingCalls?.delete(block.toolCallId)
        const ceiling = resolved.maxConsecutiveToolFailures
        if (run.failures === undefined || ceiling === undefined) return
        if (run.failures.observe(block.isError === true)) {
          trip(run, session, 'consecutive tool failures',
            `${run.failures.current} consecutive tool failures (ceiling ${ceiling})`
            + (toolName === undefined ? '' : `; last failing tool: ${toolName}`))
        }
        return
      }
      case 'assistant/message': {
        if (resolved.maxChildTokens === undefined) return
        const total = ctx.tokenMeter.measure(session).totalTokens
        if (total > resolved.maxChildTokens) {
          trip(run, session, 'token ceiling',
            `context grew to ~${total} tokens (ceiling ${resolved.maxChildTokens})`)
        }
        return
      }
      // Merge-extensible event log: every other event carries no governed signal.
      default:
        return
    }
  }

  ctx.on('subagent/start', (info: SubagentRunInfo) => {
    // Remote runs expose no local Agent to cancel and no local session events
    // to observe; the README records the v1 limitation.
    if (!info.local) return
    const child = ctx.agents.get(info.id)
    if (child === undefined) {
      // The seam documents local children as resolvable during this
      // notification; a miss is composition drift worth surfacing, not hiding.
      ctx.logger.warn(`budget-governor: local child run ${info.id} has no live agent; the run is not governed`)
      return
    }
    const run: RunState = { child, trippedThisTurn: false, warned: false }
    armRun(run, resolved)
    runs.set(info.id, run)
  })

  ctx.on('subagent/end', (info) => {
    runs.delete(info.id)
  })

  ctx.on('session/event', (session, event) => {
    const run = runs.get(session.id)
    // A tripped run is NOT skipped here: `observe` still sees its `turn/start`
    // to re-arm, so a continuable child stays governed across follow-ups.
    if (run === undefined) return
    try {
      observe(run, session, event)
    } catch (error: unknown) {
      if (run.warned) return
      run.warned = true
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(
        `budget-governor: detector evaluation failed for child ${session.id}: ${message}; `
        + 'continuing without this event',
      )
    }
  })
}
