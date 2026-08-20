/**
 * Budget governor: a circuit breaker for runaway delegated child agent runs.
 * It tracks every locally published subagent run announced by
 * `subagent/start`, watches the child session's own events for configured
 * ceilings — cumulative token growth, consecutive tool failures, same-file
 * edit churn — and terminates a tripped run through the child Agent's public
 * cancellation seam (`cancel({ kind: 'hook', … })`). The aborted run settles
 * through the ordinary delegation machinery (an `isError` tool result that
 * preserves partial output), and the governor additionally injects one
 * structured, logged termination report into the parent agent so the parent
 * model learns why the delegation died. The root agent is never governed:
 * only sessions announced by the subagent lifecycle events are tracked.
 * Remote runs (`local: false`) expose no local agent or session events and
 * are not governed. Named exports preserve loader injection metadata.
 * Decision record: the budget-governor Agent Note.
 * @module @deepseek-ai/dsh-plugin-budget-governor
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

export const name = 'plugin-budget-governor'
export const inject = ['subagents', 'agents', 'tokenMeter']

/**
 * Runtime configuration; at least one ceiling must be configured. Declared
 * here (not in `./types.ts`) so it merges with the runtime schema value of
 * the same name declared immediately below — a re-exported type-only binding
 * cannot merge with a same-named value export (TS2395/TS2323).
 */
export interface Config {
  /**
   * Terminate a child run whose session measures above this many tokens
   * (`ctx.tokenMeter.measure` — the model-visible request surface, not
   * provider-billed spend). Integer >= 1.
   */
  maxChildTokens?: number
  /** Terminate a child run after this many consecutive failed tool calls. Integer >= 1. */
  maxConsecutiveToolFailures?: number
  /** Terminate a child run that keeps re-editing one file (see {@link EditChurnConfig}). */
  editChurn?: EditChurnConfig
}

/**
 * Runtime configuration schema. The loader validates it; `apply` re-checks the
 * fail-loud constraints so a direct caller gets the same rejection.
 */
export const Config: z<Config> = z.object({
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
    throw new Error(`plugin-budget-governor: invalid ${field} ${value} — must be an integer >= ${min}`)
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
      'plugin-budget-governor: no ceiling is configured — set at least one of '
      + '`maxChildTokens`, `maxConsecutiveToolFailures`, or `editChurn`, or remove the plugin',
    )
  }
  const resolved: {
    maxChildTokens?: number
    maxConsecutiveToolFailures?: number
    editChurn?: { maxSameFileEdits: number; window: number; tools: ReadonlyMap<string, string> }
  } = {}
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
        `plugin-budget-governor: editChurn.window ${window} is smaller than `
        + `editChurn.maxSameFileEdits ${maxSameFileEdits} — that ceiling could never trip`,
      )
    }
    if (churn.tools.length === 0) {
      throw new Error('plugin-budget-governor: editChurn.tools must name at least one edit tool')
    }
    const tools = new Map<string, string>()
    for (const tool of churn.tools) {
      if (tool.name.length === 0 || tool.pathArgument.length === 0) {
        throw new Error(
          'plugin-budget-governor: every editChurn tool needs a non-empty `name` and `pathArgument`',
        )
      }
      if (tools.has(tool.name)) {
        throw new Error(`plugin-budget-governor: duplicate editChurn tool "${tool.name}"`)
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
  readonly failures?: ConsecutiveFailureCounter
  readonly churn?: EditChurnWindow
  /** In-flight call id → tool name, kept only for failure-report evidence. */
  readonly pendingCalls?: Map<CallId, string>
  /** A tripped run is cancelled once; later events on it are ignored. */
  terminated: boolean
  /** Detector-failure warnings are limited to one per run. */
  warned: boolean
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

/** The model-visible termination report injected into the parent agent. */
function terminationReport(childId: SessionId, reason: string): string {
  return 'A delegated subagent run was terminated by the budget governor.\n'
    + `- child: ${childId}\n`
    + `- ceiling: ${reason}\n`
    + 'The delegation\'s tool result reports the cancellation and preserves any partial '
    + 'output produced before termination. Do not repeat the same delegation unchanged; '
    + 'revise or split the task before delegating again.'
}

/**
 * Install the governor's listeners.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; the fail-loud checks re-run here.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const runs = new Map<SessionId, RunState>()

  /** Cancel the tripped child and report the termination to its live parent. */
  function terminate(run: RunState, session: Session, kind: CeilingKind, reason: string): void {
    run.terminated = true
    run.child.cancel({ kind: 'hook', reason: `budget-governor: ${reason}` })
    ctx.logger.info(`budget-governor: terminated child run ${session.id}: ${reason}`)
    const parentId = session.header.parentSession
    const parent = parentId === undefined ? undefined : ctx.agents.get(parentId)
    if (parent === undefined) {
      ctx.logger.warn(
        `budget-governor: child run ${session.id} was terminated (${reason}) `
        + 'but its parent agent is not live; no termination report was delivered',
      )
      return
    }
    parent.inject(createUserMessage({
      content: [{ type: 'text', text: terminationReport(session.id, reason) }],
      source: { kind: 'plugin', plugin: name, form: 'notice', summary: `subagent terminated: ${kind}` },
    }))
  }

  /** Feed one child-session event to the run's detectors; trips terminate the run. */
  function observe(run: RunState, session: Session, event: SessionEvent): void {
    switch (event.type) {
      case 'tool/call': {
        run.pendingCalls?.set(event.data.callId, event.data.name)
        const churnConfig = resolved.editChurn
        if (run.churn === undefined || churnConfig === undefined) return
        const pathArgument = churnConfig.tools.get(event.data.name)
        if (pathArgument === undefined) return
        const path = extractPath(event.data.arguments, pathArgument)
        if (path !== undefined && run.churn.observe(path)) {
          terminate(run, session, 'file edit churn',
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
          terminate(run, session, 'consecutive tool failures',
            `${run.failures.current} consecutive tool failures (ceiling ${ceiling})`
            + (toolName === undefined ? '' : `; last failing tool: ${toolName}`))
        }
        return
      }
      case 'assistant/message': {
        if (resolved.maxChildTokens === undefined) return
        const total = ctx.tokenMeter.measure(session).totalTokens
        if (total > resolved.maxChildTokens) {
          terminate(run, session, 'token ceiling',
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
    runs.set(info.id, {
      child,
      ...resolved.maxConsecutiveToolFailures === undefined
        ? {}
        : {
          failures: new ConsecutiveFailureCounter(resolved.maxConsecutiveToolFailures),
          pendingCalls: new Map<CallId, string>(),
        },
      ...resolved.editChurn === undefined
        ? {}
        : { churn: new EditChurnWindow(resolved.editChurn.maxSameFileEdits, resolved.editChurn.window) },
      terminated: false,
      warned: false,
    })
  })

  ctx.on('subagent/end', (info) => {
    runs.delete(info.id)
  })

  ctx.on('session/event', (session, event) => {
    const run = runs.get(session.id)
    if (run === undefined || run.terminated) return
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
