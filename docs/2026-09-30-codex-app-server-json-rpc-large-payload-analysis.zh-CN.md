# Codex app-server 大型 JSON-RPC 消息解析失败排查

调查日期：2026-09-30
Codex 参考源码基线：`references/openai-codex` 从 `ddf04ad26789d040f9ef6a96736f76602e35a6cc` 更新到 `92bc601ad60542c92bf0bb1e7a2eb70b84ac49d2`
Chat-Codex 分析时提交：`211f31114ded31d075536ecef3038a7ee6cbf6e7`（`main`）
本机观察到的 Codex CLI：`codex-cli 0.159.0`

状态：**已完成源码排查、运行代码修复和自动化验证。**

## 1. 现象与结论

用户看到的错误：

```text
Codex 执行失败: Unterminated string in JSON at position 24831186 (line 1 column 24831187)
```

这个错误不是 Codex 返回的普通 JSON-RPC 业务错误，而是 Chat-Codex 在解析 app-server stdout 的一行 JSON 时，
`JSON.parse()` 发现输入在一个 JSON 字符串中途结束。位置 `24,831,186` 是 JavaScript 字符串位置，不严格等于
字节数；如果内容主要是 ASCII，它约等于 23.7 MiB。

已确认：

1. 默认 app-server 接入的直接抛出点在 `src/codex/app-server/rpc-client.ts` 的 stdout 读取循环。
2. 25,000,000 字符的**合法**单行 JSON 可被当前 Node.js 的 `readline + JSON.parse` 正常处理，因此这不是
   Node 对 24 MiB 左右 JSON Lines 的固定上限。
3. 修复前 Chat-Codex 有两条会无上限请求完整历史的路径，会把长会话放大成超大单行 JSON-RPC 响应。
4. 最新 Codex 协议已经把完整历史 hydration 标为 deprecated，并提供了按页读取的替代方案。

尚不能仅凭这一条用户可见错误确认：到底是哪一个 app-server 输出字段含有截断内容，或 stdout 为何会出现
不完整帧。修复后的客户端仅保存经过脱敏和长度限制的传输诊断，不保存原始帧，因此不能把“高概率触发因素”
误写成“已证明的根因”。

## 2. 本地错误链路

默认运行方式为 `codex app-server --listen stdio://`。`AppServerRpcClient` 的流程是：

```text
codex app-server stdout
  -> node:readline 按换行拆帧
  -> JSON.parse(trimmed)
  -> JSON-RPC response / server request / notification 分发
  -> AppServerCodexAdapter
  -> route queue
  -> "Codex 执行失败: ..."
```

对应代码：

- `src/codex/app-server/rpc-client.ts`：启动子进程、按行读取 stdout、解析 JSON-RPC，并维护进程 generation。
- `src/codex/app-server/rpc-client.ts`：`JSON.parse()` 失败会走统一的 fatal transport 路径，结束当前进程并
  reject 所有 pending RPC。
- `src/bridge/route-queue.ts:199-205`：将上游异常包装成渠道里的 `Codex 执行失败: ...`。

渠道文案继续保留 V8/Codex 的原始解析提示；额外的触发 RPC、子进程 pid、stdout 行长度、退出码和有限 stderr
尾部只写本地运行日志，避免泄露整段聊天或工具输出。

`exec` adapter 也有独立的 JSON 行解析器（`src/codex/exec-codex-adapter.ts`），但它不是默认模式；复现时
应先确认启动配置实际使用的是 `app-server` 还是 `exec`，不能混用两条链路的结论。

## 3. 最新 Codex 协议与上游实现

