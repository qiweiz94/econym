# @deepseek-ai/dsh-plugin-budget-governor

[English](README.md) | 中文

一个用于失控的委托子代理运行的断路器，而不是面向模型的工具：它从不出现在工具列表中，也从不触及根代理。它只跟踪由子代理生命周期事件（`subagent/start` / `subagent/end`）宣告的会话，观察每个被跟踪子会话自身的事件流以检查配置的上限，并在某次运行触发上限时，通过子 `Agent` 的公开取消接口终止该运行。决策记录见 [budget-governor Agent Note](../../../.agents/notes/implemented/feature/2026-08-20-budget-governor-child-run-circuit-breaker.md)。

## 功能说明

对于每一个由 `subagent/start` 宣告的**本地**子运行（`info.local === true`，可通过 `ctx.agents.get(info.id)` 解析），治理器会创建每次运行的检测器状态，并向其输入该子会话自身的 `session/event` 事件流：

- **`maxChildTokens`** —— 在子会话每次 `assistant/message` 时，将 `ctx.tokenMeter.measure(childSession).totalTokens` 与上限比较。这衡量的是本框架用来给上下文定价的、面向模型可见的请求面，而不是供应商计费的累计花费。
- **`maxConsecutiveToolFailures`** —— 子会话中一次面向模型的结果块带有 `isError: true` 的 `tool/result` 会使每次运行的计数器加一；任何非错误结果都会将计数器重置为零，因此一个恢复正常的运行永远不会因其历史记录而被终止。
- **`editChurn`** —— `{ maxSameFileEdits, window, tools: [{ name, pathArgument }] }`。子会话中每一次指向已配置编辑工具的 `tool/call`，都会将其提取出的路径参数计入该运行最近 `window` 次编辑调用组成的有界滑动窗口；当某一路径在该窗口内累计达到 `maxSameFileEdits` 次时，上限被触发。移出窗口的编辑不再计数。

三个上限均为可选，但至少必须配置一个 —— 一个完全没有配置任何上限的治理器属于错误配置，会在插件加载时直接失败并报错。

## 配置

```yaml
- name: '@deepseek-ai/dsh-plugin-budget-governor'
  config:
    maxChildTokens: 200000
    maxConsecutiveToolFailures: 5
    editChurn:
      maxSameFileEdits: 4
      window: 10
      tools:
        - { name: edit, pathArgument: file_path }
```

每个已配置的字段都在加载时被校验：上限必须是范围内的整数（`maxChildTokens >= 1`、`maxConsecutiveToolFailures >= 1`、`editChurn.maxSameFileEdits >= 2`、`editChurn.window >= 2`），`editChurn.window` 必须不小于 `editChurn.maxSameFileEdits`（更小的窗口永远不可能触发），且 `editChurn.tools` 必须非空，其中的 `name`/`pathArgument` 必须非空且不重复。编辑工具名称和路径参数键属于部署相关的词汇，而不是硬编码常量 —— 本仓库的 `dsh-tool-fs` 使用 `edit`/`file_path`，而 MCP 或 ACP 工具集的命名可能不同。

## 执行方式

强制执行只经由既有机制传播；没有新增任何取消接口。触发时会在 `subagent/start` 时解析出的子 `Agent` 上调用 `child.cancel({ kind: 'hook', reason: 'budget-governor: …' })`。这会中止子代理当前活跃的回合，该回合以 `turn/end { kind: 'aborted', reason: { kind: 'hook', … } }` 结束；进程内驱动器将其映射为 `stopReason: 'aborted'`，委托消费者的结算逻辑再将其转换为保留子运行部分输出的 `isError` 工具结果。治理器从不触碰运行句柄本身 —— `dispose()` 的所有权始终属于委托的持有者。

每次运行只终止一次：被触发的运行会被标记，其后续事件将被忽略。检测器求值失败会被捕获，每次运行最多记录一次警告日志，且从不中断会话分发（与 `dsh-compaction-basic` 监听器的处理原则一致）。

## 父级报告

终止发生时，治理器会向父代理注入一条结构化通知（`parent.inject(...)`，来源为 `{ kind: 'plugin', plugin: 'plugin-budget-governor', form: 'notice' }`），父代理通过子会话持久化的血缘关系解析得到（`child.session.header.parentSession` → `ctx.agents.get(...)`）。该通知作为一条普通的 `user/message` 会话事件落入父级日志 —— 对模型可见，且可完全从日志重建，无需新增会话事件类型 —— 驱动器会在父代理下一次预备步骤时读取它，紧跟在该被中止委托自身的 `isError` 工具结果之后。当父代理不再存活时，报告会被丢弃并记录为警告，而不是抛出异常。

## 导出形态

这是一个函数/命名空间插件：导出 `name` / `inject` / `Config` / `apply`，且没有默认导出。误加 `export default` 会导致 Loader 的 `unwrapExports` 折叠该模块并丢失 `inject`（参见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## 模型体验

### 终止报告

#### 模型看到的内容

只要治理器终止了其某个子运行，父模型就会在委托自身的 `isError` 工具结果之后立即收到以下通知。

##### 终止报告

```markdown
A delegated subagent run was terminated by the budget governor.
- child: <childId>
- ceiling: <reason>
The delegation's tool result reports the cancellation and preserves any partial output produced before termination. Do not repeat the same delegation unchanged; revise or split the task before delegating again.
```

#### Token 影响

任何从未触发上限的运行零 token 开销。每个被终止的子运行额外产生一条固定结构的通知，附加在委托自身的 `isError` 结果文本之外。

#### KV 缓存影响

仅追加式写入；通知跟随在可复用的请求前缀之后，不会使已有的 KV 缓存条目失效。

## 已知限制与推迟事项

- **不治理远程运行。** `local: false` 的 `subagent/start`（例如 ACP 提供方）既不暴露可取消的本地 `Agent`，也不追加可观察的本地会话事件；治理器会静默跳过这些运行。若要跨越 ACP 边界扩展治理能力，需要在提供方接口上新增远程取消能力。
- **Token 上限限制的是上下文面，而不是计费花费。** 一个通过大量重复短请求消耗 token 的子运行，会触发失败或编辑抖动上限，而不是 token 上限。
- **本包未附带无密钥快照示例。** 终止报告文本由单元测试和 Loader 组合测试逐字校验；将受治理委托示例接入快照测试框架的工作被推迟。
- **根代理从不受治理**，这是有意为之：只有由子代理生命周期事件宣告的会话才会被跟踪，而根会话从不在其中被宣告。
