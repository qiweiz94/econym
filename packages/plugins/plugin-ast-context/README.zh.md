# @deepseek-ai/dsh-plugin-ast-context

[English](README.md) | 中文

面向模型的 `get_file_outline` 工具：使用 tree-sitter 解析本地 TypeScript（`.ts` 或 `.tsx`）文件，并报告其中声明的符号及其从 1 开始的代码行区间，便于模型在读取大文件前先了解文件结构。

## 功能

在 `ctx.tools` 上注册一个工具 `get_file_outline(path)`。该工具从磁盘读取文件，用匹配的 `tree-sitter` 语法解析（`.ts` 用 TypeScript、`.tsx` 用 TSX），并返回规范化的 `FileOutlineResult`：`{ path, symbols }`，其中每个 `SymbolEntry` 携带 `kind`（`function` | `class` | `interface` | `type` | `enum`）、`name`、从 1 开始的 `line`/`endLine` 以及 `children`（符号体内直接声明的声明与方法）。带 `export` 包装的声明按其真实名称报告；模型面向的渲染器为每个符号输出一行，成员缩进显示在所属符号之下。

无法解析（语法错误）或无法读取的文件会以 `isError` 结果失败。摘要有界：大于 `maxBytes`（默认 2 MiB）的文件或符号数超过 `maxSymbols`（默认 2,000）的摘要会被拒绝，返回指引性的错误结果而不是截断。

## 提取范围

摘要是文件文本的纯函数：按源码顺序提取顶层的 `function`/`class`/`interface`/`type` 别名/`enum` 声明，以及每个符号体内直接声明的声明与方法成员（`class_body`/`interface_body`/`statement_block`），每个符号一层体深度。类字段、属性签名、词法声明（`const f = () => {}`）、命名空间以及嵌套控制流块内的声明均不报告。

## 导出形态

函数／命名空间插件：导出 `name`／`inject`／`apply` 且**不**导出 default。多余的 `export default` 会被 Loader 的 `unwrapExports` 折叠并丢弃 `inject`（参见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## 模型体验

### 工具 schema

#### 模型看到的内容

模型看到生成的 [`get_file_outline` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-ast-context)：一个必填的 `path` 字符串，以及包含 `kind`/`name`/`line`/`endLine`/`children` 的结构化 `symbols` 数组。

#### Token 影响

工具可见的每个请求都有固定的 schema 成本；调用结果随被摘要文件中声明的符号数量增长。

#### KV Cache 影响

在定义与可见性不变的情况下前缀稳定。插件生命周期或作用域限制可能使该 schema 的复用失效；解析结果在调用内部产生，不会进入请求前缀。

## 已知限制与暂缓事项

- **两种语法** —— `.ts` 与 `.tsx` 使用 `tree-sitter-typescript` 语法；暂不支持其他语言（`.js`、`.mts`、`.cts`）。
- **浅层摘要** —— 每个符号仅一层体深度；嵌套在控制流块中的声明以及命名空间（及其内容）不报告。
- **省略匿名绑定** —— 词法声明（`const`、`let`、`var`）和匿名函数不属于摘要范围，因此函数值常量不会出现。
- **每次调用单个文件** —— 无批量模式或目录遍历；模型每次调用该工具处理一个文件。