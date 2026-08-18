# plugins/ — self-contained model-facing tool plugins

English | [中文](README.zh.md)

Packages that ship one self-contained model-facing tool on `ctx.tools` without a replaceable provider contract or capability seam of their own.

| Package | Role | ctx key |
|---|---|---|
| [`plugin-ast-context/`](plugin-ast-context/README.md) | `get_file_outline`: tree-sitter symbol outlines of local TypeScript files. | (registers on `ctx.tools`) |

The child READMEs own the tool, extraction, and rendering contracts.