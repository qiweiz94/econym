# @econym/dsh-plugin-cost-ledger

English | [中文](README.zh.md)

The model-facing `get_cost_ledger` tool: per-provider/model token and estimated-USD accounting for the calling session, folded on demand from its durable log, with optional JSONL export for FinOps pipelines.

## What it does

The ledger attributes every committed `assistant/message` usage record to the provider/model pair that produced it (`message.source`), counts the token breakdown (input, output, cache read, cache write, reasoning), and prices it against a rate table. The fold is **derived, never stored**: the tool re-reads the session log every call, so a harness restart recomputes the same numbers with no checkpoint.

## Config

```yaml
- name: '@econym/dsh-plugin-cost-ledger'
  config:
    pricing:
      ox-alpha-free:
        input: 0.2
        output: 1.2
        cacheRead: 0.05
        cacheWrite: 0.1
    exportPath: /var/log/dsh/cost-ledger.jsonl
```

- `pricing` — per-model rates in **US dollars per million tokens**, layered over the built-in catalog table (the DeepSeek-harness `opencode-go` catalog's published rates). A model covered by neither is counted but reported with a `null` cost — an estimate is never invented.
- `exportPath` — when set, every priced assistant step past the last exported position is appended as one JSONL line, addressed by durable `seq`. Lines are written with owner-only permissions.

## Output

`get_cost_ledger()` returns per-model request counts, token breakdowns, and estimated spend, plus a whole-session total. The total is `null` when any contributing model is unpriced — a partial total is never presented as whole. The rendered text omits nothing but unmeasured figures.

## Known Limitations and Deferred Work

- **Parent-only accounting** — the ledger folds the calling session's own log. Child-run rollup (attributing a subagent's spend to its delegating parent) is a separate, deferred step that reuses the `subagent/start` pattern from `dsh-budget-governor`.
- **Estimates, not invoices** — cost is tokens × published rates. Provider-specific discounts, promotions, or negotiated tiers are not reflected; treat the figure as an upper-bound estimate.
- **Pricing is per model, not per provider** — a model id shared across routes prices identically; provide a config override if two routes differ.
- **No cache of the fold** — every call re-scans the session log; for very large sessions this is O(log length) per call. A projection-based checkpoint is deferred.
- **JSONL export is in-memory-watermarked** — the last-exported seq resets on harness restart, so a restarted process re-exports the whole log once. Idempotent by design (lines are addressed by seq), but a durable watermark is deferred.