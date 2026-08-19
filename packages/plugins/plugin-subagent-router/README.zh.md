# @deepseek-ai/dsh-plugin-subagent-router

[English](README.md) | 中文

模型可见的 `subagent` 工具：一个统一的委托入口，按配置所拥有的策略把委托任务路由到某个子代理（subagent）provider。模型只需描述任务（一句简短描述和完整提示词）；路由器按顺序解析第一个已注册且其启动期能力（start-time capabilities）满足配置请求选项的 provider——来自默认候选列表或按标签命中的路由覆盖——并通过 `ctx.subagents.start` 派发。

## 功能

在 `ctx.tools` 上注册一个工具：

- `subagent(description, prompt)` 把自包含任务委托给子代理并等待其结果。路由器把 `description`（简短任务标签）与配置的 `routes` 匹配；命中时使用该路由的 `providers` 候选，否则使用默认 `providers` 列表。按顺序逐个候选：跳过未注册的 provider，也跳过 `SubagentCapabilities` 不覆盖本次委托需求的 provider（配置了 `persona` 就需要 `persona` 能力，`toolFilter` 需要 `toolFilter`，数字 `maxDepth` 需要 `depthLimit`），派发给第一个兼容者。没有候选能服务时，调用会大声失败，并列出尝试过的候选与缺失的能力。

子代理的最终输出作为工具结果返回给模型；非 `completed` 的终止原因（`aborted`、`error`、`max-tokens`、`refusal` 或未知的后端原因）会作为 `isError` 结果上报，同时仍保留子代理的部分输出。

## Provider 选择

Provider 选择是**策略，而非模型的传输词汇**——模型永远不会指名 provider 或传输方式。策略完全由配置拥有且确定：

- `providers`（必填）——无路由命中时按顺序尝试的默认候选。
- `routes`——按标签命中的覆盖：每条含 `label`（对任务 `description` 不区分大小写的子串匹配）和各自的 `providers` 候选。第一条命中的路由生效。
- `persona`、`toolFilter`、`maxDepth`——转发给 provider 的请求选项；设置任一都会要求对应 provider 能力（当解析出的 provider 缺失时大声失败）。
- `agentOptions`——按子代理的模型/provider 覆盖（`provider`、`model`、`maxTokens`）。

由于 provider 可能晚于本插件注册（兄弟加载顺序、HMR 替换），路由器在每次调用时都对着实时的 `ctx.subagents` 注册表解析——它不缓存任何 provider 状态，也无需维护 `subagent/provider-added` 记账。

## 导出形态

函数/命名空间插件：导出 `name` / `inject` / `apply`，且**没有**默认导出。多余的 `export default` 会被 Loader 的 `unwrapExports` 折叠并丢掉 `inject`（参见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## 模型体验

### 工具 Schema

#### 模型看到什么

模型看到生成的 [`subagent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-subagent-router)：一个必填 `description` 字符串和一个必填 `prompt` 字符串。插件配置（路由策略）在加载时校验，非法值大声失败（空的 `providers`、空的 `toolFilter`）；它不改动任何 schema 字段，只决定哪个 provider 服务该调用，或该调用是否返回一条指引性的错误结果。

#### Token 影响

每次工具可见的请求都有固定的 schema 成本；调用结果随被委托子代理的最终输出大小而变化。

#### KV Cache 影响

在定义与可见性不变时前缀稳定。插件生命周期或作用域限制可能使该 schema 的复用失效；委托本身发生在调用内部，从不进入请求前缀。

## 已知限制与待办

- **仅前台**——路由器会等待被委托子代理的结果；`dsh-tool-subagent` 的 `run_in_background` / 可续会话（continuable）模式不在此暴露。后台或可续委托请使用 `dsh-tool-subagent` 实例。
- **策略是配置而非学习所得**——路由只匹配静态标签子串；除 `description` 外没有模型可见的选择器。
- **第一个可用者胜出**——候选按配置顺序尝试，除注册存在性外没有负载均衡或健康信号。
- **无派发前拦截**——子代理接缝没有暴露派发前 waterfall，因此路由器是调用方/协调者（用自有工具调用 `ctx.subagents.start`），不是其他工具委托的中间人；续会话授权仍是精确的“活父”关系。
