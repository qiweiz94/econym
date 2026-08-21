# @deepseek-ai/dsh-plugin-semantic-patcher

[English](README.md) | 中文

面向模型的 `patch_symbol_body` 工具：就地替换单个具名 TypeScript 符号的函数体。目标符号由 tree-sitter 在解析出的语法树中定位，而非依赖文本匹配，因此即使同样的函数体文本在文件其他位置出现，编辑也会准确落在模型指定的那个声明上。

## 功能

在 `ctx.tools` 上注册一个工具：

- `patch_symbol_body(path, symbol, newBody)` 从磁盘读取单个文件，用匹配的 `tree-sitter` 语法解析（`.ts` 用 TypeScript、`.tsx` 用 TSX），定位具名符号的函数体节点，并精确替换该节点的源码区间。返回 `{ path, symbol, kind, line, endLine }`，其中 `symbol` 是实际匹配到的完全限定名，`kind` 为 `function` | `method` | `arrow`，`line`/`endLine` 是被替换函数体从 1 开始的行区间。

`symbol` 参数接受裸名称（`target`）或带点的限定名（`Class.method`）。裸名称若恰好匹配一个符号即被采用；若匹配到多个，调用会失败并列出限定候选名，而不是擅自猜测。精确的限定名匹配始终优先于文件中其他位置的裸名称匹配，因此 `Class.method` 是解决任何命名冲突的手段。

`newBody` 会逐字替换函数体节点：块状函数体请连同花括号一起传入（`{ return 1 }`），简写箭头函数体则传入裸表达式（`a * 2`）。

## 安全保证

- **限定在仓库内** —— `path` 相对配置的 `cwd`（默认 `process.cwd()`）解析；解析结果等于根目录本身或落在根目录之外的路径，会在触碰文件系统之前被拒绝。
- **不在已损坏的文件上打补丁** —— 先解析原始文本，携带语法错误的语法树会被拒绝，因此绝不会在不可靠的解析结果中定位区间。
- **先校验后写入** —— 完整的新文件文本在内存中构建并重新解析，只有解析干净才会提交。会破坏文件的 `newBody` 会使调用失败，而磁盘上的文件仍与原始字节完全一致；因此不存在磁盘上的文件无法解析的时间窗口。
- **原子提交** —— 被接受的文本通过 `writeFileAtomic` 写入：它把同目录的临时文件重命名覆盖目标，并把文件原有的权限位带到替换后的 inode 上。
- **有界** —— 大于 `maxBytes`（默认 2 MiB）的文件会被拒绝，而不会被解析。

## 可打补丁的范围

文件顶层的 `function` 声明；文件顶层值为箭头函数或函数表达式的 `const`/`let`/`var` 绑定；以及类成员：`method_definition`（含 getter、setter、`static` 与 `async` 形式）和值为箭头函数的类字段。类成员以 `Class.member` 命名。接口方法签名、抽象成员、值不是函数的字段、命名空间，以及嵌套在控制流块或其他函数体内的声明，均不可打补丁。

## 解析器栈

原生 `tree-sitter` 搭配 `tree-sitter-typescript`，放在 `dependencies` 中，与 [`plugin-ast-context`](../plugin-ast-context/README.md) 完全一致——相同的包版本、相同的 `import Parser from 'tree-sitter'` 进程内 CST 解析，以及相同的 `grammarFor` 扩展名分派。仓库只构建这套原生绑定一次（`pnpm-workspace.yaml` 中的 `allowBuilds`）；本包不引入第二套解析器栈。

请注意，node-tree-sitter 报告的 `startIndex`/`endIndex` 是相对被解析 JavaScript 字符串的 **UTF-16 码元偏移**，而不是 UTF-8 字节偏移。此处所有区间切片都在字符串上进行；若用这些下标去切 `Buffer`，在目标之前含有非 ASCII 文本的文件中就会切错位置。带有 CJK 文本与 emoji（位于目标前后）的测试夹具锁定了这一行为。

## 导出形态

函数／命名空间插件：导出 `name`／`inject`／`apply` 且**不**导出 default。多余的 `export default` 会被 Loader 的 `unwrapExports` 折叠并丢弃 `inject`（参见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## 模型体验

### 工具 schema

#### 模型看到的内容

模型看到生成的 [`patch_symbol_body` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-semantic-patcher)：三个必填字符串（`path`、`symbol`、`newBody`），以及由 `path`/`symbol`/`kind`/`line`/`endLine` 组成的结构化结果。插件配置（`cwd`、`maxBytes` 默认 2 MiB）在加载时校验，非法值快速失败；它不改变任何 schema 字段，只决定调用是成功解析还是返回指引性的错误结果。

#### Token 影响

只要工具可见，每次请求都产生固定的 schema 开销。调用开销主要来自模型自己撰写的 `newBody`；无论文件多大，结果都只有固定的几个字段，因此确认一次补丁的代价远低于重新读取被编辑的文件。

#### KV Cache 影响

在定义与可见性不变的前提下前缀稳定。插件生命周期或作用域限制可能使基于该 schema 的复用失效；解析结果与补丁后的文本都在调用内部产生，绝不会进入请求前缀。

## 已知限制与后续工作

- **两种语法** —— `.ts` 与 `.tsx` 使用 `tree-sitter-typescript` 的语法；其他语言（`.js`、`.mts`、`.cts`）尚未支持。
- **只有一层函数体深度** —— 只有文件顶层声明与类的直接成员可被寻址；声明在另一个函数体内部的函数无法被指名。
- **先校验后写入，而非写入后回滚** —— 拒绝路径的实现方式是根本不写入，因此被拒绝的补丁是让原文件保持原样，而不是从备份恢复。可观察到的保证相同且更强：磁盘上的文件绝不存在无法解析的时间窗口。
- **呈现为通用编辑卡片，而非 diff 卡片** —— `presentCall` 是 `args` 的纯函数，而被替换的函数体并不在 `args` 中：找到它需要解析文件。diff 卡片将不得不臆造或省略其 `oldText`，因此该调用以 `generic`／`edit` 形式连同文件位置一起呈现，这与 `str_replace_editor` 的 `insert` 命令出于同样原因所做的选择一致。要渲染真正的 diff，需要一个能读取调用前文件内容的呈现 seam。
- **只支持整体替换函数体** —— 不支持函数体内部的锚定或局部编辑；模型需要提供完整的替换函数体。
- **不做格式化** —— `newBody` 逐字插入。缩进与代码风格由调用方负责；工具只检查结果能否解析。
- **不区分重载** —— 共享同一限定名的两个成员（例如同名类被声明两次）会被报告为歧义，无法通过本工具打补丁。
- **持久化不在范围内** —— 原子重命名之后不会对文件或其父目录执行 `fsync`，这与 `@deepseek-ai/dsh-atomic-write` 记载的范围一致。
