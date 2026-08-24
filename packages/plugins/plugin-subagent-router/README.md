# @econym/dsh-plugin-subagent-router

English | [中文](README.zh.md)

The model-facing `subagent` tool: a single delegation entry that routes a delegated task to a subagent provider selected by config-owned policy. The model names only the task (a short description and the full prompt); the router resolves the first registered provider — from the default candidates or the label-matching routes in config order — whose start-time capabilities satisfy the configured request options, and dispatches via `ctx.subagents.start`.

## What it does

Registers one tool on `ctx.tools`:

- `subagent(description, prompt)` delegates a self-contained task to a subagent and waits for its result. The router matches `description` (a short task label) against the configured `routes`; every matching route contributes its ordered `providers` candidates in config order, otherwise the default `providers` list is used. For each candidate in order, the router skips unregistered providers and providers whose `SubagentCapabilities` do not cover the delegation's needs (a configured `persona` requires the `persona` capability, `toolFilter` requires `toolFilter`, a numeric `maxDepth` requires `depthLimit`), dispatching to the first compatible one. When no candidate can serve the delegation, the call fails loud with the candidates tried and the missing capabilities.

The child's final output is returned to the model as the tool result; a non-`completed` stop reason (`aborted`, `error`, `max-tokens`, `refusal`, or an unknown backend reason) is reported as an `isError` result that still preserves the child's partial output.

## Provider selection

Provider selection is **policy, not model transport vocabulary** — the model never names a provider or transport. The policy is entirely config-owned and deterministic:

- `providers` (required) — the ordered default candidates tried when no route matches.
- `routes` — label-routed overrides: each entry has a `label` (matched case-insensitively as a substring of the task `description`), its own ordered `providers` candidates, and an optional per-route `agentOptions` (`provider`, `model`, `maxTokens`) forwarded to the child for delegations the route matches — the first matching route that declares one wins over the global `agentOptions`, so routes can pin task classes to model tiers. Every matching route contributes its candidates in config order; a delegation that matches any route never falls back to the default `providers` — routes are policy, and an unroutable delegation fails loud. A `label` must be non-empty (a blank label would match every delegation and is rejected at load).
- `persona`, `toolFilter`, `maxDepth` — request options forwarded to the provider; setting one makes the matching provider capability required (fail-loud when the resolved provider lacks it).
- `agentOptions` — a per-child model/provider override (`provider`, `model`, `maxTokens`).

Because providers can register after this plugin (sibling load order, HMR replacement), the router resolves against the live `ctx.subagents` registry at every call — it holds no cached provider state and needs no `subagent/provider-added` bookkeeping.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`subagent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-subagent-router): one required `description` string and one required `prompt` string. Plugin config (the routing policy) is validated at load and fails loud on invalid values (empty `providers`, an empty `toolFilter`); it changes no schema field, only which provider serves the call or whether the call returns a directing error result.

#### Token effect

Fixed schema cost on every request where the tool is visible; the call result scales with the delegated child's final output.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema; the delegation itself happens inside the call and never enters the request prefix.

## Known Limitations and Deferred Work

- **Foreground only** — the router waits for the delegated child's result; the `run_in_background` / continuable modes of the dedicated `dsh-tool-subagent` are not exposed here. Use `dsh-tool-subagent` instances for background or continuable delegations.
- **Policy is config, not learned** — routes match a static label substring; there is no model-visible selector beyond `description`.
- **First-capable wins** — candidates are tried in configured order with no load balancing or health signal beyond registration presence.
- **No pre-start interception** — the subagent seam exposes no pre-start waterfall, so the router is a caller/coordinator (its own tool calling `ctx.subagents.start`), not a man-in-the-middle over other tools' delegations; continuation authority remains exact-live-parent.