官方 app-server 文档规定客户端和 app-server 通过 stdin/stdout 交换 newline-delimited JSON，并在
`initialize` 后驱动 `thread/start`、`turn/start` 等 RPC。见
[Codex app-server 官方文档](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。

更新后的参考源码中：

- `codex-rs/app-server-transport/src/transport/stdio.rs` 由单独 stdout writer 将每条出站消息序列化后写入
  stdout，再追加一个换行。
- `codex-rs/app-server-transport/src/transport/mod.rs` 使用 `serde_json::to_string` 序列化出站 JSON-RPC
  消息；正常情况下字符串中的换行和引号应被 JSON 转义，不能把一条消息拆成多行。
- `codex-rs/app-server-protocol/src/protocol/v2/thread.rs` 明确说明：
  `thread/read(includeTurns: true)` 的完整历史 hydration 已过时；客户端应使用 metadata-only 读取，再用
  `thread/turns/list` 和 `thread/items/list` 分页。
- 同一协议中 `thread/resume.excludeTurns: true` 可让恢复响应只返回 thread 元数据和运行态，不把完整
  `thread.turns` 塞进一次响应。

因此，正常 app-server 不应主动产生语法错误的 JSON 帧。此次错误意味着实际收到的 stdout 帧不完整、被非协议
内容污染，或使用中的二进制在写出过程中异常中断。仅查看最新源码不能证明安装中的 `codex-cli 0.159.0` 与该
参考 commit 完全同构，也不能还原当时那一帧的原始内容。

## 4. 高概率触发因素：完整历史被一次性回传

### 4.1 `thread/resume` 默认携带完整 turns

修复前，`src/codex/app-server-codex-adapter.ts` 的 `loadSessionFromServer()` 调用 `thread/resume` 时没有传
`excludeTurns: true`。

最新协议中该字段默认是 `false`，即恢复响应会包含 `thread.turns` 的完整历史。长会话中的用户消息、工具项、
命令输出、媒体元数据和 assistant 消息会合并到同一条 JSON-RPC response。恢复已有 session、外部上下文刷新、
或某些 session 重新加载流程都会经过这里。

### 4.2 上下文刷新为取最后回复读取了整段历史

修复前，`reloadSession()` 随后调用：

```text
thread/read { threadId, includeTurns: true }
```

目的是从全部 `thread.turns[].items[]` 中倒序挑出最后一条最终 assistant 回复。这个需求本身只需极少量最新
数据，但当前实现会要求 app-server 再发送整个会话历史。

`/context-refresh` 内置默认是 `off`。只有用户或全局配置启用了 `reload`，且检测到外部上下文更新时，才会走
这条额外读取路径；但 `thread/resume` 的全量历史问题不依赖该开关。

### 4.3 其它可能的超大字段

正常运行期间，`item/completed` 的 `commandExecution.aggregatedOutput`、大型 MCP 工具结果或附件相关字段也可能
让单条 notification 很大。最新 Codex 对常规 shell/unified exec 输出通常有 1 MiB 级别保留上限，但这不等于
所有工具、历史项目或显式关闭输出上限的路径都不会产生更大数据。

综合判断：**全量历史响应是最有力、可由当前代码直接消除的放大因素；它解释了为什么会出现 24 MiB 量级的单帧，
但不能单独证明 JSON 字符串未闭合的最终原因。**

## 5. 已排除与不能假定的结论

| 项目 | 结论 | 依据 |
| --- | --- | --- |
| Node.js 只能解析约 24 MiB 的 JSON 行 | 已排除 | 本地以同一 `readline + JSON.parse` 链路验证了 25,000,000 字符的合法 JSON。 |
| 这是一个正常的 Codex JSON-RPC `error` response | 已排除 | 正常 error response 本身仍是可解析 JSON；本次错误发生在解析之前。 |
| 更新参考源码本身已经修复线上二进制 | 不能假定 | 更新的是本地参考 clone，不会替换已安装的 Codex CLI。 |
| 完整历史一定就是损坏字段 | 不能假定 | 当前没有保存原始帧的受限诊断，无法确认具体 method、字段和子进程状态。 |
| 重试原任务可以安全恢复 | 不能假定 | `turn/start`、审批回复和工具执行可能已经被 app-server 接收；盲目重发可能重复执行。 |

## 6. 已实施修复

### 6.1 把解析失败当作 transport fatal error

1. `AppServerRpcClient` 现在为每个 app-server generation 保存受限的诊断：最多 8 个最近请求的 method/id、
   pending 请求、stdout 行字符数、pid、退出码/signal、发生时间和最多 8 KiB stderr 尾部。
2. `JSON.parse()` 失败、stdin/stdout 关闭、子进程 error 或 exit 均进入同一 fatal 路径：关闭 reader、废弃子进程、
   reject pending RPC，并使所有活跃 turn 发出 `turn.failed`。不会保存 raw stdout JSON。
3. `AppServerCodexAdapter` 收到 fatal 后清理 app-server 侧 pending approval/input、终止 compact waiter、让
   Bridge 按 session + turn 精确撤销聊天端审批/input，并保留渠道中的原始错误，例如
   `Unterminated string in JSON ...`。
4. 不自动重放 `turn/start`、`turn/steer`、审批决策、`writeStdin` 或任何可能已有副作用的 RPC。下一条新的
   聊天消息才会启动新进程。
5. 新进程中的已知 session 会先执行轻量 `thread/resume({ excludeTurns: true })`，再执行新的 `turn/start`；
   因此恢复的是同一个 Codex thread，不是新建会话或丢失上下文。

### 6.2 去掉无上限历史读取

1. `thread/resume` 一律传 `excludeTurns: true`，只恢复本次运行所需的 session 配置和状态。
2. “刷新后投递最后一条最终回复”现在按页读取：
   - `thread/turns/list` 请求最新少量 turn，`sortDirection: "desc"`、`itemsView: "notLoaded"`；
   - 对候选 turn 使用 `thread/items/list`，按 `desc` 小页读取；
   - 只选择 `agentMessage` 且不是 `commentary` 的最后一项；找到即停止；
   - 固定最多 2 个 turn 页、每页 4 个 turn；每个 turn 最多 2 个 item 页、每页 16 个 item，超出预算就不补投旧回复。
3. 如果 app-server 不支持分页方法，刷新本身仍成功，只是不返回 `lastAssistantMessage`。不为了兼容而静默
   回退到无上限 `thread/read(includeTurns: true)`。
4. `thread/read(includeTurns: false)` 仍用于 session detail 等 metadata-only 场景。
5. 若运行中的 Codex app-server 连 `excludeTurns` 都不支持，Chat-Codex 会保留其原始协议错误，而不是改用会重新引入
   超大帧风险的 legacy full-history 回退。当前版本需要使用支持 `experimentalApi` 的新版 Codex app-server。

这套改动属于 Codex adapter 层，对微信、飞书和未来 ChannelAdapter 一视同仁，不改变 Codex thread 的实际上下文。

### 6.3 自动化验证

已覆盖：

1. 合法 25 MiB JSON Lines 通过同一 `readline + JSON.parse` 链路。
2. fake app-server 输出未闭合 JSON 时，活跃 turn 失败、诊断记录行长度、进程被废弃。
3. 下一条新任务启动新进程、先恢复同一 session，再执行 `turn/start`；失败任务只执行一次。
4. session resume 带 `excludeTurns: true`。
5. 分页历史正确跳过 commentary；分页 API 不可用时不读取完整历史。
6. 失败 turn 只撤销它自己的 approval 和 pending input，不清空同 route 的其它 turn。

真实环境再次出现时，只需记录发生时间、adapter 模式、session id、触发动作、CLI 版本和终端受限诊断摘要；不要导出完整聊天、
命令输出或原始 stdout 帧。

## 7. 运行行为与限制

1. 本次不能也不应让损坏的上游 JSON 变成可解析数据；修复的目标是避免它卡死整个 bridge、放大历史读取或自动重复副作用。
2. 当前 turn 一旦收到坏 JSON 会失败。用户应先检查工作目录、Git 状态和输出文件，再决定是否发送新的后续任务。
3. 新消息会恢复同一 session 后继续，正常对话、审批、工具调用和真实 Codex 上下文不会因为桥接恢复被替换为新 session。
4. `thread/turns/list` / `thread/items/list` 不支持时只跳过“刷新后的最后回复”增强；不回退 full-history。`excludeTurns`
   也不支持的旧 app-server 则需要升级，避免重新暴露本次的超大帧风险。

## 8. 本轮范围

本轮完成：更新本地官方 Codex 参考源码、实现 transport fatal/recovery 与受限诊断、迁移到分页历史、精确清理失败 turn 的
审批/input、补充单元和 fake app-server 回归测试。没有修改用户的 Codex CLI 安装，也没有自动重试或重放任何 Codex turn。
