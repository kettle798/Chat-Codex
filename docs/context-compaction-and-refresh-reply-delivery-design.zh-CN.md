# 上下文压缩与刷新回复投递设计

日期：2026-07-24

## 背景

Chat-Codex 已经能处理 Codex app-server 的 `contextCompaction` item，也能在下一次聊天消息发送前检测本机 session 是否被外部 Codex CLI 更新。

此前两条链路都有可见性缺口：

1. 自动上下文压缩被映射为普通 `assistant.progress`。微信默认不投递 progress，因此用户不知道当前 session 正在压缩或已经完成。
2. `/context-refresh reload` 检测到外部更新后只提示“已重新加载”。用户在终端 Codex 中刚获得的最后一条最终回复没有同步到该 session 绑定的聊天渠道。

本设计补齐这两个缺口，同时不把渠道差异泄漏到 Codex adapter。

## 目标

1. Codex 自动压缩上下文时，向对应 route 的聊天渠道可靠投递开始和完成通知。
2. 在 `reload` 模式检测到外部 session 更新后，将可恢复的最后一条最终 assistant 回复发送到该 route，再继续投递用户的新消息。
3. 微信的 progress 禁用策略不能吞掉以上两类消息。
4. 不增加定时扫描、跨 route 广播、原始 reasoning 投递或新的聊天命令。

## 非目标

- 不改变 `/compact` 的确认、执行和完成文案。
- 不让 `detect` 模式读取或同步历史回复；它仍只提醒，不重载。
- 不把 Codex commentary、reasoning、tool 输出或历史中任意旧消息批量转发到聊天渠道。
- 不在本次实现中为 legacy `codex exec` JSONL 格式写另一套历史解析器。

## 自动压缩投递

### 事件边界

新增中间件内部事件：

```ts
{ type: "context.compaction", sessionId, turnId, phase: "started" | "completed" }
```

`AppServerTurnController` 在 app-server 的 `item/started` 和 `item/completed` 收到 `contextCompaction`（兼容 `context_compaction`）时生成该事件。

这不是普通 `assistant.progress`，也不是把 app-server 的原始 notification 直接暴露给渠道。它表达的是已验证的业务状态，因此应独立于用户设置的 `/progress` 模式。

### 前台与后台 route

```text
当前聊天 turn
  item/started contextCompaction
  -> context.compaction started
  -> BridgeRouteQueue
  -> BridgeDelivery.sendText(target, "Codex 正在压缩当前会话的上下文。")

后台 turn（例如 Goal）
  item/completed contextCompaction
  -> context.compaction completed
  -> BridgeBackgroundTurns
  -> BridgeDelivery.sendText(target, "Codex 已完成当前会话的上下文压缩。")
```

后台 turn 的 target 仍通过 session owner 找到原始 route；找不到 route/target 时只记录运行日志，绝不广播到其他聊天。

### `/compact` 去重

`/compact confirm` 已由命令处理器主动发送“已开始”和“完成”反馈。该命令在 app-server 内部同样会产生 `contextCompaction` item。

因此 `BridgeBackgroundTurns` 在同一 route/session 的 compact command 状态为 `running` 时，不重复投递内部事件；命令自己的反馈是唯一用户可见结果。自动压缩和 Goal 后台压缩不处于该命令状态时照常投递。

若压缩失败，Codex 的 `turn.failed` 仍沿用既有错误投递，不把失败伪装成“完成”。

## 外部上下文刷新后的最后回复

### 触发条件与顺序

只在当前 route 的有效 `/context-refresh` 策略为 `reload`，并且 session 指纹明确比 Chat-Codex 快照更新时触发：

```text
用户发送新消息
  -> SessionContextRefreshManager 读取本机 fingerprint
  -> 发现外部更新
  -> reloadSession(sessionId)
  -> 更新 Chat-Codex snapshot
  -> 向当前 route 发送刷新提示和最后一条最终回复
  -> 执行用户刚发的新 prompt
```

