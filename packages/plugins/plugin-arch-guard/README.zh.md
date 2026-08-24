# @econym/dsh-plugin-arch-guard

[English](README.md) | 中文

面向模型的 `check_module_boundary` 工具：在写下一处导入之前，检查从 `sourcePath` 导入 `targetImport` 是否符合该 monorepo 的包分层规则。

## 功能

在 `ctx.tools` 上注册一个工具：

- `check_module_boundary(sourcePath, targetImport)` 评估一次拟议的导入，返回 `{ allowed, rule, suggestion? }`。`rule` 是标识由哪条规则做出裁决的稳定名称；当 `allowed` 为 `false` 且存在已知的修正写法时会附带 `suggestion`。

工作区包依赖图在插件挂载时从 `config.root`（默认进程 cwd）扫描一次，不会在每次调用时重新读取。

## 分层规则

这些规则取自仓库自身的约束工具与既有约定，而非凭空设计：

- **层级方向。** 每个包分组都属于三层之一，顺序为 `foundation < capability < surface`。一个包只能依赖自身所在层或更低的层，绝不能依赖更高的层。
  - `foundation`：`vendor`（`scripts/check-workspace-constraints.ts` 的 `vendoredPackages` 会对每项 dsh 范围检查提前返回——被 vendor 化的框架不携带任何仓内依赖）以及 `util`（`packages/README.md` 称其"harness-dep-free"，即不依赖 harness 本体）。
  - `surface`：`plugins`（`packages/plugins/README.md`："自包含的、面向模型的工具插件……不具备可替换的 provider 契约"）、`host` 与 `client`（构建在产品主干之上的 Web GUI 两半）。
  - `capability`：其余所有分组——即 `packages/core/README.md` 所称"插件与消费者据以构建的稳定产品主干"。
- **插件之间不得未声明地互相导入。** `packages/README.md` 指出"扩展插件依赖 Service Definition，绝不依赖具体的 provider"，而实际情况也是如此：目前没有任何已发布的 `packages/plugins/*` 包把另一个 `plugins/*` 包列为依赖。`plugins` 分组的包只有在 `dependencies`/`peerDependencies`/`devDependencies` 中声明了某个同级包时，才可以导入它。
- **无环性。** `scripts/package-graph.ts` 的 `topoSort`——`scripts/gen-module-graph.ts`（模块图门禁）正是用它从 peer 依赖图生成 `docs/module-graph.md`——在依赖图不是 DAG 时会抛出异常。本工具对拟议中的一条边应用同一条规则：若目标包已经（直接或传递地）依赖源包，则该导入会在包依赖图中形成环。
- **exports 映射的有效性。** 目标包 `package.json` 的 `exports` 未声明的子路径不可导入，这与 Node 自身的包导出限制一致（支持每个键中出现一个 `*` 通配符）。
- **相对导入不得离开所属包。** 根目录约定要求跨包导入使用包名；解析结果落在源包自身目录之外的相对说明符会被拒绝。

## 模型体验

### 工具 schema

#### 模型看到的内容

模型看到生成的 [`check_module_boundary` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-arch-guard)：两个必填字符串输入（`sourcePath`、`targetImport`），以及结构化的 `{ allowed, rule, suggestion? }` 裁决结果输出。插件配置（`root`，默认进程 cwd）在加载时校验，不改变任何 schema 字段——只决定一次调用针对哪个工作区依赖图进行检查。

#### Token 影响

工具可见的每个请求都有固定的 schema 成本；无论工作区规模多大，调用结果都是一个固定形状的小对象。

#### KV Cache 影响

在定义与可见性不变的情况下前缀稳定。被扫描的工作区依赖图仅在挂载时构建一次，不会进入请求前缀。

## 已知限制与暂缓事项

- **声明式依赖图，而非实时导入扫描** —— `dependsOn` 来自 `package.json` 中带 `workspace:` 协议的 `dependencies`/`peerDependencies`/`devDependencies`，而非解析实际的源码导入；一个包若导入了从未声明过的依赖，环检测将无法捕获。
- **每个 exports 键仅支持一个 `*` 通配符** —— 与 Node 自身对子路径模式的支持一致；条件导出（`import`/`require`/`types` 分支）会被展平为其键名，不按条件逐一评估。
- **不感知跨仓库情况** —— 工作区索引仅覆盖所配置 root 下的 `packages/*/*` 与 `vendor/*`；落在这些 glob 之外的目标（应用、示例叶子）会被报告为 `unknown-workspace-package`。
- **每次挂载时静态构建** —— 工作区依赖图在插件挂载时扫描一次；之后新增或重新归组的包在下一次挂载前不可见。
