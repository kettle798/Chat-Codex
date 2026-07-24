# 运行期事件、审批与缓存保留分析

日期：2026-07-24

## 背景与范围

本项目的聊天、Codex app-server、渠道 adapter 和 TUI 都会维护运行期状态。它们不是同一种“日志”：有些只是正在消费的事件，有些必须等待用户操作，有些只是短时间去重或限流状态。

本次按源码盘点以下范围：

- `src/codex/types.ts` 的全部 `CodexEvent`；
- app-server 的 turn 队列、server request、RPC、session metadata；
- Bridge 的前台/后台 turn、队列、投递、审批、输入和媒体状态；
- 微信、飞书和飞书审批卡片的 adapter-owned 缓存；
- TUI、terminal transcript 和本地 state 文件。

本文是设计和风险记录，**本轮不修改运行时代码**。其中“建议”部分是下一轮实现的验收依据。

## 结论

1. Chat-Codex 不会在自身内存或本地 state 文件中保存完整聊天 transcript。普通 Codex 事件在当前 turn 被消费后即释放；最终回复的权威历史由 Codex 自己维护。
2. **待审批（`status === "pending"`）绝不能因为经过了多少分钟、多少小时或达到条数上限而被自动过期。** 它只能被明确处理、明确取消，或因 app-server 已经不可恢复地失去该请求而显式作废。
3. 已终结审批可以清理。终结包括一次批准、本会话批准、拒绝、`/stop` 取消、app-server 已在另一端解决，以及 app-server 断开后已不能再安全回复该请求。清理的是中间件内存记录，不是把旧审批重新解释成“未处理”。
4. `item/tool/requestUserInput` 是另一种“等待用户”的事件，但它不是权限审批。当前产品明确给它 30 分钟超时，并按空答案回传；不能因为审批不超时，就无意中改变这套问答语义。
5. 当前需要后续收敛的主要增长点不是 TUI 或命令输出，而是 `AppServerTurnController` 的 `closedTurnIds`、`earlyTurnEvents`，以及终结审批/已解决卡片索引的清理链路。

## 事件全貌

`CodexEvent` 是 app-server 原始 notification/server request 经过 adapter 映射后的内部事件，不是永久事件日志。

| 类别 | 事件 | 作用 | 当前保留边界 |
| --- | --- | --- | --- |
| turn 生命周期 | `turn.started` | 标记开始、更新 session status、启动 typing。 | 只存在于活跃 turn。 |
| 上下文 | `context.compaction` | 通知上下文压缩开始/完成。 | 直接投递后不保留。 |
| 过程信息 | `assistant.progress` | reasoning、todo、搜索、命令等进度。 | 经过聚合/去重后投递；每 route 的短缓存会在 turn 结束清除。 |
| 过程信息 | `assistant.commentary` | Codex 旁白。 | 同 progress；仅保留当前 turn 的最后一段，用作没有最终答案时的兜底。 |
| 工具状态 | `tool.progress` | 工具开始/结束状态。 | 直接处理，不保留为历史。 |
| 系统通知 | `codex.notification` | 安全、配置、模型、连接、thread 生命周期等通知。 | 30 分钟去重；状态页每 session 最多保留 5 条近期摘要。 |
| Plan | `assistant.plan` | Plan mode 的计划文本。 | 只放在当前 turn 的 `finalPlanText`，最终合并发送后释放。 |
| 最终回复流 | `assistant.delta` | 最终回复的增量。 | 只累加到活跃 turn 的 `finalText`。 |
| 最终回复流 | `assistant.completed` | 一条最终 assistant 文本完成。 | 覆盖活跃 turn 的 `finalText`，发送后释放。 |
| 审批 | `approval.requested` | Codex 请求命令、文件、网络或权限确认。 | 必须持续保留到明确终结；见下一节。 |
| 审批 | `approval.resolved` | app-server 在另一端已处理审批。 | 将对应待审批转为终结状态。 |
| 中途问答 | `input.requested` | Codex 的 `request_user_input` 短问题。 | 当前有独立 30 分钟超时。 |
| 中途问答 | `input.resolved` | 用户输入已由另一端处理。 | 清掉当前 pending input。 |
| turn 生命周期 | `turn.completed` | 正常结束。 | flush 后删除活跃 turn 状态。 |
| turn 生命周期 | `turn.failed` | 失败结束。 | 投递原错误、flush 后删除活跃 turn 状态。 |