该消息在 task-start 和新 turn 之前发送，保证用户先看到终端侧已完成的上下文，再看到 Chat-Codex 对新输入的后续执行。

### app-server 读取规则

`AppServerCodexAdapter.reloadSession()` 在成功 `thread/resume` 后调用官方 app-server 请求：

```text
thread/read { threadId, includeTurns: true }
```

从 `thread.turns` 倒序遍历 `items`，取第一条：

- `type === "agentMessage"`
- `text` 非空
- `phase !== "commentary"`

返回值写入 `CodexSessionReloadResult.lastAssistantMessage`。这保留了协议边界：历史结构只在 app-server adapter 解析，Bridge 只处理一个可选的最终文本。

渠道消息形式为单条合并文本：

```text
检测到本机 Codex session 上下文已更新，已在发送前重新加载。
Session: <id>

当前 session 最后一条回复：

<最后一条最终 assistant 回复>
```

若历史读取失败、app-server 较旧不支持该读取、或历史中没有最终回复，reload 仍然成功，只发送既有刷新提示。历史回读是增强项，不能阻断用户的新消息。

### adapter 兼容性

`CodexSessionReloadResult.lastAssistantMessage` 是可选字段。

- 默认 `AppServerCodexAdapter` 通过官方 `thread/read(includeTurns: true)` 支持恢复。
- 不提供该字段的 adapter 保留原来的 reload 行为和提示，不伪造回复。
- 这避免 legacy exec adapter 对 Codex rollout JSONL 内部格式形成不稳定耦合；若未来需要 parity，应单独为 JSONL 解析建立版本化测试。

`thread/read` 在协议能力清单中从候选项调整为 adapter 已处理项，因为项目已用它读取 session detail 和刷新后的最终回复。

## 渠道与日志语义

| 内容 | 是否受 `/progress` 影响 | 微信 | 飞书/其他渠道 | 终端 transcript |
| --- | --- | --- | --- | --- |
| `context.compaction` 开始/完成 | 否 | 投递 | 投递 | 作为普通 outbound 记录 |
| 刷新提示 | 否 | 投递 | 投递 | 作为普通 outbound 记录 |
| 恢复的最后回复 | 否 | 投递 | 投递 | 作为普通 outbound 记录 |
| 普通 `assistant.progress` | 是 | 默认本地记录、不投递 | 按渠道 policy 投递 | 保留本地可观测性 |

这里的“可靠”指它们走 `BridgeDelivery.sendText()`，不走 progress cooldown、聚合或静默策略；渠道自身网络重试和发送失败处理仍由 adapter/delivery 层负责。

## 安全与路由约束

- 只向拥有该 session 的当前 route 投递，不跨聊天、群聊或账号广播。
- 只选择最终 assistant message，明确跳过 commentary，避免将 Codex 原始工作旁白误发到聊天渠道。
- 不读取或展示原始 reasoning、tool output、审批内容、密钥或完整历史。
- 刷新仍是发送前的惰性检查，不启动后台轮询，不改变两个 Codex 进程同时写 session 时的并发边界。

## 测试要点

1. app-server history mapper 从倒序 turns/items 选择最后一条最终回复，并跳过 commentary。
2. fake app-server 验证 `reloadSession()` 真实调用 `thread/read(includeTurns: true)` 并返回回复。
3. `SessionContextRefreshManager` 保留该可选回复。
4. route queue 在下一条 prompt 前发送刷新文本和回复。
5. `context.compaction` 在 progress 被抑制时仍投递。
6. 微信 silent progress 模式下仍收到上下文压缩开始和完成消息。

## 后续边界

- 若 Codex app-server 为 `thread/read` 增加分页、历史截断或新的 message phase，需要先更新 mapper 测试，再调整选择规则。
- 若未来支持 shared app-server 或远程 host，应由共享 runtime 提供 event/ownership，不能靠本机 session 文件扫描补偿。
- 如果需要将终端 Codex 的多轮历史批量同步到聊天，应单独设计显式命令和去重游标；本设计只处理一次外部更新后的最后最终回复。
