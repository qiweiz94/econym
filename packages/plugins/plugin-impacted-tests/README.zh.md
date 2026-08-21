# @deepseek-ai/dsh-plugin-impacted-tests

[English](README.md) | 中文

模型可见的 `run_impacted_tests` 工具：用 TypeScript 编译器 API 构建工作区的导入 DAG，从变更文件出发**逆向**遍历该图，找出所有传递性导入了变更文件的测试套件，并只运行这些套件。

## 功能

在 `ctx.tools` 上注册一个工具：

- `run_impacted_tests(files?)` 先确定变更集（给定的路径；省略 `files` 时取 `git status --porcelain` 报告的未提交改动文件），选出受影响的套件，并把选中的套件路径追加到 `runnerCommand` 后执行。结果包含 `selectedSuites`、`skippedCount`，以及带有运行器退出状态和有界 `stdout`/`stderr` 的 `results` 摘要。

没有套件被选中时不会运行任何东西。空变更集不选中任何套件，也不会进入图遍历；没有任何套件导入的变更文件——一份 Markdown 文档、一个配置文件——同样不选中任何套件。变更文件本身是套件时，它选中自己。

## 选择模型

- **发现。** `testPatterns`（默认 `packages/*/*/tests/**/*.spec.ts` 与 `.spec.tsx`）确定候选套件集合。`skippedCount` 是变更集未触及的已发现套件数。
- **正向遍历。** DAG 以已发现的套件为种子，沿每个文件的导入说明符（由 `ts.preProcessFile` 提取）正向遍历。对本问题而言以套件为种子是完备的——任何套件都到不了的文件，不可能被某个套件导入——同时避免了 `ts.createProgram` 会加载整个工作区的开销。
- **逆向遍历。** 正向边被反转一次，然后从变更集出发逆向遍历。所有传递性导入了变更文件的文件，与已发现套件求交集，即为选择结果。
- **统一的路径形式。** git 报告仓库相对路径，编译器报告绝对路径，而 macOS 临时目录要经过 `/var` → `/private/var` 符号链接。所有路径都通过同一个绝对、解引用符号链接的归一化函数，因此"未选中任何套件"是一个答案，而不是路径形式不匹配。
- **上界。** 选择结果超过 `maxSuites`（默认 200）时直接失败而不运行；运行器在 `timeoutMs`（默认 10 分钟）后被终止。

## 模块解析

导入说明符通过 `ts.resolveModuleName` 依据 `tsconfigPath`（默认 `tsconfig.base.json`）中的编译器选项解析，因此相对说明符、tsconfig `paths` 以及 `node_modules` 的包 `exports` 都与仓库自身静态门禁的解析方式一致。工作区包名还要再走两步，因为图必须停留在源码平面：

- **产物到源码。** 若某个包名的 `exports` 映射指向构建产物，解析结果会是 `<pkg>/lib/index.js` 或 `<pkg>/lib/types/x.d.ts`；二者在进入图之前都会被映射回 `<pkg>/src/…`。没有这一步，导入已构建包的套件将永远无法与该包源码的改动建立关联。
- **工作区清单索引。** 既无 `paths` 条目又无已构建 `lib` 的包，编译器根本无法解析。所有工作区清单按包名建立索引，裸包名、`exports` 别名与 `./src/*` 子路径都在 `<pkg>/src` 下解析。

## 输出保留包络

运行器的 `stdout` 与 `stderr` 各自经 `@deepseek-ai/dsh-output-retention` 的 `TextRetainer` 以 `tail` 策略、按 `maxOutputBytes`（默认 15 KB）保留。测试运行器的结论与失败摘要位于流的**末尾**，因此超出包络的运行会保留真正回答本次调用的那部分；`truncated` 标志与渲染文本中的提示会报告丢失。

## 导出形态

这是函数/命名空间插件：导出 `name` / `inject` / `Config` / `apply`，且**没有** default。多余的 `export default` 会让模块被 Loader 的 `unwrapExports` 折叠并丢失 `inject`（参见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## Model Experience

### Tool schema

#### What the model sees

模型看到生成的 [`run_impacted_tests` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-impacted-tests)：一个可选的 `files` 数组，元素为仓库相对路径。插件配置（仓库根、tsconfig、套件模式、运行器命令、套件数与字节上界、超时）在加载时校验，遇到非法值即失败（例如非正的 `maxOutputBytes`）；它不改变 schema 的任何字段，只改变存在哪些套件以及它们如何运行。

#### Token effect

只要工具可见，每次请求都有固定的 schema 开销。结果规模取决于选中的套件列表加上运行器的有界输出（每条流上限为 `maxOutputBytes`），这正是本工具比全量运行更省的原因：无影响的改动只返回一行。

#### KV Cache effect

在定义与可见性不变时保持前缀稳定。插件生命周期或作用域限制可能使基于此 schema 的复用失效；图遍历与运行都发生在调用内部，永不进入请求前缀。

## Known Limitations and Deferred Work

- **仅静态导入** —— DAG 只由 `ts.preProcessFile` 能看到的导入说明符构建。若某套件通过计算得出的动态 import、运行时读取的 fixture 路径、生成文件或快照触达代码，则不会与之建立关联，因此这类套件可能确实受影响却被跳过。
- **非导入型影响不可见** —— 变更的 `cordis.yml`、JSON fixture 或生成的目录文件都不是图中的节点，因此不选中任何套件。这是既定的答案，而非检测到的失败。
- **默认变更集依赖 git** —— 省略 `files` 时会调用 `git`（可用 `gitBinary` 配置）；非 git 的 `cwd` 会直接失败，而不会退化为全量运行。
- **套件粒度** —— 选择以文件为单位，而非以单个测试用例为单位；一行改动会选中导入它的整个套件。
- **运行器是被派生的，而非内嵌的** —— `runnerCommand` 是一个 argv 前缀，套件路径追加其后，因此工具报告的是运行器的退出状态与有界流，而不是结构化的逐用例报告。
- **包络的边界情形** —— 两条运行器流都按尾部保留，因此若失败细节之后跟着很长的收尾摘要，细节可能丢失。