除 `approval.requested` 和 `input.requested` 外，这些事件都不要求用户回消息才能继续。Plan、progress、commentary、工具状态和 delta 只是观测/投递数据，不应被当成持久业务记录。

## 普通 turn 的数据生命周期

前台聊天 turn 的主路径如下：

```text
app-server notification / server request
  -> AppServerTurnController
  -> AsyncEventQueue<CodexEvent>
  -> BridgeRouteQueue
  -> progress/commentary/notification/approval/input 分流
  -> 渠道发送 + terminal transcript/TUI
  -> turn.completed 或 turn.failed
  -> 清空当前 turn、聚合投递状态和 abort controller
```

后台 turn（例如 Goal 自动续跑）不经过当前聊天的前台队列，而是：

```text
AppServerTurnController.createBackgroundTurn()
  -> BridgeBackgroundTurns
  -> 通过 session owner 找回原 route/target
  -> 同一套 delivery / approval / pending input 语义
  -> finishTurn()
  -> 删除该 turn 的 BackgroundTurnState
```

两个路径的最终文本、plan、最后 commentary、命令输出摘要都只属于活跃 turn。`turnQueues.delete(turnId)`、`BridgeBackgroundTurns.turns.delete(turnId)` 和 route worker 的 `finally` 会在正常完成或失败后释放它们。

### 计划、进度和终端可见性

Plan 事件只在协作模式为 `plan` 时额外生成 `assistant.plan`；普通 app-server `turn/plan/updated` 和 plan item 仍可转为 progress。当前微信不投递普通 progress，但 `BridgeProgressDelivery` 会调用 transcript 的本地进度记录，因此终端/TUI 仍可以看到本地过程信息。其他允许 progress 的渠道继续按其 delivery policy 投递。

## 审批：不可按时间过期的硬约束

审批链路当前由三类状态组成：

```text
app-server ServerRequest
  -> AppServerCodexAdapter.pendingApprovals[adapterApprovalId]
  -> approval.requested
  -> ApprovalManager.approvals[approvalKey] (pending)
  -> BridgeDelivery.sendApprovalUntilDelivered()
  -> 文本审批提示或渠道审批卡片

用户 /OK、/P、/NO 或卡片按钮
  -> ApprovalManager.decide()
  -> CodexAdapter.resolveApproval()
  -> app-server response
  -> terminal approval record 可在保留期后清理
```

### 必须保留到何时

待审批不应使用 TTL，也不应使用“最多只留 N 条”直接淘汰。允许使其终结的原因只能是：

1. 用户明确一次批准、会话批准或拒绝。
2. 用户 `/stop` 当前任务。现有实现会调用 `ApprovalManager.cancelRoute()`。
3. app-server 通过 `serverRequest/resolved` 告知该请求已在另一端处理。
4. app-server 或 Bridge 停止、重启、致命断连后，原 JSON-RPC 请求已经没有可回复的连接。此时应显式标记为“已取消/已失效”，不能假装它仍可点击，也不能把它留成可批准的旧授权。

第 4 条不是“按时间过期”。它是请求 transport 和 resolver 已消失后的明确生命周期终结。进程重启后不应尝试恢复旧审批卡片或复用旧 `requestId`，因为它们不再对应一个活着的 app-server ServerRequest。

### 当前实现与这个约束的关系

