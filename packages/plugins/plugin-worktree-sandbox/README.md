# @deepseek-ai/dsh-plugin-worktree-sandbox

English | [中文](README.zh.md)

The model-facing `sandbox_exec` tool: run a command inside an isolated git worktree (`.dsh/worktrees/subagent-*`) so a trial subagent run cannot touch the main working tree, then return the trial's structured git diff and the command's exit status, both bounded by the output-retention envelope.

## What it does

Registers one tool on `ctx.tools`:

- `sandbox_exec(id?, command)` creates (or reuses) a detached git worktree at `<worktreeRoot>/subagent-<id>`, runs `sh -c <command>` inside it, and returns a structured result with the command's exit status and the trial's `git diff` vs the base commit. The worktree is removed after the call by default, so the trial's changes are disposable until the caller decides to apply them to the real tree.

The result carries `exitCode`/`signal`, bounded `stdout`/`stderr`, the bounded `diff` and `diffStat`, and the `changedFiles` list from `git status --porcelain`. `cleanup: false` keeps the worktree so a later call with the same `id` continues the same trial (its diff accumulates).

## Isolation model

- The worktree is created with `git worktree add --detach <path> <baseCommit>` from `baseRef` (default `HEAD`), so it shares the repository's object store but has its own working tree and index.
- The command runs with `cwd` set to the worktree; the main working tree and the current branch are never touched.
- `cleanup` (default `true`) removes the worktree with `git worktree remove --force` after capturing the diff, discarding the trial's uncommitted changes.
- Worktrees live under `<cwd>/.dsh/worktrees/` (configurable via `worktreeRoot`), keeping trial state inside the repository rather than the OS temp directory.

## Output retention envelope

Both the command streams and the diff are bounded at `maxOutputBytes` (default 15 KB):

- `stdout`/`stderr` are collected through the subprocess seam's bounded collect (tail retention, `truncated` flag).
- `diff` and `diffStat` run through the `@deepseek-ai/dsh-output-retention` `TextRetainer` (`head` strategy) — the output-retention envelope — so the retained diff keeps its head with exact omission metadata.

## Export shape

A function/namespace plugin: it exports `name` / `inject` / `apply` and NO default. A stray `export default` would collapse the module via the Loader's `unwrapExports` and drop `inject` (see [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`sandbox_exec` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-worktree-sandbox): an optional `id` string and a required `command` string. Plugin config (repository root, worktree root, base ref, envelope size, timeout, cleanup) is validated at load and fails loud on invalid values (e.g. a non-positive `maxOutputBytes`); it changes no schema field, only where and how the trial runs.

#### Token effect

Fixed schema cost on every request where the tool is visible; the call result scales with the bounded command output and diff (each capped at `maxOutputBytes`).

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema; the trial itself happens inside the call and never enters the request prefix.

## Known Limitations and Deferred Work

- **Requires git** — the tool shells out to `git` (configurable via `gitBinary`) and `sh`; a repository-less or non-git `cwd` fails loud on `git rev-parse`.
- **One-shot by default** — `cleanup: true` removes the worktree after each call; a persistent trial needs `cleanup: false` plus a stable `id`.
- **Foreground only** — there is no background/job mode; long trials occupy the tool call until their `timeoutMs` (default 30 s) elapses.
- **Boundary cases of the envelope** — a diff larger than twice `maxOutputBytes` is tail-cut by the subprocess collect before the head envelope sees it, so an extremely large diff may lose its head as well as its tail.
- **Local filesystem only** — the worktree is a local git worktree; there is no remote or shared-clone mode.
