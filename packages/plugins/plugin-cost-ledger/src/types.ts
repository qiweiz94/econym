/** Per-model price table in US dollars per million tokens. */
export interface ModelPricing {
  /** Price for unprefixed input tokens. */
  input: number
  /** Price for generated output tokens. */
  output: number
  /**
   * Price for prompt tokens served from the provider cache; defaults to
   * {@link ModelPricing.input} when absent — the conservative reading, since a
   * cache hit never costs more than the uncached request.
   */
  cacheRead?: number
  /** Price for prompt tokens written into the provider cache; defaults to {@link ModelPricing.input}. */
  cacheWrite?: number
}

/** Token and cost accounting attributed to one provider/model pair. */
export interface ModelCostUsage {
  /** The provider route that served the requests. */
  provider: string
  /** The model id within that route. */
  model: string
  /** Assistant messages whose usage was folded. */
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /**
   * Estimated spend in US dollars, or `null` when no price table covers this
   * model: tokens are always counted, but an estimate is never invented.
   */
  estimatedCostUsd: number | null
}

/** Aggregated cost-ledger snapshot over one session's log. */
export interface LedgerSnapshot {
  /** Per-model breakdown, ordered by first appearance in the log. */
  models: ModelCostUsage[]
  /** Sum across every priced and unpriced model. */
  totals: {
    requests: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    /** `null` when any contributing model is unpriced — a partial total is never presented as whole. */
    estimatedCostUsd: number | null
  }
  /** Model ids with token counts but no applicable price entry. */
  unpricedModels: string[]
}

/** One JSONL export line: one priced assistant step, addressed by its log position. */
export interface CostLedgerExportLine {
  /** Durable seq of the `assistant/message` event the usage came from. */
  seq: number
  /** Event time in epoch milliseconds. */
  time: number
  turn: number
  step: number
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimatedCostUsd: number | null
}
