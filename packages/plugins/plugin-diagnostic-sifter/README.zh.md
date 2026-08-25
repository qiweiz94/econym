# @econym/dsh-plugin-diagnostic-sifter

[English](README.md) | 中文

模型可见的 `run_diagnostic_check` 工具：通过子进程能力运行仓库的类型检查（`tsc -b`）或范围化的测试运行（`vitest run`），然后将捕获的输出筛选为根因诊断——下游模块解析级联被抑制并计数，完全重复的诊断被合并，测试输出被裁剪到仅保留失败断言的细节——并受输出保留包络约束。

## 功能

在 `ctx.tools` 上注册一个工具：

- `run_diagnostic_check(command, targetPath?)` 运行配置好的 `tsc -b` 构建或 `vitest run`，可选地限定到 `targetPath`（对 `typecheck` 是一个项目/目录，对 `test` 是一个文件或目录），返回筛选后的诊断结果：`rootCauses`（文件、行号、代码、消息）、`suppressedCascadeCount`、`deduplicatedCount`、`truncated`，以及 `success`/`exitCode`/`signal`。

失败退出且没有产生可解析诊断的运行——或筛选器完全无法识别的输出——会被报告为 `parseFailure: true`，并携带有界的原始输出，绝不会被静默地读作 `success: false` 且诊断列表为空。

## 筛选模型

- **tsc**：`TSC_LOCATED`/`TSC_GLOBAL` 解析 `tsc --pretty false` 的逐文件诊断行与配置级诊断行（缩进的续行会合并进前一条诊断，使多行的类型阐述仍是一条根因）。
- **级联抑制**：只有当 `TS2307`（找不到模块）或 `TS2724`（无此导出成员）诊断的消息中引用的模块说明符——按 basename 匹配，而非真实的模块解析——能对应到本次运行中**也**有自身保留诊断的文件时，该诊断才会被抑制。一个恰好共享这些代码之一、但没有匹配保留诊断的、真正缺失的模块，会被保留为它自己的根因。
- **vitest**：解析报告器的 ` FAIL ` 块，为每个失败测试生成一条根因，保留断言消息及其 `- Expected`/`+ Received` diff，丢弃通过测试的行、代码帧与堆栈帧噪声；根因位置优先选择失败测试自身所在文件的帧，而非更深的辅助函数帧。
- **去重**：完全相同的诊断（相同文件、行号、代码、消息）会合并为一条，计入 `deduplicatedCount`。

## 输出保留包络

`maxOutputBytes`（默认 15 KB）通过 `@deepseek-ai/dsh-output-retention` 的 `TextRetainer`（`head` 策略）约束三处：每个被捕获的流（`stdout`/`stderr`，在解析前各自独立设上限）、序列化后的 `rootCauses` 列表，以及解析失败时携带的原始输出。当流捕获或根因序列化任一处丢弃了字节，`truncated` 即为 `true`——包络截断绝不会被读作解析失败，二者被独立报告。

## 导出形态

函数/命名空间插件：导出 `name` / `inject` / `apply`，且**没有**默认导出。多余的 `export default` 会被 Loader 的 `unwrapExports` 折叠并丢掉 `inject`（参见 [docs/postmortem/0001](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## 模型体验

### 工具 Schema

#### 模型看到什么

模型看到生成的 `run_diagnostic_check` schema：一个必填的 `command`（`typecheck` 或 `test`）与一个可选的 `targetPath` 字符串。插件配置（工作目录、`tsc`/`vitest` 的 argv、输出包络、超时、工具名）在加载时校验，非法值大声失败（例如空的 `tscArgs`）；它不改动任何 schema 字段，只决定运行哪个检查、如何运行。

#### Token 影响

每次工具可见的请求都有固定的 schema 成本；调用结果随有界的诊断列表变化（解析失败时则是有界的原始输出），各以 `maxOutputBytes` 为上限。

#### KV Cache 影响

在定义与可见性不变时前缀稳定。插件生命周期或作用域限制可能使该 schema 的复用失效；被派生的检查本身发生在调用内部，从不进入请求前缀。

## 已知限制与待办

- **`tsc -b` 需要 composite/solution 项目**——构建模式（`-b`）要求目标 `tsconfig.json` 中设置 `"composite": true`（或项目引用）；一个普通的非 composite 配置会以 tsc 自身的构建模式错误失败，由于其中不携带可解析的逐文件诊断，会被报告为 `parseFailure`。
- **vitest 解析器假定默认报告器**——配置了非默认 vitest 报告器（`--reporter=json`、`dot`、自定义报告器）的项目会产生解析器无法识别的输出，表现为响亮的 `parseFailure` 而非静默的空白干净结果——但本工具本身不会为目标项目锁定或覆盖报告器选择。
- **级联匹配仅按 basename，非真实模块解析**——`TS2307`/`TS2724` 的抑制是将引用的模块说明符的 basename 与已保留诊断的文件 basename 比较；两个位于不同目录、恰好同名的文件（少见但可能）可能导致不相关的级联被误抑制，或真正的级联未被抑制。
- **`targetPath` 被限制在工作目录内**——它拒绝以 `-` 开头的值（选项注入）以及任何逃逸出所配置 `cwd` 的路径（`../..` 或指向别处的绝对路径），因此某次检查无法加载并执行外部的 `vitest`／`tsc` 配置；受限后的路径作为单个 argv 元素传给被派生的进程，从不经过 shell 解释。
- **不支持颜色/报告器可配置项**——派生进程时始终设置 `NO_COLOR=1`，以保证筛选器的正则表达式看到纯 ASCII；这是固定的输入格式卫生措施，不是一个暴露出来的配置项。