- `ApprovalManager` 默认不设置 `ttlMs`，因此正常运行路径中 pending approval 不会因时间过期。
- 但 `ApprovalManagerOptions.ttlMs` 仍允许调用方为 pending approval 写入 `expiresAt`，`expireOld()` 也会把 pending 改为 `expired`。这与本节硬约束冲突；后续实现应废弃该 pending TTL 路径，而不是依赖“当前没有配置它”。
- `BridgeDelivery.sendApprovalUntilDelivered()` 已正确做到：只要审批仍是 pending，就持续重试通知；审批被处理后停止重试。
- `ApprovalManager` 当前会一直保留 resolved/expired 记录；它们不会显示在 `/status` 的 pending 列表中，但长期运行会累积。

### 终结审批的保留策略

下一轮建议引入单独的 terminal-record 清理，不复用 pending TTL：

| 状态 | 时间策略 | 清理方式 |
| --- | --- | --- |
| `pending` | 无 TTL、无按数量淘汰。 | 只接受上面的明确终结事件。 |
| `resolved` + `approve` / `approve-session` / `deny` | 可短期保留，用于重复点击提示、运行日志和排障。 | 建议记录 `resolvedAt`，24 小时后删除；再加全局上限作为异常保护。 |
| `resolved` + `cancel` | 同上。 | 保留取消原因，之后按 terminal policy 删除。 |
| 旧 `expired` | 不再由时间把 pending 转入该状态。 | 只作为历史兼容值，按 terminal policy 删除。 |

这类记录目前只在进程内；如果未来需要真正审计，应另建脱敏、可持久化的 audit record，不能把仍可执行的 `raw` approval payload 或 app-server resolver 持久化。

### 审批相关待改进点

1. `AppServerCodexAdapter.handleFatalAppServerError()` 当前会清理 pending input 和 compact waiter、让 turn 失败，但不会同步清理 `pendingApprovals`，也不会通知 `ApprovalManager` 将对应 pending 请求终结。结果可能是一个已无法回复 app-server 的旧审批继续占据 route 的 busy 状态。
2. 飞书审批卡片在卡片点击成功时会删除 card index；但审批如果通过文本命令或 app-server 侧解决，`FeishuApprovalCardController.cards` 没有通用的终结通知来删除对应索引。卡片不会越权，后续点击仍会被 Bridge 拒绝，但内存中会留下无用索引。
3. 正确修复方式是添加通用“审批已终结”生命周期通知：由 Bridge/ApprovalManager 告知 channel adapter 清掉对应卡片引用；不能对仍 pending 的卡片设置任意 TTL。

## 中途用户输入不是审批

`input.requested` 对应 app-server 的 `item/tool/requestUserInput`。它要求用户从选项中回答一个问题，结果是结构化 `answers`，不是允许命令、网络、文件写入等权限动作。

当前 `BridgePendingInputManager` 的语义：

- 每个 route 同时只展示一个问题；同一 turn 的后续问题进入 `queuedByRoute`。
- 默认 30 分钟未回答时，按空答案回传，并提示用户已按“未回答”处理。
- 已处理提示在 `recentlyResolvedByRoute` 保留 60 秒，仅用于避免用户对旧 `/aN` 感到困惑。
- `/stop` 会清掉当前 route 的 pending/queued input。
- secret 和 MCP/app-tool authorization 的兼容路径不会展示给聊天用户授权，而是按未回答/取消处理。

因此，“待审批不超时”只适用于 `ApprovalRequest`。若产品也希望普通问答永久等待，需要单独修改 `codex-request-user-input` 的产品规则、交互提示和阻塞策略，不能和授权审批混为一个状态机。

## 活跃 turn 与协议缓存盘点

