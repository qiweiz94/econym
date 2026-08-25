# @econym/bench-ast-token

A **private, not-published** benchmark that measures the token economy of the AST-guided read path (`@econym/dsh-plugin-ast-context`) against the naive alternative (reading a whole file). It turns the product's "85-95% input-token reduction" claim into a reproducible number you can re-run after any change.

## What it measures

For each fixture TypeScript file, two ways a model can understand it:

- **Naive** — the whole file text enters context.
- **Guided** — `get_file_outline` (a compact symbol index) plus one targeted read of the widest function's line span — the exact shape `get_file_outline` enables.

Tokens are an **estimate** using a `chars / 4` proxy (≈4 characters per token) applied to the exact text each tool renders. This is a deterministic local yardstick, not a provider-billed figure; the real number depends on the tokenizer and conversation prefix, which a harness benchmark cannot reproduce without live API calls.

## Run it

```bash
pnpm --filter @econym/bench-ast-token bench
```

The benchmark also ships a vitest spec asserting the measured reduction stays above the documented claim (≥85% on the large fixture), so a regression that erodes the token economy fails CI.

## Current measured result (chars/4 proxy)

| Fixture | Lines | Naive | Guided | Saved |
|---|---|---|---|---|
| `large-service.ts` | 1185 | 14,239 | 1,099 | **92.3%** |
| `auth-service.ts` | 167 | 1,254 | 333 | 73.4% |
| `geometry.ts` | 15 | 84 | 54 | 35.7% |
| **Overall** | | **15,577** | **1,486** | **90.5%** |

Savings grow with file size: the outline is a fixed cost and the focused read is narrow, so the guided path dominates exactly where the naive read hurts most. Re-run `pnpm bench` to refresh these numbers after fixture or extractor changes.
