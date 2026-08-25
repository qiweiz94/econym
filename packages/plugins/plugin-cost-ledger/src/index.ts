/**
 * The model-facing `get_cost_ledger` tool: per-provider/model token and
 * estimated-USD accounting folded on demand from the calling session's own
 * durable log, with optional JSONL export of every priced assistant step.
 *
 * The ledger is derived, never stored: the tool re-folds the log it is asked
 * about, so a restart recomputes the same numbers without a checkpoint. Named
 * exports preserve loader injection metadata.
 *
 * @module @econym/dsh-plugin-cost-ledger
 */

import { appendFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { foldLedger } from './ledger.ts'
import { DEEPSEEK_PEAK_HOURS, pricingForTime, resolveModelPricing } from './pricing.ts'
import type { CostLedgerExportLine, LedgerSnapshot, ModelPricing } from './types.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'plugin-cost-ledger'
/** The tool registry is the plugin's whole purpose; without it the fiber stays pending. */
export const inject = ['tools']

/** Configuration for the cost ledger. */
export interface Config {
  /**
   * Per-model price overrides in US dollars per million tokens, layered over
   * the built-in catalog rates. A model covered by neither is reported with
   * its token counts and a `null` cost rather than an invented estimate.
   */
  pricing?: Record<string, ModelPricing>
  /**
   * Append one JSONL line per priced assistant step to this file, addressed
   * by durable seq; repeated calls write only the steps past the last
   * exported position. Parent-only: child-run rollup arrives separately.
   */
  exportPath?: string
  /**
   * UTC hour windows during which peak rates apply, as `[startHour, endHour)`
   * pairs. Defaults to DeepSeek's published peak windows (01:00-04:00 and
   * 06:00-10:00 UTC). A model with a `peak` block in its rate entry bills those
   * rates inside the windows and its base (off-peak) rates outside; models
   * without a `peak` block bill base rates at all hours.
   */
  peakHours?: Array<[number, number]>
  /** Model-facing tool name; defaults to `get_cost_ledger`. */
  toolName?: string
}

const RATES_SCHEMA = z.object({
  input: z.number().min(0).required(),
  output: z.number().min(0).required(),
  cacheRead: z.number().min(0).default(undefined as unknown as number),
  cacheWrite: z.number().min(0).default(undefined as unknown as number),
})

/** One pricing entry, matching {@link ModelPricing}; `peak` and the cache fields stay optional. */
const PRICING_ENTRY_SCHEMA = z.object({
  input: z.number().min(0).required(),
  output: z.number().min(0).required(),
  cacheRead: z.number().min(0).default(undefined as unknown as number),
  cacheWrite: z.number().min(0).default(undefined as unknown as number),
  // Preserve omission; Schemastery's `.set()` would force a required peak.
  peak: RATES_SCHEMA.default(undefined as unknown as {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }),
})

/** Runtime configuration schema for the cost-ledger plugin. */
export const Config = z.object({
  pricing: z.dict(PRICING_ENTRY_SCHEMA),
  exportPath: z.string(),
  peakHours: z.array(z.tuple([z.number().min(0).max(24), z.number().min(0).max(24)] as const)),
  toolName: z.string().default('get_cost_ledger'),
}) as unknown as z<Config>

const SNAPSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    models: {
      type: 'array',
      required: true,
      description: 'Per-provider/model breakdown in first-appearance order.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          requests: { type: 'integer', required: true, description: 'Assistant steps whose usage was folded.' },
          inputTokens: { type: 'integer', required: true },
          outputTokens: { type: 'integer', required: true },
          cacheReadTokens: { type: 'integer', required: true },
          cacheWriteTokens: { type: 'integer', required: true },
          reasoningTokens: { type: 'integer', required: true },
          estimatedCostUsd: {
            required: true,
            oneOf: [{ type: 'number' }, { type: 'null' }],
            description: 'Estimated spend in USD; null when no price entry covers this model.',
          },
        },
      },
    },
    totals: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        requests: { type: 'integer', required: true },
        inputTokens: { type: 'integer', required: true },
        outputTokens: { type: 'integer', required: true },
        cacheReadTokens: { type: 'integer', required: true },
        cacheWriteTokens: { type: 'integer', required: true },
        reasoningTokens: { type: 'integer', required: true },
        estimatedCostUsd: {
          required: true,
          oneOf: [{ type: 'number' }, { type: 'null' }],
          description: 'Sum over priced models; null when any contributing model is unpriced.',
        },
      },
    },
    unpricedModels: {
      type: 'array',
      required: true,
      items: { type: 'string' },
      description: 'Models whose tokens were counted but which no price entry covers.',
    },
    exportedLines: {
      type: 'integer',
      description: 'JSONL lines appended this call; absent when no exportPath is configured.',
    },
  },
} as const satisfies ValueSchemaSpec

/**
 * Render the snapshot as model-facing prose: totals first, then one line per
 * model, then the unpriced caveat when any model lacks rates.
 * @param snapshot - the aggregated snapshot value.
 * @returns the text block describing the session's cost ledger.
 */