| 所有者 | 状态 | 当前清理方式 | 评估 |
| --- | --- | --- | --- |
| `AppServerTurnController.turnQueues` | 活跃 turn 的 queue、final text、progress draft、命令输出摘要、去重集合。 | `closeTurn()` 删除；`closeAll()` / `failAll()` 清空。 | 正常，数据只在活跃 turn 存在。 |
| `AsyncEventQueue.values` | 生产速度超过消费速度时的短队列。 | 消费时 `shift()`，turn close 后不再引用。 | 没有硬上限；它是正确性优先的活跃队列，暂不应草率丢事件。需要在高压场景监控。 |
| `earlyTurnEvents` | notification 先到、`registerTurn()` 后到时的竞态缓冲。 | 注册对应 turn 后删除。 | **缺少 TTL/总量/每 turn 上限**；异常或未知 turn 可无限累积。`closeAll()` / `failAll()` 也未清空它。 |
| `closedTurnIds` | 过滤已结束 turn 的迟到事件。 | 进程停止或 `closeAll()` / `failAll()` 才清空。 | **缺少 TTL/上限**；每个已结束 turn 都会在同一进程中留下一个 ID。 |
| `BridgeBackgroundTurns.turns` | 后台 turn 的 route、target、最终文本和 typing timer。 | `finishTurn()` 删除；普通通知临时 state 也会删除。 | 正常，依赖 app-server 最终事件到达。 |
| `BridgeRouteQueue.queues/workers/abortControllers` | 当前 route 的 prompt 串行队列和取消器。 | worker `finally` 删除空队列和 worker；turn `finally` 删除 abort controller。 | 正常。 |
| `BridgeRouteSteering.states` | 运行中补充消息的 debounce/batch。 | drain 完成或 `/stop` / Bridge stop 后删除。 | 正常。 |
| `AppServerRpcClient.pendingResponses` | 未完成 JSON-RPC 请求。 | 默认请求超时 30 秒；响应、进程停止/错误时清空。 | 有超时和 stop cleanup。 |
| `AppServerCodexAdapter.pendingUserInputs` | 等待 app-server 回答的中途问答 resolver。 | 回答、`serverRequest/resolved`、取消 turn、stop/reload/fatal 时清理。 | 与 Bridge 的 30 分钟交互超时配合。 |
| `compactWaiters` | 当前 session `/compact` 的 Promise/timer。 | 成功、失败、stop/reload/fatal 或默认 10 分钟超时。 | 正常。 |
| `AppServerSessionStore.records/threadToSession` | 当前 app-server 已知 session 的 metadata 和映射。 | reload 时清空；进程生命周期内保留。 | 不保存完整消息；长期运行会按 session 数增长。 |
| `cwdDiagnostics` | 每个 session 最后一次 invalid cwd 诊断。 | 当前没有按 session 清理。 | 数据很小，低优先级；可随 session lifecycle 一并清理。 |
| legacy `ExecCodexAdapter` | 本地 session/policy metadata 与正在运行的子进程句柄。 | 子进程退出后删除 `runningProcesses`；session metadata 随 adapter 生命周期保留。 | 非默认接入，不保存聊天正文；与 app-server 的 server request/approval 缓存不是同一条链路。 |

### 对 turn 缓存的后续收敛建议

1. 给 `earlyTurnEvents` 添加按时间和按数量的保护，例如只保留短暂注册竞态窗口、每 turn 限制事件数、全局限制 turn 数；丢弃时写结构化 warning，不能静默吞掉。
2. 给 `closedTurnIds` 改成带时间戳的有限去重表，例如覆盖迟到 notification 所需的 30 分钟窗口，并设置合理全局上限。
3. `closeAll()` 和 `failAll()` 必须同时清空 early event 缓冲。
4. 新增行为前先给这些状态提供可观测 size 或测试 hook，避免依靠 heap 猜测。

具体阈值应以 app-server 的实测迟到事件窗口决定；上面的时间只说明方向，不应在没有测试的情况下直接硬编码。

## Bridge 投递、route 与交互缓存

