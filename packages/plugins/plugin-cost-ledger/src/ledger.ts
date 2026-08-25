/**
 * Pure cost fold: attribute one session log's `assistant/message` usage
 * records to their provider/model pairs and price them. No I/O, no state —
 * the tool calls this over the full durable log on demand, so a restart
 * re-derives the same ledger from the same events.
 * @module @econym/dsh-plugin-cost-ledger/ledger
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DEEPSEEK_PEAK_HOURS, pricingForTime, resolveModelPricing } from './pricing.ts'
import type { LedgerSnapshot, ModelCostUsage, ModelPricing } from './types.ts'

/** Mutable accumulation cell for one provider/model pair. */
interface UsageCell {
  provider: string
  model: string
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** Accumulated spend in US dollars; `null` once any contributing event is unpriced. */
  costUsd: number | null
}

function emptyCell(provider: string, model: string): UsageCell {
  return {
    provider,
    model,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
  }
}

/**
 * Price one usage record against its rate entry. The event's own timestamp is
 * used to select peak vs off-peak rates, so a session spanning both hours
 * prices each step at the rate that applied when it ran.
 * @param usage - the token counts the adapter reported for one step.
 * @param pricing - the resolved rate entry for the attributing model.
 * @param time - the event's timestamp in epoch milliseconds.
 * @param peakHours - the deployment's peak-hour windows; defaults to DeepSeek's.
 * @returns the estimated spend in US dollars.
 */
function priceUsage(
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  pricing: ModelPricing,
  time: number,
  peakHours: ReadonlyArray<readonly [number, number]>,
): number {
  const eff = pricingForTime(pricing, time, peakHours)
  const cacheRead = eff.cacheRead ?? eff.input
  const cacheWrite = eff.cacheWrite ?? eff.input
  const raw = (usage.inputTokens * eff.input
    + usage.outputTokens * eff.output
    + (usage.cacheReadTokens ?? 0) * cacheRead
    + (usage.cacheWriteTokens ?? 0) * cacheWrite) / 1_000_000
  // Floating-point rates (0.022) leave sub-cent dust; ledgers round to six
  // decimals so exported lines stay stable across recomputation orders.
  return Math.round(raw * 1e6) / 1e6
}

/**
 * Fold one session's events into a per-model cost snapshot. Only committed
 * `assistant/message` accounting is priced — streaming `usage` chunks are
 * replay data and would double-count against the message record that
 * finalizes each step.
 * @param events - the session's durable event log, in seq order.
 * @param overrides - deployment-supplied price entries keyed by model id.
 * @param peakHours - the deployment's peak-hour windows; defaults to DeepSeek's.
 * @returns the aggregated per-model snapshot.
 */
export function foldLedger(
  events: readonly SessionEvent[],
  overrides: Readonly<Record<string, ModelPricing>> | undefined,
  peakHours: ReadonlyArray<readonly [number, number]> = DEEPSEEK_PEAK_HOURS,
): LedgerSnapshot {
  const order: string[] = []
  const cells = new Map<string, UsageCell>()
  const unpriced = new Set<string>()

  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data.usage
    if (usage === undefined) continue
    const source = event.data.message.source
    if (source.kind !== 'model') continue

    const key = `${source.provider}\u0000${source.model}`
    let cell = cells.get(key)
    if (cell === undefined) {
      cell = emptyCell(source.provider, source.model)
      cells.set(key, cell)
      order.push(key)
    }
    cell.requests += 1
    cell.inputTokens += usage.inputTokens
    cell.outputTokens += usage.outputTokens
    cell.cacheReadTokens += usage.cacheReadTokens ?? 0
    cell.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    cell.reasoningTokens += usage.reasoningTokens ?? 0

    const pricing = resolveModelPricing(source.model, overrides)
    if (pricing === undefined) {
      unpriced.add(source.model)
      cell.costUsd = null
    } else if (cell.costUsd !== null) {
      cell.costUsd += priceUsage({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      }, pricing, event.time, peakHours)
    }
  }

  const models: ModelCostUsage[] = []
  const totals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: null as number | null,
  }
  let totalCost = 0
  let allPriced = true

  for (const key of order) {
    const cell = cells.get(key)!
    const estimatedCostUsd = cell.costUsd === null ? null : Math.round(cell.costUsd * 1e6) / 1e6
    if (estimatedCostUsd === null) {
      allPriced = false
    } else {
      totalCost += estimatedCostUsd
    }
    const { costUsd: _costUsd, ...accounting } = cell
    void _costUsd
    models.push({ ...accounting, estimatedCostUsd })
    totals.requests += cell.requests
    totals.inputTokens += cell.inputTokens
    totals.outputTokens += cell.outputTokens
    totals.cacheReadTokens += cell.cacheReadTokens
    totals.cacheWriteTokens += cell.cacheWriteTokens
    totals.reasoningTokens += cell.reasoningTokens
  }

  totals.estimatedCostUsd = allPriced ? Math.round(totalCost * 1e6) / 1e6 : null
  return { models, totals, unpricedModels: [...unpriced] }
}
