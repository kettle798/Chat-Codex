# 飞书私聊审批卡片设计

## 目标

在不改变 Chat-Codex 统一审批状态机的前提下，为飞书私聊的 Codex 审批请求提供可点击卡片：

- `通过一次` 对应 `/OK` 和 `approve`。
- `本会话通过` 对应 `/P` 和 `approve-session`。
- `拒绝` 对应 `/NO` 和 `deny`。

卡片是飞书私聊的附加交互，不替代现有文本命令。微信、终端、未来 Slack/Telegram 等未实现卡片的渠道继续使用原有文本审批提示。

## 范围与非目标

本轮只实现：

- 飞书 `p2p` 私聊。
- Codex command、file change、permissions 等现有 `ApprovalManager` 请求。
- `card.action.trigger` WebSocket 回调。
- 回调 toast 和已处理卡片的即时替换。
- 卡片发送失败时自动回退为原有文本审批提示。

本轮不实现：

- 飞书群聊、thread 或跨聊天审批。
- 通用消息编辑、进度卡片、流式卡片或 CardKit 状态持久化。
- 用户 OAuth、飞书工具或 OpenClaw runtime。
- 替代 `/OK`、`/P`、`/NO` 文本命令。

`ChannelCapabilities.messageUpdate` 继续为 `false`：本功能使用飞书卡片动作回调返回的即时卡片结果，不声明通用消息更新能力。

## 链路

```text
Codex app-server approval.requested
  -> ApprovalManager.create(route, requestedBy, request)
  -> BridgeDelivery.sendApprovalUntilDelivered()
  -> ChannelRegistry.sendApprovalRequest()
  -> FeishuApprovalCardController.send()
  -> im.message.reply/create(msg_type=interactive)

用户点击按钮
  -> EventDispatcher("card.action.trigger")
  -> FeishuApprovalCardController.handle()
  -> ChannelRegistry.onApprovalAction()
  -> Bridge.handleChannelApprovalAction()
  -> ApprovalManager.decide() + CodexAdapter.resolveApproval()
  -> toast + 已处理卡片
```

Bridge 不 import 飞书 SDK 或飞书原始事件类型。飞书 adapter 只把已验证的卡片动作转换为通用 `ChannelApprovalAction`，再把 Bridge 的通用处理结果渲染成飞书 callback 响应。

## 通用协议

`src/protocol/channel.ts` 增加可选审批交互契约：

```ts
interface ChannelAdapter {
  sendApprovalRequest?(target, approval): Promise<SendResult>;
  onApprovalAction?(handler): void;
}
```

`ChannelApprovalRequest` 是卡片展示所需的脱离 adapter 的数据：审批 key、route、发起人、类型、session/turn、命令、原因、风险和允许的处理方式。通用卡片决策只包含 `approve`、`approve-session`、`deny`；内部 `cancel` 不展示为按钮。

`ChannelRegistry` 负责把 adapter 注册的动作交给 Bridge，并再次校验 `channelId` 与 conversation capability。没有 `sendApprovalRequest` 的 adapter 返回 `undefined`，由 `BridgeDelivery` 自动走文本提示。

## 飞书卡片与回调

待处理卡片使用标准 `interactive` 消息，包含审批信息、三个可用按钮和文本命令兜底提示。按钮 `value` 只携带：

```json
{
  "action": "chat_codex_approval",
  "approvalKey": "a001",
  "decision": "approve"
}
```

卡片回调的处理顺序：

1. 校验 `app_id`（存在时必须匹配当前 app）。
2. 从 `context.open_message_id` / `context.open_chat_id` 读取卡片消息与 chat；兼容顶层字段回退。
3. 从 `operator.open_id` 读取操作者；缺失时兼容 `operator.user_id`。
4. 卡片消息必须是当前运行实例发出的待审批私聊卡片。
5. `chat_id`、审批 key 和按钮决策必须与保存的卡片记录匹配。
6. 操作者必须等于该卡片原始私聊的 `recipient.id`；Bridge 再校验 `PendingApproval.requestedBy`。
7. 卡片动作按 `messageId + operator + approvalKey + decision` 做 TTL 去重，避免飞书重投导致二次批准。
8. Bridge 成功处理后返回 success toast 和无按钮的结果卡片；拒绝、过期或校验失败只返回 toast，不修改原卡片。

