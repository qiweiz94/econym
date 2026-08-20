# plugins/ — self-contained model-facing tool plugins

English | [中文](README.zh.md)

Packages that ship one self-contained model-facing tool on `ctx.tools` without a replaceable provider contract or capability seam of their own.

| Package | Role | ctx key |
|---|---|---|
| [`plugin-ast-context/`](plugin-ast-context/README.md) | `get_file_outline` / `get_directory_outline`: tree-sitter symbol outlines of local TypeScript files and directories. | (registers on `ctx.tools`) |
| [`plugin-subagent-router/`](plugin-subagent-router/README.md) | `subagent`: delegates a task to a subagent provider selected by config-owned label-routing policy. | (registers on `ctx.tools`) |
| [`plugin-worktree-sandbox/`](plugin-worktree-sandbox/README.md) | `sandbox_exec`: runs a command in an isolated git worktree and returns the trial's bounded diff and exit status. | (registers on `ctx.tools`) |

The child READMEs own the tool, extraction, and rendering contracts.