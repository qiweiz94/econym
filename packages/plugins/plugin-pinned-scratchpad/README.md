# @econym/dsh-plugin-pinned-scratchpad

English | [中文](README.zh.md)

The model-facing `scratchpad_update` tool: a per-session key/value store the agent maintains explicitly, rendered into a pinned `<agent_scratchpad>` block on every system-prompt assembly so the pinned facts survive context compaction — the prompt is reassembled per request and never compacted, so whatever the section renders is present regardless of what compaction drops from the transcript.

## What it does

Registers one tool on `ctx.tools` and one section on `ctx.systemPrompt`:

- `scratchpad_update(key, value)` upserts or deletes one entry in the calling agent's scratchpad. A string `value` adds a new key or replaces an existing one; `null` deletes an existing key and fails loud if the key is not present. `key` and `value` are trimmed and must be non-empty; `key` must be single-line; neither may contain the literal `<agent_scratchpad>` / `</agent_scratchpad>` frame markers, so a stored value can never close the rendered block early and smuggle text outside the delimiters. The tool requires an owning agent session — a caller with no `agent` (no session to own the store) is rejected rather than silently no-op.
- The `scratchpad:pinned` prompt section renders the calling agent's current entries as `key: value` lines between `<agent_scratchpad>`/`</agent_scratchpad>`, in insertion order, or contributes nothing (`''`) for an empty store or an agent-less assembly.

## Durability model

Each accepted `scratchpad_update` call appends one `scratchpad/write` session event carrying the **complete replacement entry list**, not a delta. The current store is folded by scanning the calling agent's session log for the latest `scratchpad/write` event and reading its `entries` — last-write-wins, no separate live mirror. This is the same whole-store-snapshot pattern `dsh-todo`'s `todo/write` event uses: resume and fork reconstruct the store by replaying the log alone, and a fresh mount over a previously-written log renders the same section content without re-running any tool call.

`scratchpad/write` is model-visible (the section renders it into every request) and is never marked with the session-log envelope's `ignorable` flag, so a reader that does not know the event type must refuse the log rather than silently drop pinned state.

## Byte budget: enforced fail-loud at write time

`Config.totalBudget` (default 1000) bounds the UTF-8 byte length of the complete rendered `<agent_scratchpad>` block, wrapper tags included — not a token count, since the harness has no tokenizer for the serving model. A `scratchpad_update` call whose resulting block would exceed the budget is rejected before it reaches the log: the error names the bytes needed, the configured budget, and the bytes currently used, and no `scratchpad/write` event is appended. Entries already in the store are never silently truncated to fit — the model must shorten a value or delete an entry itself. `totalBudget` must be at least the smallest one-entry block's byte length; a smaller value fails loud at plugin load.

The budget gates the `set` path only. A log written under a larger, later-shrunk budget still replays and renders in full (the package invariant in `./invariant` deliberately does not check the rendered size, since that is current per-deployment config, not a durable-shape rule); a `delete` call against an over-budget seeded store is still accepted, so pruning back under budget stays possible even when no further `set` can succeed until it does.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Pinned scratchpad prompt section

#### What the model sees

The model sees the `scratchpad:pinned` section, wrapping the calling agent's current entries in a stable tag pair, one `key: value` line per entry, in insertion order. It contributes nothing (no tags, no lines) before the first write and for an agent-less assembly.

##### Verbatim text for this field, when needed

```markdown
<agent_scratchpad>
goal: ship the fix
branch: lane/fix
</agent_scratchpad>
```

#### Token effect

Zero for an empty store. A non-empty store costs tokens proportional to its rendered size, hard-capped by `Config.totalBudget` bytes (default 1000) — the complete block, wrapper tags included, can never exceed that budget because the write that would cross it is rejected before it reaches the log.

#### KV Cache effect

The section renders after the harness's stable sections (`order: 1010`, just after the `plan:policy` section), so an accepted `scratchpad_update` call rewrites only the request's tail and leaves the cacheable prefix byte-identical across turns that do not change the store. A call that changes the store invalidates cache reuse from the section boundary onward on the next request that includes it; the tool schema below is unaffected either way.

### Tool schema

#### What the model sees

The model sees the generated `scratchpad_update` schema: a required `key` string and a required `value` field that is a string or `null`. The tool's description states the section renders every request, survives compaction, and is bounded by a byte budget that fails loud on overflow. Plugin config (`totalBudget`) is validated at load and fails loud on a value too small to admit any entry; it changes no schema field, only how many bytes of block the model can accumulate before a `set` call starts failing.

#### Token effect

Fixed schema cost on every request where the tool is visible, independent of whether the prompt section above is currently rendering anything. The call result (`action`, `key`, the complete `entries` array, and `usage`) scales with the current store's size, also bounded by `totalBudget`.

#### KV Cache effect

Prefix-stable while the schema definition and tool visibility are unchanged; a call result is appended conversation history and does not itself touch the system-prompt prefix the section above owns.

## Known Limitations and Deferred Work

- **Per-agent, not per-conversation** — the store keys off the calling agent's own session log. A subagent or child agent spawned from a parent does not inherit the parent's scratchpad and cannot see or write it; each agent that wants pinned working memory needs the plugin mounted on its own context and writes its own independent store.
- **No cross-entry structure** — entries are flat `key: value` strings; there is no nesting, list, or typed value, and no ordering control beyond insertion order (an upsert keeps the original position; a fresh key appends).
- **One budget, one currency** — `totalBudget` bounds the whole rendered block in bytes; there is no per-entry limit, so one large value can consume most of the budget and leave little room for others. The model must manage this itself (shorten values, delete stale entries).
- **No history or undo** — only the latest snapshot is ever rendered or returned; a deleted or overwritten entry's prior value is unrecoverable from the tool's own output (it remains in the durable session log as a superseded `scratchpad/write` event, but nothing in this package reads it back out).