这两层身份校验避免仅凭按钮 value 或 chat id 处理审批。`user_id` 与原始入站 `open_id` 无法在本地安全换算时会被拒绝，用户仍可发送文本 `/OK`、`/P` 或 `/NO`；不会为了兼容而放宽审批人校验。

## 失败与恢复

### 出站

- 飞书 adapter 未实现卡片、卡片构造失败或 interactive 发送失败：立即发送原有文本审批提示。
- 文本发送也失败：沿用审批通知重试，直到消息成功送达或审批已被处理。
- terminal transcript 仍记录完整审批内容，便于定位渠道侧卡片问题。

### 入站

- 卡片点击处理成功时，飞书 UI 会显示 toast 并替换为已处理状态。
- 未订阅回调、网络异常或卡片在当前进程重启后失去运行时记录时，文本命令是兜底路径。
- `ApprovalManager` 默认不设置 TTL；审批本身不会因为长时间未操作而过期。当前 app-server pending request 和卡片索引均为运行时状态，重启后不能承诺恢复旧卡片的点击处理。

### 飞书应用配置

真实环境需要在飞书自建应用的事件订阅中启用 `card.action.trigger`，并保持 WebSocket 长连接模式。已有机器人发送消息权限仍用于发出 interactive 卡片；本轮不新增公网 webhook 服务。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `src/protocol/channel.ts` | 通用审批卡片发送/动作协议。 |
| `src/approvals/channel-approval.ts` | `PendingApproval` 到通用卡片请求的纯转换。 |
| `src/bridge/approval-resolution.ts` | ApprovalManager 与 CodexAdapter 的统一 resolve。 |
| `src/bridge/approval-actions.ts` | 私聊审批人、route 和可用决策校验。 |
| `src/channels/feishu/feishu-approval-card.ts` | 飞书卡片 JSON、动作解析和 callback 渲染纯函数。 |
| `src/channels/feishu/feishu-approval-card-controller.ts` | 已发送卡片索引、动作去重、飞书身份校验和事件转换。 |
| `src/channels/feishu/feishu-adapter.ts` | SDK 生命周期、消息发送、WebSocket 注册和 controller 调用。 |

`feishu-adapter.ts` 仍超过 600 行，但它保留的是同一渠道连接状态机的生命周期、入站消息、媒体、typing、状态映射和 SDK transport 编排；卡片的纯协议和可变卡片状态已分别抽出。若后续再加入 thread、群聊或更多 SDK transport，优先继续拆分 transport/lifecycle，而不是把状态散落进 Bridge。

## 验收

自动化覆盖：

1. 卡片按钮与 action value 构造。
2. `open_id` / `user_id` 回调解析、app id 和非法决策拒绝。
3. adapter 私聊发送、操作者校验、群聊拒绝和 callback 结果。
4. 同一私聊多张待审批卡乱序点击时，各自按 approval key 处理。
5. 复制另一张卡的 approval key 到当前卡回调时必须拒绝，不能进入 Bridge resolve。
6. Bridge 到 Feishu adapter 的 `approval.requested -> card click -> Codex resolve` 集成链路。
7. interactive 发送失败时回退文本审批提示。

真实飞书私聊补测应确认：

1. `card.action.trigger` 已订阅且按钮可回调。
2. 三个按钮分别映射到一次批准、本会话批准、拒绝。
3. 卡片成功后显示 toast 和无按钮结果。
4. `/OK`、`/P`、`/NO` 仍能处理同一类审批。
5. 长时间未处理的审批在进程持续运行时仍可点击。
