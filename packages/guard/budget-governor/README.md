# @deepseek-ai/dsh-budget-governor

English | [中文](README.zh.md)

A circuit breaker for runaway delegated child agent runs, not a model-facing tool: it never appears in the tool list and never touches the root agent. It tracks exactly the sessions announced by the subagent lifecycle events (`subagent/start` / `subagent/end`), watches each tracked child session's own events for configured ceilings, and terminates a run that trips one through the child `Agent`'s public cancellation seam. Decision record: [the budget-governor Agent Note](../../../.agents/notes/implemented/feature/2026-08-20-budget-governor-child-run-circuit-breaker.md).

## What it does

For every **local** child run announced by `subagent/start` (`info.local === true`, resolvable via `ctx.agents.get(info.id)`), the governor creates per-run detector state and feeds it the child session's own `session/event` stream:

- **`maxChildTokens`** — at each child `assistant/message`, `ctx.tokenMeter.measure(childSession).totalTokens` is compared against the ceiling. This is the model-visible request surface the harness itself prices context with, not provider-billed cumulative spend.
- **`maxConsecutiveToolFailures`** — a child `tool/result` whose model-facing block has `isError: true` increments a per-run counter; any non-error result resets it to zero, so a run that recovers is never terminated for its history.
- **`editChurn`** — `{ maxSameFileEdits, window, tools: [{ name, pathArgument }] }`. Each child `tool/call` naming a configured edit tool contributes its extracted path argument to a bounded sliding window of the run's most recent `window` edit calls; the ceiling trips when one path accounts for `maxSameFileEdits` entries within that window. Edits that fall out of the window stop counting.

All three ceilings are optional, but at least one must be configured — a governor with no ceiling at all is misconfiguration and fails loud at plugin load.

**`mode`** — `enforce` (default) cancels a tripped child run through its `Agent`'s cancellation seam; `observe` leaves the run to continue and only reports the crossed ceiling. Use `observe` to measure how often ceilings would trip before letting the governor intervene. A run reports at most once per turn and is re-armed on its next turn, so a continuable child stays governed across its parent's follow-ups (no shipped composition creates a continuable governed child yet; the re-arm is forward-looking).

## Config

```yaml
- name: '@deepseek-ai/dsh-budget-governor'
  config:
    maxChildTokens: 200000
    maxConsecutiveToolFailures: 5
    editChurn:
      maxSameFileEdits: 4
      window: 10
      tools:
        - { name: edit, pathArgument: file_path }
```

Every configured field is validated at load: ceilings must be integers within range (`maxChildTokens >= 1`, `maxConsecutiveToolFailures >= 1`, `editChurn.maxSameFileEdits >= 2`, `editChurn.window >= 2`), `editChurn.window` must be at least `editChurn.maxSameFileEdits` (a smaller window could never trip), and `editChurn.tools` must be non-empty with non-empty, duplicate-free `name`/`pathArgument` pairs. The edit-tool names and path-argument keys are deployment vocabulary, not a hardcoded constant — this repo's `dsh-tool-fs` uses `edit`/`file_path`, an MCP or ACP tool set may name them differently.

## Enforcement

Enforcement propagates through existing machinery only; no new cancellation seam was added. A trip calls `child.cancel({ kind: 'hook', reason: 'budget-governor: …' })` on the child `Agent` resolved at `subagent/start`. That aborts the child's active turn, which closes with `turn/end { kind: 'aborted', reason: { kind: 'hook', … } }`; the in-process driver maps it to `stopReason: 'aborted'`, and the delegation Consumer's settlement converts that into an `isError` tool result that preserves the child's partial output. The governor never touches the run handle — `dispose()` ownership stays with the delegation's holder.

Termination is once per run: the tripped run is marked and later events on it are ignored. Detector evaluation failures are caught, logged as a warning at most once per run, and never break session dispatch (the `dsh-compaction-basic` listener discipline).

## Parent report

On termination the governor injects one structured notice into the parent agent (`parent.inject(...)`, source `{ kind: 'plugin', plugin: 'budget-governor', form: 'notice' }`), resolved from the child session's durable lineage (`child.session.header.parentSession` → `ctx.agents.get(...)`). This lands as an ordinary `user/message` session event in the parent log — model-visible and reconstructable from the log with no new session event type — and the driver claims it at the parent's next pre-step, immediately after the aborted delegation's own `isError` tool result. When the parent agent is not live, the report is dropped and logged as a warning instead of thrown.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `Config` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Termination report

#### What the model sees

The parent model receives the notice below, immediately after the delegation's own `isError` tool result, whenever the governor terminates one of its child runs.

##### Termination report

```markdown
A delegated subagent run was terminated by the budget governor.
- child: <childId>
- ceiling: <reason>
The delegation's tool result reports the cancellation and preserves any partial output produced before termination. Do not repeat the same delegation unchanged; revise or split the task before delegating again.
```

#### Token effect

Zero tokens on any run that never trips a ceiling. One fixed-shape notice per terminated child run, in addition to the delegation's own `isError` result text.

#### KV Cache effect

Append-only; the notice follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Remote runs are not governed.** A `subagent/start` with `local: false` (e.g. the ACP provider) exposes no local `Agent` to cancel and appends no local session events to observe; the governor silently skips those runs. Extending governance across the ACP boundary would need a remote-cancellation capability on the provider seam.
- **The token ceiling bounds context surface, not billed spend.** A child that burns tokens on repeated short requests trips the failure or churn ceilings instead.
- **No keyless snapshot example ships in this package.** The termination report text is pinned verbatim by unit and Loader-composition tests; wiring a governed-delegation example into the snapshot harness is deferred.
- **The root agent is never governed**, by design: only sessions announced by the subagent lifecycle events are tracked, and a root session is never announced there.
