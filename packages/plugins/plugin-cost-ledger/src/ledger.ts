/**
 * Pure cost fold: attribute one session log's `assistant/message` usage
 * records to their provider/model pairs and price them. No I/O, no state —
 * the tool calls this over the full durable log on demand, so a restart
 * re-derives the same ledger from the same events.
 * @module @econym/dsh-plugin-cost-ledger/ledger
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveModelPricing } from './pricing.ts'
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
  }
}

/**
 * Price one usage record against its rate entry.
 * @param usage - the token counts the adapter reported for one step.
 * @param pricing - the resolved rate table for the attributing model.
 * @returns the estimated spend in US dollars.
 */
function priceUsage(
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
  pricing: ModelPricing,
): number {
  const cacheRead = pricing.cacheRead ?? pricing.input
  const cacheWrite = pricing.cacheWrite ?? pricing.input
  const raw = (usage.inputTokens * pricing.input
    + usage.outputTokens * pricing.output
    + usage.cacheReadTokens * cacheRead
    + usage.cacheWriteTokens * cacheWrite) / 1_000_000
  // Floating-point rates (0.003625) leave sub-cent dust; ledgers round to six
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
 * @returns the aggregated per-model snapshot.
 */
export function foldLedger(
  events: readonly SessionEvent[],
  overrides: Readonly<Record<string, ModelPricing>> | undefined,
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
    const pricing = resolveModelPricing(cell.model, overrides)
    const estimatedCostUsd = pricing === undefined ? null : priceUsage(cell, pricing)
    if (pricing === undefined) {
      unpriced.add(cell.model)
      allPriced = false
    } else {
      totalCost += estimatedCostUsd ?? 0
    }
    models.push({ ...cell, estimatedCostUsd })
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
