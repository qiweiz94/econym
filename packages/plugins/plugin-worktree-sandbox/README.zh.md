# @deepseek-ai/dsh-plugin-worktree-sandbox

[English](README.md) | 中文

模型可见的 `sandbox_exec` 工具：在隔离的 git worktree（`.dsh/worktrees/subagent-*`）中运行命令，使试运行（trial）的子代理不会触碰主工作树，然后返回试运行的**结构化 git diff** 与命令的退出状态，二者都受输出保留包络（output-retention envelope）约束。

## 功能

在 `ctx.tools` 上注册一个工具：

- `sandbox_exec(id?, command)` 在 `<worktreeRoot>/subagent-<id>` 创建（或复用）一个 detached git worktree，在其中运行 `sh -c <command>`，并返回结构化结果：命令的退出状态与试运行相对基准提交的 `git diff`。默认在调用后移除该 worktree，因此试运行的改动可被丢弃，直到调用者决定把它应用到真实工作树。

结果包含 `exitCode`/`signal`、有界的 `stdout`/`stderr`、有界的 `diff` 与 `diffStat`，以及来自 `git status --porcelain` 的 `changedFiles` 列表。`cleanup: false` 会保留 worktree，使后续使用相同 `id` 的调用继续同一试运行（diff 会累积）。

## 隔离模型

- worktree 通过 `git worktree add --detach <path> <baseCommit>` 从 `baseRef`（默认 `HEAD`）创建，与仓库共享对象库，但拥有独立的工作树与索引。
- 命令以 worktree 为 `cwd` 运行；主工作树与当前分支永不被触碰。
- `cleanup`（默认 `true`）在捕获 diff 后以 `git worktree remove --force` 移除 worktree，丢弃试运行的未提交改动。
- worktree 位于 `<cwd>/.dsh/worktrees/`（可用 `worktreeRoot` 配置），把试运行状态保留在仓库内而非系统临时目录。

## 输出保留包络

命令流与 diff 都以 `maxOutputBytes`（默认 15 KB）为界：

- `stdout`/`stderr` 通过子进程接缝的有界收集（tail 保留，带 `truncated` 标志）。
- `diff` 与 `diffStat` 经过 `@deepseek-ai/dsh-output-retention` 的 `TextRetainer`（`head` 策略）——即输出保留包络——保留的 diff 保留其头部并带精确的省略元数据。

## 导出形态

函数/命名空间插件：导出 `name` / `inject` / `apply`，且**没有**默认导出。多余的 `export default` 会被 Loader 的 `unwrapExports` 折叠并丢掉 `inject`（参见 [docs/postmortem/0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)）。

## 模型体验

### 工具 Schema

#### 模型看到什么

模型看到生成的 [`sandbox_exec` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plugin-worktree-sandbox)：一个可选 `id` 字符串与一个必填 `command` 字符串。插件配置（仓库根、worktree 根、基准 ref、包络大小、超时、清理）在加载时校验，非法值大声失败（例如非正的 `maxOutputBytes`）；它不改动任何 schema 字段，只决定试运行在哪里、如何运行。

#### Token 影响

每次工具可见的请求都有固定的 schema 成本；调用结果随有界的命令输出与 diff 变化（各以 `maxOutputBytes` 为上限）。

#### KV Cache 影响

在定义与可见性不变时前缀稳定。插件生命周期或作用域限制可能使该 schema 的复用失效；试运行本身发生在调用内部，从不进入请求前缀。

## 已知限制与待办

- **依赖 git**——工具会调用 `git`（可用 `gitBinary` 配置）与 `sh`；`cwd` 不是 git 仓库时会在 `git rev-parse` 处大声失败。
- **默认一次性**——`cleanup: true` 每次调用后移除 worktree；持久试运行需要 `cleanup: false` 并保持 `id` 稳定。
- **仅前台**——没有后台/任务模式；长试运行会占用工具调用直到 `timeoutMs`（默认 30 秒）到期。
- **包络边界情形**——大于两倍 `maxOutputBytes` 的 diff 会在 head 包络看到之前被子进程收集做 tail 截断，因此超大的 diff 可能头部与尾部都被丢弃。
- **仅本地文件系统**——worktree 是本地 git worktree；没有远程或共享克隆模式。
