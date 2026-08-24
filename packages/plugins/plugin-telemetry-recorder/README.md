# @econym/dsh-plugin-telemetry-recorder

English | [中文](README.zh.md)

The model-facing `get_session_telemetry` tool: a compact reading of the calling conversation's own operating figures — token velocity and turn latency over a rolling window of closed turns, prompt-cache hit ratio, context headroom, and subagent delegation counts — folded from the durable session log and the subagent lifecycle events.

## What it does

Registers one tool on `ctx.tools`:

- `get_session_telemetry()` takes no arguments and returns the calling session's current snapshot. It reads only; it appends no session event of its own beyond the `tool/call` and `tool/result` the registry writes.

Every figure the log has produced no evidence for is **absent** from the result rather than reported as zero, so the model can tell "not measured yet" from "measured zero".

| Figure | Source | Absent when |
| --- | --- | --- |
| `tokenVelocity` | `assistant/message.usage` and `assistant/chunk` usage chunks, summed per turn | no turn has closed yet |
| `promptCache` | the same usage reports, prompt side only (input + cache read + cache write) | no closed turn reported prompt tokens |
| `contextHeadroom` | newest `request/context.contextWindow` against the newest reported prompt | no route advertised a capacity, or nothing reported usage |
| `turnLatency` | `turn/start` → `turn/end` wall-clock spans | no turn has closed yet |
| `subagents` | `subagent/start` / `subagent/end`, attributed through the child's `parentSession` | never absent; counts start at zero |

## The fold

The recorder is a plain owned object, not a cordis service: its only consumer is this package's own tool, and a Context service key with no external Consumer would ship a one-role capability seam.

It copies `dsh-token-meter`'s state mechanics — a `WeakMap` keyed by `Session` plus a catch-up replay from a consumed-event cursor. A session that was resumed, forked, or already running when the plugin mounted therefore reports its real history instead of zeros: the first call replays the whole durable log, and the fiber's `session/event` listener keeps already-observed sessions current. Sessions nobody has asked about accumulate no state.

Usage is attributed to the turn that was open when it was reported. A step that reports usage twice — a streaming `usage` chunk and then its assembled `assistant/message` — replaces its earlier value rather than doubling it. Usage arriving with no matching open turn is not attributed to any turn, but still updates the newest-prompt record that `contextHeadroom` reads.

`windowTurns` (default 10) is the only configuration: the rolling window's size in closed turns. The oldest closed turn is evicted once the window is full, so both the velocity average and the latency statistics describe recent behavior rather than the whole conversation.

## Context headroom is two independent records

`contextWindow` and the prompt size are separate last-wins records, not one atomic observation. A route switch can pair a fresh capacity with the previous route's prompt until the next request reports usage, and because nothing but a request reports usage, the prompt figure also cannot see a compaction: immediately after one it reads stale-high until the next request lands. The figure is a user- and model-facing reference, not a gating or billing input. `dsh-token-meter`'s `contextPressure` projection makes the same concession about the same pair.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `Config` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`get_session_telemetry` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-telemetry-recorder): no parameters at all, and an output object whose members are documented as optional exactly where the fold can leave them absent. Plugin config (`windowTurns`) is validated at load and fails loud on a non-positive value; it changes no schema field, only how many closed turns the reported averages cover.

#### Token effect

Fixed schema cost on every request where the tool is visible. The result is bounded by construction: a fixed set of scalar figures plus one row per subagent provider the session has used, so it cannot grow with conversation length.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema. The measurement itself happens inside the call and never enters the request prefix — reading telemetry does not perturb the cache ratio it reports.

## Known Limitations and Deferred Work

- **WebSocket streaming to the Web UI is deferred** — a plugin must not open its own `ws` server. The Web UI's carrier is `dsh-client-connection`'s `WebSocketDownlinks` over the `dsh-host-apiproxy` frame model, and the seam a package uses to reach it is a `ctx.sessionProjections` unit whose delivery the projection registry owns (`dsh-session-stats` is the template). The log-derived figures here — velocity, cache ratio, headroom, latency — are a plain-JSON fold and could move to such a unit and stream for free. The subagent counts could not: they come from the ctx-level `subagent/start` / `subagent/end` observe pair, not from the session log, so a projection unit cannot see them. Splitting the two is the prerequisite for streaming, not an implementation detail of it.
- **Remote children are unattributable** — the lifecycle payload carries the child's id, not the parent's, so the delegating session is recovered from the live child agent's session header. A child with no live local agent (a remote provider, or one already disposed) is counted in `unattributedSubagentRuns` instead, which is reported process-wide rather than per session.
- **Runs that began before the plugin mounted never settle** — the recorder folds the subagent lifecycle live, not from a log, so a terminal event whose start it never saw is ignored. Session-log figures have no such gap: they replay.
- **Delegation counters survive their session only until it disposes** — they are dropped on `session/disposed`, so a session that is never announced through the session store keeps its counters for the fiber's lifetime.
- **`medianMs` is the lower median** — an even-sized window reports the lower of the two middle spans rather than interpolating, so the reported figure is always an observed turn's real duration.