| 所有者 | 当前边界 | 评估 |
| --- | --- | --- |
| `BridgeProgressDelivery` | 每 route 最多 3 条待合并文本、20 条 recent 去重文本；turn 收尾会 flush 并 `clearRoute()`。 | 已有明确上限。 |
| `BridgeCommentaryDelivery` | 与 progress 相同：最多 3 条 pending、20 条 recent，turn 收尾清掉。 | 已有明确上限。 |
| `BridgeDelivery` 的失败 suppression map | 进度、commentary、tool 各自记录 60 秒冷却。发送成功会删除。 | 过期 route 如果再也不发送，不会主动 sweep；只保留短字符串，低优先级。 |
| `BridgeNotificationDelivery.recent` | 最近通知按 dedupe key 记录，下一次投递时删除超过 30 分钟的项。 | 有逻辑 TTL，但空闲时不会物理 sweep；低风险。 |
| `MemoryStateStore.recentCodexNotifications` | 每 session 最多 5 条通知摘要，供 `/status` 展示。 | 有明确上限，不是消息历史。 |
| `Bridge.routeMessages/routeTargets` | 每个见过的 route 保留最后一条 `ChannelMessage` 和投递 target，用于后台 turn 找回原聊天。 | 不保存完整对话，但 `raw` 和附件元数据可能随最后一条消息被引用；应在 route 删除/失信或长期不活跃时主动清理。 |
| `routeProgressModes/routeCollaborationModes` | 每 route 的运行期覆盖。 | 量很小，但和 route 生命周期同样没有统一清理入口。 |
| `routeCompactStates` | `/compact` 确认或执行状态。 | 完成/取消时删除。 |
| `PendingMediaManager` | 每 route 最多 5 个附件，10 分钟后过期；消费、取消和 Bridge stop 都会清理。 | 有明确上限和 TTL。 |
| `BridgeStatusText.sessionListStates` | `/sessions` 分页结果最多复用 10 分钟。 | 过期后不再复用，但旧 key 直到同 route 再访问才会被覆盖；低优先级清理项。 |
| `BridgeSessionFlow` 的选择状态 | session/cwd 选择流程。 | 成功、新建或取消时删除；属于短交互状态。 |
| `PairingCodeManager.challenges` | 每 route 一个 10 分钟、最多 5 次尝试的配对码。 | 过期项在校验/该 route 再次创建时删除，没有全局 sweep；不含聊天内容。 |

## 渠道 adapter 缓存

| 渠道 | 状态 | 当前边界 | 评估 |
| --- | --- | --- | --- |
| 飞书 | `seenMessages` | 入站去重 10 分钟；每次新入站消息时清理过期项。 | 有 TTL，空闲时只是不立即物理释放。 |
| 飞书 | `typingReactions` | message id 到 reaction id；成功移除或 adapter stop 时清理。 | 如果删除 reaction 失败，会留到 stop。 |
| 飞书 | 审批卡片 `cards` | 必须保留仍 pending 卡片，以验证消息、聊天、操作者和审批 key。 | 不能用时间 TTL 清 pending 卡片；需要审批终结通知做精确删除。 |
| 飞书 | `seenActions` | 卡片动作去重，按 adapter dedup TTL 清理。 | 正常，空闲时同样按下一次动作 sweep。 |
| 微信 | `typingTickets` | 按账号、收件人、context token 缓存 20 分钟；30 秒可 probe。 | 过期 ticket 读取时会失效，但 map 没有全局 sweep 或 `stop()` clear；低优先级。 |
| 微信 | outbound/typing Promise queue | 串行化发送和 pacing，不保存消息历史。 | 完成后 Promise 链只保留尾部状态。 |

渠道状态属于 adapter-owned state，不应为了清理而把渠道细节放进 Bridge Core。后续统一的只是 approval lifecycle notification，具体卡片/typing/去重缓存仍由各 adapter 自己维护。

## TUI、terminal 与本地文件

### TUI 和 terminal

