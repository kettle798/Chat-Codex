# 测试报告：飞书私聊审批卡片

## 测试目标

验证 Codex 待审批请求在飞书私聊中能够发送 interactive 卡片，按钮动作经过身份和 route 校验后复用现有审批状态机；同时验证文本命令与卡片发送失败回退不受影响。

## 测试环境

- 日期：2026-07-24
- 分支/提交：`main` / `0b33dbc`（工作区包含本功能的未提交修改）
- Node.js 版本：`v24.14.0`
- 操作系统：`Darwin 25.5.0 arm64`
- Codex 版本：未调用真实 Codex CLI；审批端使用 `MockCodexAdapter`
- 渠道：假飞书 SDK transport 与 WebSocket EventDispatcher

## 执行命令

```bash
npm run build
node --test dist/tests/unit/feishu-approval-card.test.js dist/tests/unit/feishu-adapter.test.js dist/tests/integration/feishu-bridge.test.js dist/tests/unit/bridge-delivery.test.js
npm test
```

## 测试步骤

1. 构造只允许部分决策的审批请求，检查卡片按钮和稳定 action value。
2. 模拟 `card.action.trigger`，验证 `context`、`open_id` / `user_id`、App ID 和非法决策解析。
3. 通过 FeishuAdapter 模拟私聊发送、正确操作者点击、错误操作者点击、同一路由多张卡乱序点击、跨卡复制 approval key、瞬时处理失败后再次点击，以及群聊发送拒绝。
4. 通过 Bridge + MockCodexAdapter 模拟 `approval.requested -> interactive 卡片 -> 点击通过 -> Codex resolve` 全链路。
5. 模拟 interactive 发送失败，确认 BridgeDelivery 回退为原有 `/OK`、`/P`、`/NO` 文本审批提示。
6. 执行全量测试，检查既有微信、飞书、Bridge、app-server 和 CLI 流程未回归。

## 实际结果

- `npm run build` 通过。
- 飞书卡片定向测试通过：46 项通过，0 项失败。
- `npm test` 通过：508 项通过，0 项失败。
- 私聊卡片支持 `通过一次`、`本会话通过`、`拒绝`；成功后 callback 返回 toast 和无按钮结果卡片。
- 卡片动作要求本进程发送的消息、匹配 chat、匹配审批 key、允许的决策和原始私聊用户；无权限或已失效动作只返回 toast。
- 复制另一张卡的 approval key 到当前卡回调会在 adapter 层被拒绝，Bridge 与 Codex 都不会收到 resolve。
- 卡片发送异常立即回退文本审批提示；Bridge/Codex 瞬时处理异常会释放该点击的去重记录，用户可再次点击或改用文本命令。
- `src/channels/feishu/feishu-adapter.ts` 仍为 739 行，但卡片 JSON/解析已拆至 `feishu-approval-card.ts`，运行时卡片索引、去重和身份校验已拆至 `feishu-approval-card-controller.ts`；拆分理由和后续切分点记录在设计文档。

## 结论

自动化验证通过。飞书私聊审批卡片按通用渠道协议实现，未把飞书 SDK 原始类型泄漏到 Bridge Core，文本审批命令仍可作为完整回退。

## 遗留问题

- 真实飞书应用尚需在事件订阅中启用 `card.action.trigger`，并保持 WebSocket 长连接模式。
- 需要用户在真实飞书私聊中分别验证三个按钮、callback toast、处理后卡片状态，以及长时间待处理后点击。
- 群聊、thread、进度卡片、流式 CardKit 和通用消息编辑不属于本轮范围。
