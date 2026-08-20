# plugins/ — 自包含的模型面向工具插件

[English](README.md) | 中文

在 `ctx.tools` 上提供单一自包含的模型面向工具、且自身没有可替换的提供方契约或能力接缝的包。

| 包 | 角色 | ctx key |
|---|---|---|
| [`plugin-ast-context/`](plugin-ast-context/README.md) | `get_file_outline` / `get_directory_outline`：本地 TypeScript 文件与目录的 tree-sitter 符号摘要。 | （注册于 `ctx.tools`） |
| [`plugin-diagnostic-sifter/`](plugin-diagnostic-sifter/README.md) | `run_diagnostic_check`：运行类型检查或范围化测试套件，抑制级联噪音后返回有界的根因列表。 | （注册于 `ctx.tools`） |
| [`plugin-pinned-scratchpad/`](plugin-pinned-scratchpad/README.md) | `scratchpad_update`：把键值事实钉进有界的系统提示词块，在上下文压缩后仍然存在。 | （注册于 `ctx.tools`） |
| [`plugin-subagent-router/`](plugin-subagent-router/README.md) | `subagent`：将任务委派给由配置所有的标签路由策略选出的子代理提供方。 | （注册于 `ctx.tools`） |
| [`plugin-worktree-sandbox/`](plugin-worktree-sandbox/README.md) | `sandbox_exec`：在隔离的 git worktree 中运行命令，返回试运行的有界 diff 与退出状态。 | （注册于 `ctx.tools`） |

子 README 拥有工具、提取与渲染契约。