- `RuntimeLogStore` 只保留最近 300 条 TUI 运行日志，超过后从最旧开始淘汰。
- `ConsoleTranscriptSink` 直接写 stdout，不在内存保存 transcript；单段可见文本默认截到 3000 字符。
- app-server 命令输出摘要只保留 4 行头部、80 行尾部；成功摘要最多 800 字符，失败摘要最多 1600 字符。它随活跃 turn 删除。

因此，当前不需要为“一个模型输出十几 MB”额外设计 TUI 或命令输出机制。它既不是正常模型输出形态，也已有多层可见性/摘要保护。

### 本地持久化

`FileStateStore` 保存 route 身份、渠道/会话绑定、权限策略、上下文指纹、信任和群权限等元数据。`RouteRecord` 没有普通消息正文、assistant 回复正文或完整原始事件，因此它不是聊天历史仓库。

这也解释了为什么待审批不应跨重启“继续可点”：本地 state 没有、也不应保存一个可重新向旧 JSON-RPC ServerRequest 回复的 resolver。

## 分阶段实施建议

### 第一优先级：事件队列防护

1. 为 `earlyTurnEvents` 和 `closedTurnIds` 建立有界、可测试的保留策略。
2. 在 stop/reload/fatal 分支清掉早到事件。
3. 增加单元测试：迟到事件仍被正确过滤、真正的注册竞态仍被正确投递、未知 turn 不会无限增长。

### 第二优先级：审批终结生命周期

1. 移除或禁止 pending approval 的 `ttlMs` 自动过期语义。
2. 为 terminal approval 增加 `resolvedAt` 和仅针对 terminal status 的 prune。
3. app-server fatal/restart 时，将仍 pending 的审批显式取消，并停止审批重试；不能留下可点击但无法回复的授权。
4. 增加通用审批终结通知，让飞书删除文本命令/另一端处理后的卡片索引。
5. 覆盖多个独立 pending approval、长时间未处理、`/stop`、app-server fatal、重启后旧卡片点击等测试。

### 第三优先级：低成本 route/cache 清理

1. route 被删除、解除信任或长期不活跃时清理 `routeMessages`、`routeTargets` 和 transient route overrides。
2. 对 delivery suppression、session list snapshot、微信 typing ticket、配对挑战采用“访问时 sweep + stop 时 clear”的 adapter/module 内部策略。
3. 需要时在 `/debug` 或 TUI 诊断中展示关键 cache size，而不是保存更多内容。

## 明确不做

- 不把完整聊天记录复制到 Chat-Codex 内存或 state 文件。
- 不为 pending approval 设置时间 TTL、数量淘汰或“自动拒绝”。
- 不把普通 `request_user_input` 当作权限审批。
- 不在本轮因理论上的超大输出而重做 TUI 折叠、terminal 截断或命令输出摘要。
- 不用渠道特例绕过通用 approval/session/route 校验。

## 相关源码

- `src/codex/types.ts`
- `src/codex/app-server/turn-controller.ts`
- `src/codex/app-server/turn-store.ts`
- `src/codex/app-server-codex-adapter.ts`
- `src/codex/app-server/rpc-client.ts`
- `src/approvals/approval-manager.ts`
- `src/bridge/route-queue.ts`
- `src/bridge/background-turns.ts`
- `src/bridge/pending-input.ts`
- `src/bridge/progress-delivery.ts`
- `src/bridge/commentary-delivery.ts`
- `src/bridge/notification-delivery.ts`
- `src/bridge/inbound-media.ts`
- `src/channels/weixin/weixin-adapter.ts`
- `src/channels/feishu/feishu-adapter.ts`
- `src/channels/feishu/feishu-approval-card-controller.ts`
- `src/cli/tui/runtime-log.tsx`
- `src/logging/transcript.ts`
- `src/state/memory-state-store.ts`
- `src/state/file-state-store.ts`
