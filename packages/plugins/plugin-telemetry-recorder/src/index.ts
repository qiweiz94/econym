/**
 * The model-facing `get_session_telemetry` tool: a compact reading of the
 * calling session's own operating figures — token velocity over a rolling
 * window of closed turns, prompt-cache hit ratio, context headroom, turn
 * latency, and subagent delegation counts — folded from the durable session
 * log and the subagent lifecycle pair. Named exports preserve loader injection
 * metadata.
 *
 * @module @econym/dsh-plugin-telemetry-recorder
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { TelemetryRecorder } from './recorder.ts'
import type { TelemetrySnapshot } from './types.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'plugin-telemetry-recorder'
/** The tool registry is the plugin's whole purpose; without it the fiber stays pending. */
export const inject = ['tools']

/** The rolling window a deployment gets when its cordis.yml names none. */
const DEFAULT_WINDOW_TURNS = 10

/** Configuration for the telemetry recorder. */
export interface Config {
  /** Closed turns retained by the rolling window (default 10). */
  windowTurns?: number
}

/** Runtime configuration schema for the telemetry recorder plugin. */
export const Config: z<Config> = z.object({
  windowTurns: z.number().step(1).min(1).default(DEFAULT_WINDOW_TURNS),
})

const SNAPSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    windowTurns: { type: 'integer', required: true, description: 'Closed turns the rolling window retains.' },
    closedTurns: { type: 'integer', required: true, description: 'Closed turns currently inside the window.' },
    openTurn: { type: 'integer', description: 'The in-flight turn number; absent between turns.' },
    tokenVelocity: {
      type: 'object',
      additionalProperties: false,
      description: 'Token throughput over the window; absent until a turn closes.',
      properties: {
        turns: { type: 'integer', required: true, description: 'Closed turns averaged over.' },
        totalTokens: { type: 'integer', required: true, description: 'Input, cache-read, cache-write, and output tokens summed.' },
        tokensPerTurn: { type: 'number', required: true, description: 'Mean tokens per closed turn.' },
      },
    },
    promptCache: {
      type: 'object',
      additionalProperties: false,
      description: 'Prompt-cache effectiveness over the window; absent until a request reported usage.',
      properties: {
        hitRatio: { type: 'number', required: true, description: 'Cache-read tokens over all prompt tokens, 0 to 1.' },
        promptTokens: { type: 'integer', required: true, description: 'Uncached input plus cache reads and writes.' },
        cacheReadTokens: { type: 'integer', required: true, description: 'Prompt tokens served from the cache.' },
      },
    },
    contextHeadroom: {
      type: 'object',
      additionalProperties: false,
      description: 'Newest prompt size against the newest advertised capacity; absent when either is unknown.',
      properties: {
        contextWindow: { type: 'integer', required: true, description: 'Advertised route capacity in tokens.' },
        promptTokens: { type: 'integer', required: true, description: 'Newest reported prompt size in tokens.' },
        headroomTokens: { type: 'integer', required: true, description: 'Capacity left for the next prompt.' },
        usedRatio: { type: 'number', required: true, description: 'Prompt tokens over capacity, 0 to 1.' },
      },
    },
    turnLatency: {
      type: 'object',
      additionalProperties: false,
      description: 'Turn wall-clock spans over the window; absent until a turn closes.',
      properties: {
        samples: { type: 'integer', required: true, description: 'Closed turns measured.' },
        meanMs: { type: 'integer', required: true, description: 'Mean turn span in milliseconds.' },
        medianMs: { type: 'integer', required: true, description: 'Median turn span in milliseconds.' },
        maxMs: { type: 'integer', required: true, description: 'Longest turn span in milliseconds.' },
      },
    },
    subagents: {
      type: 'object',
      required: true,
      additionalProperties: false,
      description: 'Delegation counts attributed to this session.',
      properties: {
        started: { type: 'integer', required: true, description: 'Runs started across every provider.' },
        ended: { type: 'integer', required: true, description: 'Runs settled across every provider.' },
        active: { type: 'integer', required: true, description: 'Runs still in flight.' },
        byProvider: {
          type: 'array',
          required: true,
          description: 'Per-provider breakdown.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string', required: true, description: 'The subagent provider name.' },
              started: { type: 'integer', required: true, description: 'Runs this provider started.' },
              ended: { type: 'integer', required: true, description: 'Runs this provider settled.' },
              active: { type: 'integer', required: true, description: 'Runs of this provider still in flight.' },
            },
          },
        },
      },
    },
    unattributedSubagentRuns: {
      type: 'integer',
      required: true,
      description: 'Runs seen process-wide whose delegating session could not be identified.',
    },
  },
} as const satisfies ValueSchemaSpec