function formatLedger(snapshot: LedgerSnapshot): string {
  const lines: string[] = []
  const t = snapshot.totals
  lines.push(
    `cost ledger: ${t.requests} assistant steps, ${t.inputTokens} in / ${t.outputTokens} out`
    + ` (cache read ${t.cacheReadTokens}, cache write ${t.cacheWriteTokens})`,
  )
  if (t.estimatedCostUsd !== null) {
    lines.push(`estimated total: $${t.estimatedCostUsd.toFixed(6)}`)
  } else {
    lines.push('estimated total: unavailable — unpriced models contributed tokens')
  }
  for (const model of snapshot.models) {
    const cost = model.estimatedCostUsd === null
      ? 'unpriced'
      : `$${model.estimatedCostUsd.toFixed(6)}`
    lines.push(
      `${model.provider}/${model.model}: ${model.requests} reqs, ${model.inputTokens} in / ${model.outputTokens} out`
      + ` (cache r/w ${model.cacheReadTokens}/${model.cacheWriteTokens}) — ${cost}`,
    )
  }
  if (snapshot.unpricedModels.length > 0) {
    lines.push(`unpriced models (tokens counted, no rate configured): ${snapshot.unpricedModels.join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * Collect the usage-bearing assistant/message events past a watermark.
 * @param session - the calling session's durable log.
 * @param watermark - the last exported seq for this export path; `-1` exports from the first event.
 * @returns the events to price and export, in seq order.
 */
function usageEventsPast(session: Session, watermark: number): Array<SessionEvent<'assistant/message'>> {
  return session.events.filter((event): event is SessionEvent<'assistant/message'> =>
    event.type === 'assistant/message'
    && event.data.usage !== undefined
    && event.seq > watermark)
}

/**
 * Mount the ledger and register the `get_cost_ledger` tool.
 * @param ctx - Cordis context carrying the tool registry.
 * @param config - price overrides and the optional JSONL export path.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // One watermark per export path, process-lifetime: a restarted harness
  // re-derives the same fold, so only the in-memory cursor resets.
  const watermarks = new Map<SessionId & string, number>()

  ctx.tools.register(defineTool({
    name: config.toolName ?? 'get_cost_ledger',
    description: 'Report this conversation\'s token and estimated-dollar accounting: per provider/model request counts, '
      + 'input/output/cache-token breakdowns, and estimated spend at configurable rates. Optionally appends one JSONL '
      + 'line per assistant step to the deployment\'s export path for FinOps pipelines. Rates cover the built-in '
      + 'catalog plus deployment overrides; a model with no rate reports its tokens with a null cost instead of an '
      + 'invented estimate. Use it to see where this conversation\'s spend actually went.',
    parameters: {},
    output: {
      schema: SNAPSHOT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatLedger(value as unknown as LedgerSnapshot) }],
    },
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('get_cost_ledger needs the calling agent; this call arrived without one')
      }
      const session: Session = agent.session
      const peakHours = config.peakHours ?? DEEPSEEK_PEAK_HOURS
      const snapshot = foldLedger(session.events, config.pricing, peakHours)

      let exportedLines: number | undefined
      if (config.exportPath !== undefined) {
        const watermark = watermarks.get(session.id) ?? -1
        const events = usageEventsPast(session, watermark)
        const lines = events.map((event) => {
          /* v8 ignore next -- the collecting predicate guarantees usage on every returned event. */
          const usage = event.data.usage!
          const source = event.data.message.source as { kind: 'model'; provider: string; model: string }
          const pricing = resolveModelPricing(source.model, config.pricing)
          const eff = pricing === undefined ? undefined : pricingForTime(pricing, event.time, peakHours)
          const cost = eff === undefined
            ? null
            : Math.round(((usage.inputTokens * eff.input
              + usage.outputTokens * eff.output
              + (usage.cacheReadTokens ?? 0) * (eff.cacheRead ?? eff.input)
              + (usage.cacheWriteTokens ?? 0) * (eff.cacheWrite ?? eff.input)) / 1_000_000) * 1e6) / 1e6
          const line: CostLedgerExportLine = {
            seq: event.seq,
            time: event.time,
            turn: event.data.turn,
            step: event.data.step,
            provider: source.provider,
            model: source.model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens ?? 0,
            cacheWriteTokens: usage.cacheWriteTokens ?? 0,
            reasoningTokens: usage.reasoningTokens ?? 0,
            estimatedCostUsd: cost,
          }
          return `${JSON.stringify(line)}\n`
        })
        if (lines.length > 0) {
          await appendFile(config.exportPath, lines.join(''), { mode: 0o600 })
          watermarks.set(session.id, events[events.length - 1]!.seq)
        }
        exportedLines = lines.length
      }

      // The wire shape flattens the snapshot beside the export count so the
      // declared schema stays one level deep.
      const result: LedgerSnapshot & { exportedLines?: number } = exportedLines === undefined
        ? { ...snapshot }
        : { ...snapshot, exportedLines }
      return result
    },
  }))
}
