# plugins/ — 自包含的模型面向工具插件

[English](README.md) | 中文

在 `ctx.tools` 上提供单一自包含的模型面向工具、且自身没有可替换的提供方契约或能力接缝的包。

| 包 | 角色 | ctx key |
|---|---|---|
| [`plugin-ast-context/`](plugin-ast-context/README.md) | `get_file_outline`：本地 TypeScript 文件的 tree-sitter 符号摘要。 | （注册于 `ctx.tools`） |

子 README 拥有工具、提取与渲染契约。