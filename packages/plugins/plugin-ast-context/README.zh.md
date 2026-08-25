# @econym/dsh-plugin-ast-context

[English](README.md) | 中文

面向模型的 `get_file_outline` 与 `get_directory_outline` 工具：使用 tree-sitter 解析本地 TypeScript（`.ts` 或 `.tsx`）文件，并报告其中声明的符号及其从 1 开始的代码行区间，便于模型在读取大文件或目录树前先了解结构。

## 功能

在 `ctx.tools` 上注册两个工具：

- `get_file_outline(path)` 从磁盘读取单个文件，用匹配的 `tree-sitter` 语法解析（`.ts` 用 TypeScript、`.tsx` 用 TSX），并返回规范化的 `FileOutlineResult`：`{ path, symbols }`，其中每个 `SymbolEntry` 携带 `kind`（`function` | `class` | `interface` | `type` | `enum`）、`name`、从 1 开始的 `line`/`endLine` 以及 `children`（符号体内直接声明的声明与方法）。带 `export` 包装的声明按其真实名称报告；模型面向的渲染器为每个符号输出一行，成员缩进显示在所属符号之下。
- `get_directory_outline(path)` 遍历目录树，为找到的每个 `.ts`/`.tsx` 文件生成摘要（忽略隐藏条目与 `node_modules`，不跟随符号链接目录，并跳过 `.d.ts` 声明文件——它们只含类型、没有可摘要的运行时符号），并返回 `{ path, files, skippedFiles }`，其中 `files` 是按路径顺序排列的每文件 `FileOutlineResult`。

无法解析（语法错误）或无法读取的文件会在文件调用中产生 `isError` 结果；在目录摘要中，这类文件计入 `skippedFiles` 而不是使整个调用失败。摘要有界：大于 `maxBytes`（默认 2 MiB）的文件、符号数超过 `maxSymbols`（默认 2,000）的摘要，或候选文件数超过 `maxFiles`（默认 200）的目录都会被拒绝——目录摘要把超出上限的数目报告在 `skippedFiles` 中，而不是静默截断。

## 提取范围

摘要是文件文本的纯函数：按源码顺序提取顶层的 `function`/`class`/`interface`/`type` 别名/`enum` 声明，以及每个符号体内直接声明的声明与方法成员（`class_body`/`interface_body`/`statement_block`），每个符号一层体深度。类字段、属性签名、词法声明（`const f = () => {}`）、命名空间以及嵌套控制流块内的声明均不报告。

## 导出形态

函数／命名空间插件：导出 `name`／`inject`／`apply` 且**不**导出 default。多余的 `export default` 会被 Loader 的 `unwrapExports` 折叠并丢弃 `inject`（参见 [docs/postmortem/0001](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## 模型体验

### 工具 schema

#### 模型看到的内容

模型看到生成的 `get_file_outline` 与 `get_directory_outline` schema：各有一个必填的 `path` 字符串，包含 `kind`/`name`/`line`/`endLine`/`children` 的结构化 `symbols` 数组，以及目录变体的每文件 `files` 数组与 `skippedFiles` 计数。插件配置（`maxBytes` 默认 2 MiB、`maxSymbols` 默认 2,000、`maxFiles` 默认 200）在加载时校验，非法值快速失败；它不改变任何 schema 字段，只决定调用是成功解析还是返回指引性的错误结果。

#### Token 影响

工具可见的每个请求都有固定的 schema 成本；调用结果随被摘要文件中声明的符号数量增长——对目录工具而言，还随 `maxFiles` 之下的文件数量增长。

#### KV Cache 影响

在定义与可见性不变的情况下前缀稳定。插件生命周期或作用域限制可能使该 schema 的复用失效；解析结果在调用内部产生，不会进入请求前缀。

## 已知限制与暂缓事项

- **两种语法** —— `.ts` 与 `.tsx` 使用 `tree-sitter-typescript` 语法；暂不支持其他语言（`.js`、`.mts`、`.cts`）。
- **浅层摘要** —— 每个符号仅一层体深度；嵌套在控制流块中的声明以及命名空间（及其内容）不报告。
- **省略匿名绑定** —— 词法声明（`const`、`let`、`var`）和匿名函数不属于摘要范围，因此函数值常量不会出现。
- **每次调用单个文件** —— 除目录遍历外无批量模式；模型每次调用 `get_file_outline` 处理一个文件。
- **目录摘要遍历整棵树** —— 遍历受 `maxFiles` 约束，但仍需完整 `readdir` 一遍；即使摘要很小，极大的目录树也可能较慢。
- **跳过声明文件** —— `.d.ts` 文件有意不参与摘要（它们声明类型而非运行时符号）；遍历同时忽略隐藏条目、`node_modules`，且不跟随符号链接目录。