# plugins/ — self-contained model-facing tool plugins

English | [中文](README.zh.md)

Packages that ship one self-contained model-facing tool on `ctx.tools` without a replaceable provider contract or capability seam of their own.

| Package | Role | ctx key |
|---|---|---|
| [`plugin-ast-context/`](plugin-ast-context/README.md) | `get_file_outline` / `get_directory_outline`: tree-sitter symbol outlines of local TypeScript files and directories. | (registers on `ctx.tools`) |
| [`plugin-diagnostic-sifter/`](plugin-diagnostic-sifter/README.md) | `run_diagnostic_check`: runs typecheck or a scoped test suite and returns a bounded root-cause list with cascade noise suppressed. | (registers on `ctx.tools`) |
| [`plugin-pinned-scratchpad/`](plugin-pinned-scratchpad/README.md) | `scratchpad_update`: pins key/value facts into a bounded system-prompt block that survives context compaction. | (registers on `ctx.tools`) |
| [`plugin-subagent-router/`](plugin-subagent-router/README.md) | `subagent`: delegates a task to a subagent provider selected by config-owned label-routing policy. | (registers on `ctx.tools`) |
| [`plugin-telemetry-recorder/`](plugin-telemetry-recorder/README.md) | `get_session_telemetry`: reports the calling session's own token velocity, cache hit rate, context headroom, latency, and subagent counts. | (registers on `ctx.tools`) |
| [`plugin-worktree-sandbox/`](plugin-worktree-sandbox/README.md) | `sandbox_exec`: runs a command in an isolated git worktree and returns the trial's bounded diff and exit status. | (registers on `ctx.tools`) |

The child READMEs own the tool, extraction, and rendering contracts.