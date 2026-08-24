# Econym

The economy of tokens: an agent-resilience + token-optimization plugin suite for the DeepSeek Harness.

Econym is a standalone collection of installable plugins for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Each plugin is a published npm package that any harness version can load through its `cordis.yml` — the plugins peer-depend on the published `@deepseek-ai/dsh-*` packages with broad version ranges, so npm resolves them against whatever harness you have installed.

## Packages

| Package | What it does |
|---|---|
| `@econym/dsh-plugin-ast-context` | `get_file_outline` / `get_directory_outline` tools: tree-sitter structural outlines so the model reads only relevant slices, not whole files |
| `@econym/dsh-plugin-subagent-router` | Label→provider routing for subagent delegations with per-route model-tier overrides |
| `@econym/dsh-plugin-worktree-sandbox` | `sandbox_exec` in an isolated worktree with traversal-guarded ids |
| `@econym/dsh-plugin-diagnostic-sifter` | Collapses cascades of diagnostic output into one actionable root |
| `@econym/dsh-plugin-pinned-scratchpad` | Compaction-resistant per-session working memory rendered into every prompt |
| `@econym/dsh-plugin-arch-guard` | `check_module_boundary`: enforces architectural tier direction, sibling-import and cycle rules |
| `@econym/dsh-plugin-doc-sync-automator` | `sync_bilingual_pair`: re-records English/Chinese documentation pairs |
| `@econym/dsh-plugin-impacted-tests` | `run_impacted_tests`: scopes test runs to files changed by a patch |
| `@econym/dsh-plugin-semantic-patcher` | `patch_symbol_body`: tree-sitter-guided symbol body replacement |
| `@econym/dsh-plugin-telemetry-recorder` | Records model/agent telemetry snapshots for downstream analytics |
| `@econym/dsh-budget-governor` | Circuit breaker for runaway child agent runs: detects runaway token spend and cancels the child |

## Install

Works with any DeepSeek Harness version (published `@deepseek-ai/dsh-*` `next` line; peer ranges span `>=0.1.0-rc.0 <0.2.0`).

```sh
pnpm add @econym/dsh-plugin-pinned-scratchpad
```

Then reference the plugin id in your profile's `cordis.yml`:

```yaml
- id: pinned-scratchpad
  name: '@econym/dsh-plugin-pinned-scratchpad'
```

## Development

```sh
pnpm install
pnpm run build        # tsc emit lib/ for all 11 packages
pnpm run typecheck
pnpm test             # 486 tests, all keyless
pnpm publish:all      # build + publish every package under the next tag
```

## Layout

```
packages/
  plugins/plugin-<name>/   the ten tool plugins (@econym/dsh-plugin-*)
  guard/budget-governor/   the token-budget circuit breaker (@econym/dsh-budget-governor)
```

## License

MIT. Each package ships its own license declaration.