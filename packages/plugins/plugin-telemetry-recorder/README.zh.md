# @deepseek-ai/dsh-plugin-telemetry-recorder

[English](README.md) | 中文

模型可见的 `get_session_telemetry` 工具：对调用方会话自身运行指标的紧凑读数——最近若干已结束轮次窗口上的 token 速率与轮次时延、提示缓存命中率、上下文余量，以及子代理委派计数——全部由持久会话日志与子代理生命周期事件折叠得出。

## 功能

在 `ctx.tools` 上注册一个工具：

- `get_session_telemetry()` 不接受任何参数，返回调用方会话的当前快照。它只读：除注册表写入的 `tool/call` 与 `tool/result` 外，自身不追加任何会话事件。

凡日志尚未提供证据的指标，一律从结果中**缺省**而非报告为零，使模型能区分「尚未测量」与「测得为零」。

| 指标 | 来源 | 缺省条件 |
| --- | --- | --- |
| `tokenVelocity` | `assistant/message.usage` 与 `assistant/chunk` 的 usage 分块，按轮次求和 | 尚无轮次结束 |
| `promptCache` | 同一批 usage 报告，仅取提示侧（input + cache read + cache write） | 已结束轮次未报告任何提示 token |
| `contextHeadroom` | 最新 `request/context.contextWindow` 与最新报告的提示大小之比 | 无路由公布容量，或无任何 usage 报告 |
| `turnLatency` | `turn/start` → `turn/end` 的墙钟跨度 | 尚无轮次结束 |
| `subagents` | `subagent/start` / `subagent/end`，经子会话的 `parentSession` 归属 | 从不缺省；计数从零开始 |

## 折叠机制

记录器是一个普通的自有对象，而非 cordis 服务：它唯一的消费者就是本包自己的工具，而一个没有外部 Consumer 的 Context 服务键会交付一个只有单一角色的能力接缝（capability seam）。

它复用 `dsh-token-meter` 的状态机制——以 `Session` 为键的 `WeakMap`，加上从已消费事件游标出发的追赶式重放。因此，一个被恢复、被 fork，或在本插件挂载时已在运行的会话会报告其真实历史而非零值：首次调用重放整份持久日志，此后由 fiber 的 `session/event` 监听器保持已观察会话为最新。无人查询的会话不积累任何状态。

usage 归属于其报告时处于打开状态的那一轮。同一步骤若报告两次 usage——先是流式 `usage` 分块、随后是组装完成的 `assistant/message`——后者替换前者而非重复累加。抵达时没有匹配的打开轮次的 usage 不归属于任何轮次，但仍会更新 `contextHeadroom` 读取的「最新提示」记录。

`windowTurns`（默认 10）是唯一的配置项：滚动窗口以已结束轮次计的大小。窗口填满后逐出最旧的已结束轮次，因此速率均值与时延统计描述的是近期行为，而非整段对话。

## 上下文余量是两条独立记录

`contextWindow` 与提示大小是两条各自「最后写入者胜出」的记录，并非一次原子观测。切换路由可能把新容量与上一条路由的提示配成一对，直到下一次请求报告 usage 为止；又因为只有请求会报告 usage，提示这一侧也看不见压缩（compaction）：压缩刚发生时该数值会偏高失真，直到下一次请求落地。该指标是面向用户与模型的参考值，不是门控或计费输入。`dsh-token-meter` 的 `contextPressure` 投影对同一组配对做了相同的让步声明。

## 导出形态

函数/命名空间插件：导出 `name` / `inject` / `Config` / `apply`，且**没有**默认导出。多余的 `export default` 会经 Loader 的 `unwrapExports` 折叠模块并丢弃 `inject`（参见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## Model Experience

### 工具 schema

#### 模型看到什么

模型看到生成的 [`get_session_telemetry` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-telemetry-recorder)：完全没有参数，输出对象的成员恰在折叠可能留空之处标注为可选。插件配置（`windowTurns`）在加载时校验，取非正值即高声失败；它不改变任何 schema 字段，只决定所报均值覆盖多少个已结束轮次。

#### Token 影响

在该工具可见的每次请求上产生固定的 schema 开销。结果按构造有界：一组固定的标量指标，加上该会话用过的每个子代理 provider 一行，因此不会随对话长度增长。

#### KV 缓存影响

在定义与可见性不变时前缀稳定。插件生命周期或作用域限制可能使基于该 schema 的复用失效。测量本身发生在调用内部，从不进入请求前缀——读取遥测不会扰动它所报告的缓存命中率。

## Known Limitations and Deferred Work

- **向 Web UI 的 WebSocket 流式推送被推迟** —— 插件不得自行开启 `ws` 服务器。Web UI 的载体是 `dsh-client-connection` 的 `WebSocketDownlinks`，运行在 `dsh-host-apiproxy` 的帧模型之上；包要接入它，所用的接缝是一个 `ctx.sessionProjections` 单元，其投递由投影注册表负责（`dsh-session-stats` 是范本）。此处由日志派生的指标——速率、缓存命中率、余量、时延——是纯 JSON 折叠，可以迁入这样的单元并免费获得流式推送。子代理计数则不行：它们来自 ctx 级的 `subagent/start` / `subagent/end` 观察事件对，而非会话日志，投影单元看不见它们。拆分二者是流式推送的前置条件，而非其实现细节。
- **远程子会话无法归属** —— 生命周期载荷携带的是子会话 id 而非父会话 id，故委派方会话需从存活的本地子代理的会话头部恢复。没有存活本地代理的子会话（远程 provider，或已被释放的）改计入 `unattributedSubagentRuns`，该计数按进程而非按会话报告。
- **插件挂载前已开始的运行永不结算** —— 记录器实时折叠子代理生命周期，而非从日志折叠，因此未见其开始的终止事件会被忽略。会话日志类指标没有这一空档：它们可重放。
- **委派计数只存活到其会话被释放** —— 计数在 `session/disposed` 时丢弃，因此从未经会话存储公布过的会话，其计数会保留至 fiber 生命周期结束。
- **`medianMs` 取下中位数** —— 偶数规模的窗口报告两个中间跨度中较小的那个，不做插值，因此所报数值始终是某个真实轮次的实际时长。
