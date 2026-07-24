# 测试报告：上下文压缩与刷新回复投递

日期：2026-07-24

## 测试目标

验证以下行为：

1. Codex 自动 `contextCompaction` 不再被当作普通 progress，能够投递到当前 route 的聊天渠道。
2. 微信 silent progress 模式下仍会收到上下文压缩开始和完成通知。
3. `/context-refresh reload` 检测到外部 session 更新后，app-server 能恢复最后一条最终 assistant 回复，并在下一条 prompt 前投递到对应渠道。
4. commentary 不会被误当作最后回复。
5. 历史读取失败不会阻断 session reload 或用户的新消息。

## 测试环境

- 分支：`main`（本地尚有待提交改动）。
- Node.js：`v24.14.0`。
- 操作系统：`Darwin 25.5.0 arm64`。
- Codex CLI：`0.145.0`。
- 渠道：mock；包含 Weixin-like delivery policy。
- app-server：测试中的 fake stdio JSON-RPC server。

## 实现范围

- 新增 `CodexEvent` 的 `context.compaction` 事件，由 app-server `contextCompaction` item 生成。
- `BridgeRouteQueue` 和 `BridgeBackgroundTurns` 通过普通 `sendText` 投递压缩开始/完成通知，不受 `/progress` 抑制。
- `/compact confirm` 运行期间抑制后台相同 item 的重复通知，保留命令自身的反馈。
- `AppServerCodexAdapter.reloadSession()` 在 `thread/resume` 后读取 `thread/read(includeTurns: true)`；`thread-history.ts` 从倒序 history 中选择最后一条非 commentary 的 `agentMessage`。
- `SessionContextRefreshManager` 将可选 `lastAssistantMessage` 传给 route queue；route queue 在启动下一条 turn 前合并发送刷新提示和该回复。

## 执行命令

```bash
npm run build
node --test dist/tests/unit/app-server-mappers.test.js
node --test dist/tests/unit/app-server-codex-adapter.test.js
node --test dist/tests/unit/context-refresh-manager.test.js dist/tests/unit/bridge-route-queue.test.js
node --test dist/tests/integration/bridge-mock.test.js
npm test
git diff --check
```

## 实际结果

```text
npm run build: passed
app-server mapper 定向测试: 13 passed, 0 failed
app-server adapter 定向测试: 38 passed, 0 failed
context refresh + route queue 定向测试: 20 passed, 0 failed
Bridge mock 集成测试: 111 passed, 0 failed
npm test: 493 passed, 0 failed
git diff --check: passed
```

定向覆盖重点：

- `thread/read(includeTurns: true)` 返回 commentary 和 final answer 时，只恢复 final answer。
- progress 被关闭时，`context.compaction` 仍发送开始/完成消息。
- Weixin-like channel 的 silent progress 模式不发送普通 progress，但发送上下文压缩通知。
- 刷新提示和“当前 session 最后一条回复”在 task-start 之前发送。

## 代码规模审计

现行规范见 `docs/development-and-test.zh-CN.md`：

- `300–400` 行是职责 review 触发点，不是硬性禁止。
- 超过 `600` 行的业务文件默认应拆分；若仍保留，必须有内聚理由、拆分记录或后续切分点。
- 不允许为了降行数把强相关逻辑切成隐式共享状态或循环依赖的小碎片。

本次审计时，`src/` 超过 `600` 行的业务文件如下：

```text
1169 src/codex/app-server-codex-adapter.ts
 954 src/channels/weixin/weixin-adapter.ts
 925 src/state/file-state-store.ts
 750 src/bridge/bridge.ts
 732 src/cli/actions/launcher-actions.ts
 726 src/cli/tui/views.tsx
 699 src/bridge/session-flow.ts
 692 src/channels/feishu/feishu-adapter.ts
 652 src/bridge/formatters.ts
 633 src/bridge/status-text.ts
```

另有 `19` 个 `src` 文件位于 `300–600` 行的 review 区间。测试文件不适用同一业务职责阈值，但较大的测试文件也应按 fixture/场景边界持续整理。

本次没有为满足数字阈值硬拆上述模块：新增的 history 选择与 app-server 回读已独立放在 `src/codex/app-server/thread-history.ts`，压缩通知文案放在 `src/bridge/context-compaction.ts`。`app-server-codex-adapter.ts`、`bridge.ts` 的既有拆分方向分别记录在 `docs/app-server-codex-adapter-refactor-design.zh-CN.md` 和 `docs/bridge-modularization-design.zh-CN.md`；其余超过 `600` 行的文件应在各自有新职责进入时按 adapter、状态持久化、CLI action、TUI view、formatter 边界逐步拆分。

## 真实渠道验证

未进行真实微信或飞书登录态测试。用户登录后应验证一次：在微信静默进度模式下触发实际 Codex 自动上下文压缩，确认仅出现压缩通知、最终回复和错误等应投递内容，不出现普通 progress 刷屏。

## 结论

通过。自动压缩和外部上下文刷新后的最终回复均走 route 级普通文本投递，微信 progress 限制不会抑制它们；现有全量回归测试保持通过。
