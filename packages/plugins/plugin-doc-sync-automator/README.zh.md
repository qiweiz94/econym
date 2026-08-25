# @econym/dsh-plugin-doc-sync-automator

[English](README.md) | 中文

面向模型的 `sync_bilingual_pair` 工具:将英文 Markdown 文档中变更的一个小节,拼接进其配对的 `.zh.md` 镜像文档,并用 NEEDS-TRANSLATION 标记包裹,同时保持双语配对在结构上有效,并刷新其 `.i18n.yaml` 一致性记录。本工具从不进行机器翻译;它只保持配对在机制上有效,并把翻译欠账标记出来,留给人工译者处理。

## 功能说明

在 `ctx.tools` 上注册一个工具:

- `sync_bilingual_pair(docPath, updatedSection)` 按照仓库的 `.md` → `.zh.md` 配对约定(`docs/i18n/README.md`)定位 `docPath` 对应的简体中文镜像文档,在英文源文档中找到 `updatedSection.heading` 所指的小节,并把该小节原样拼接进镜像文档中结构上对应的标题位置,外层包裹 `<!-- NEEDS-TRANSLATION: begin -->` / `<!-- NEEDS-TRANSLATION: end -->` 标记。

拼接成功后,配对的 `.i18n.yaml` 一致性记录会用双方最新的 git blob 哈希重写,因此 `pnpm run verify-translation-pairing` 会将其视为已确认一致的配对,而非失步配对。随后会针对该清单中预算到的那一侧或两侧路径,按 `scripts/doc-budgets.manifest.json` 的上限校验字数。

## 复用的配对与校验机制

`scripts/` 目录由 `tsx` 直接运行,并未构建或发布为工作区包——`packages/` 下没有任何包导入它,若在此处导入,会把源文件置于本包 `rootDir` 之外,破坏 `tsc -b` 的组合式声明产出。因此 `src/pairing.ts` 与 `src/budgets.ts` 按值移植仓库自身的约定,而非另造一套:

- **路径推导**(`derivePairPaths`)与 `scripts/translation-pairing-record.ts#translationPairPaths` 采用相同的 `.md` → `.zh.md` / `.i18n.yaml` 规则。
- **`.i18n.yaml` 记录**(`gitBlobHash`、`renderPairMeta`)使用与 `scripts/translation-pairing.ts#blobHash` / `scripts/translation-pairing-record.ts#renderTranslationPairingRecord` 完全相同的 git blob 哈希算法与记录文本,因此本工具写出的记录与该渲染函数的产出逐字节一致,能在 `pnpm run verify-translation-pairing` 下干净通过。
- **文档预算**(`checkDocBudget`)直接读取 `scripts/doc-budgets.manifest.json`,并使用与 `scripts/verify-doc-budgets.ts#countWords` 完全相同的 `wc -w` 风格计数函数,因此为整体语料库门禁所做的上限调整,在此处同样生效,不会产生偏差。
- **结构对应关系**(`headingDepthDivergence`)镜像了 `scripts/translation-pairing.ts#translationStructureDiff` 中的标题轴——这是拼接操作唯一可能扰动的轴——并在每次拼接后作为自检。它有意不复现该函数对代码块/表格/列表/链接的检查:那需要 `mdast`/`gfm` 解析,会给本包引入声明的工作区三件套预算之外的依赖。`pnpm run verify-translation-pairing` 仍是完整结构校验的权威来源。

## 导出形态

一个函数/命名空间插件:导出 `name` / `inject` / `apply`,且不导出 default。误加 `export default` 会在 Loader 的 `unwrapExports` 下折叠该模块并丢失 `inject`(参见 [docs/postmortem/0001](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/postmortem/0001-acp-default-export-drops-inject.md))。

## 模型体验

### 工具 schema

#### 模型看到的内容

模型看到生成的 `sync_bilingual_pair` schema:一个必填的 `docPath` 字符串,以及一个必填的 `updatedSection` 对象,内含 `heading` 字符串。插件配置(仓库根目录、预算清单路径、工具名)在加载时校验;它不改变任何 schema 字段,只决定工具读写的位置。

#### Token 影响

只要该工具可见,每次请求都有固定的 schema 开销;调用结果是一个字段固定、体积很小的 JSON 对象(`paired`、`mirrorPath`、`budgetOk`、`pendingTranslation`)。

#### KV 缓存影响

只要定义与可见性不变,前缀就保持稳定可复用。插件生命周期或作用域限制可能使该 schema 的复用失效;拼接本身发生在调用内部,不会进入请求前缀。

## 已知限制与待办事项

- **不进行机器翻译**——这是设计使然。拼接进去的内容就是原样的英文文本,外层包裹 NEEDS-TRANSLATION 标记;之后由人工替换。
- **结构自检仅覆盖标题**——拼接后不会重新检查代码块、表格、列表与链接目标(见上文"复用的配对与校验机制");完整的全语料库检查请运行 `pnpm run verify-translation-pairing`。
- **每次调用处理一个小节**——一份文档若有多个小节发生变更,需要对每个 `updatedSection.heading` 分别调用一次。
- **按序号对应,而非语义匹配**——被替换的镜像小节,是与源小节处于相同标题位置的那一个,这要求配对双方在本次调用之前,标题数量与深度已经一致。若镜像文档在别处已经失步,工具会直接失败,而不会去猜测拼接位置。
- **不会创建镜像文档**——当 `docPath` 完全没有 `.zh.md` 对应文档时,工具报告 `paired: false` 且不写入任何内容;从零开始撰写一份新的翻译配对是需要人工评审的步骤(参见 `docs/i18n/README.md`)。
- **仅限本地文件系统**——只对配置的 `root` 执行纯 `node:fs` 读写;不运行任何 git 操作(`.i18n.yaml` 哈希由文件内容计算得出,而非调用 `git hash-object`)。