/** One `key: value` line, or nothing when the figure was not measured. */
function line(label: string, value: string | undefined): string[] {
  return value === undefined ? [] : [`${label}: ${value}`]
}

/**
 * Render the snapshot as model-facing prose: one line per measured figure,
 * with unmeasured figures omitted rather than shown as zero.
 * @param snapshot - the validated snapshot value.
 * @returns the text block describing the session's telemetry.
 */
function formatSnapshot(snapshot: TelemetrySnapshot): string {
  const { tokenVelocity, promptCache, contextHeadroom, turnLatency, subagents } = snapshot
  const providers = subagents.byProvider
    .map(entry => `${entry.provider} ${entry.started}/${entry.ended}/${entry.active}`)
    .join(', ')
  return [
    `session telemetry over the last ${snapshot.closedTurns} of ${snapshot.windowTurns} closed turns`,
    ...line('open turn', snapshot.openTurn === undefined ? undefined : String(snapshot.openTurn)),
    ...line(
      'token velocity',
      tokenVelocity === undefined ? undefined : `${tokenVelocity.tokensPerTurn} tokens/turn (${tokenVelocity.totalTokens} over ${tokenVelocity.turns})`,
    ),
    ...line(
      'prompt cache',
      promptCache === undefined ? undefined : `${round1(promptCache.hitRatio * 100)}% hit (${promptCache.cacheReadTokens} of ${promptCache.promptTokens} prompt tokens)`,
    ),
    ...line(
      'context headroom',
      contextHeadroom === undefined ? undefined : `${contextHeadroom.headroomTokens} tokens left of ${contextHeadroom.contextWindow} (${round1(contextHeadroom.usedRatio * 100)}% used)`,
    ),
    ...line(
      'turn latency',
      turnLatency === undefined ? undefined : `mean ${turnLatency.meanMs} ms, median ${turnLatency.medianMs} ms, max ${turnLatency.maxMs} ms`,
    ),
    `subagents started/ended/active: ${subagents.started}/${subagents.ended}/${subagents.active}${providers === '' ? '' : ` — ${providers}`}`,
    ...line(
      'unattributed subagent runs',
      snapshot.unattributedSubagentRuns === 0 ? undefined : String(snapshot.unattributedSubagentRuns),
    ),
  ].join('\n')
}

/** One decimal place, for the percentages the rendered text quotes. */
const round1 = (value: number): number => Math.round(value * 10) / 10

/**
 * Mount the recorder and register the `get_session_telemetry` tool.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - rolling-window size, validated at load.
 */
export function apply(ctx: Context, config: Config = {}): void {
  /* v8 ignore next -- the Config schema's own default fills this before apply runs; the fallback keeps the direct-call signature total */
  const recorder = new TelemetryRecorder(ctx, config.windowTurns ?? DEFAULT_WINDOW_TURNS)

  ctx.on('session/event', (session) => { recorder.observe(session) })
  ctx.on('session/disposed', (session) => { recorder.forget(session.id) })
  ctx.on('subagent/start', (info) => { recorder.startRun(info.runId, info.provider, info.id) })
  ctx.on('subagent/end', (info) => { recorder.endRun(info.runId) })

  ctx.tools.register(defineTool({
    name: 'get_session_telemetry',
    description: 'Report this conversation\'s own operating figures: mean tokens per turn and turn wall-clock '
      + 'latency over the most recent closed turns, the prompt-cache hit ratio, how much of the model\'s context '
      + 'window the latest request occupied, and how many subagent delegations this conversation started, '
      + 'settled, and still has running. Use it to decide whether to compact, shorten the context, or stop '
      + 'delegating. A figure the conversation has not produced evidence for is omitted rather than reported '
      + 'as zero.',
    parameters: {},
    output: {
      schema: SNAPSHOT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
      presentationMeta: (_args, value) => ({ telemetry: value }),
    },
    execute(_args, exec): Promise<TelemetrySnapshot> {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('get_session_telemetry needs the calling agent; this call arrived without one')
      }
      // The fold is synchronous; the registry's execute contract is async.
      return Promise.resolve(recorder.snapshot(agent.session))
    },
  }))
}
