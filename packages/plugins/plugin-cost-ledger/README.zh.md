# @econym/dsh-plugin-cost-ledger

[English](README.md) | 中文

面向模型的 `get_cost_ledger` 工具：按提供方/模型归因当前会话的 token 与估算美元成本，按需从持久日志折叠，并可选地导出 JSONL 供 FinOps 流水线使用。

## 功能

账本将每条已提交的 `assistant/message` 用量记录归因到产生它的提供方/模型对（`message.source`），统计 token 明细（输入、输出、缓存读、缓存写、推理），并按费率表计价。折叠是**派生的，从不存储**：工具每次调用都重新读取会话日志，因此 Harness 重启后会重新计算相同的数字，无需检查点。

## 配置

```yaml
- name: '@econym/dsh-plugin-cost-ledger'
  config:
    pricing:
      ox-alpha-free:
        input: 0.2
        output: 1.2
        cacheRead: 0.05
        cacheWrite: 0.1
    exportPath: /var/log/dsh/cost-ledger.jsonl
```

- `pricing` — 按模型的费率，单位为**每百万 token 的美元**，叠加在内置目录表（DeepSeek Harness `opencode-go` 目录的已发布费率）之上。两者都不覆盖的模型会被计数，但成本显示为 `null`——绝不臆造估算值。
- `exportPath` — 设置后，超出上次导出位置的每个已计价助手步骤都会以一行 JSONL 追加，按持久 `seq` 定位。写入时使用属主权限。

## 输出

`get_cost_ledger()` 返回按模型的请求次数、token 明细和估算花费，以及整个会话的总计。当任何贡献模型未计价时，总计为 `null`——从不把部分总计呈现为完整总计。渲染的文本只省略未测量的数字。

## 已知限制与后续工作

- **仅父会话记账** — 账本只折叠调用会话自身的日志。子运行汇总（将子代理的花费归因到其委托父会话）是后续独立步骤，复用 `dsh-budget-governor` 的 `subagent/start` 模式。
- **估算而非发票** — 成本 = token × 已发布费率。不反映提供方的折扣、促销或协商层级；请将该数字视为上限估算。
- **按模型而非按提供方计价** — 跨路由共享的模型 id 计价相同；若两条路由费率不同，请提供配置覆盖。
- **折叠无缓存** — 每次调用都会重新扫描会话日志；对超大会话而言，每次调用为 O(日志长度)。基于投影的检查点已推迟。
- **JSONL 导出为内存水位** — 上次导出的 seq 在 Harness 重启后重置，因此重启后的进程会重新导出整个日志一次。按设计具有幂等性（行按 seq 定位），但持久水位已推迟。