# 测试报告：Codex app-server 重连提示独立通知

## 测试目标

验证 `Reconnecting... n/m` 能从普通 app-server transient error 中结构化识别出来，并在最后一次重连尝试时额外产生 `codex.notification kind=connection`，让微信/飞书等聊天渠道走通知链路，而不是只受普通进度模式控制。

## 测试环境

- 日期：2026-06-14 13:10:32 CST
- 分支/提交：`main` / `315b0b1`
- Node.js 版本：`v24.14.0`
- 操作系统：macOS
- Codex 版本：本仓库 fake app-server / mock channel 测试
- 渠道：mock / app-server fake process

## 执行命令

```bash
npm run build
node --test dist/tests/unit/app-server-mappers.test.js dist/tests/unit/app-server-codex-adapter.test.js dist/tests/unit/bridge-route-queue.test.js
npm test
```

## 测试步骤

1. 新增 `parseAppServerReconnectNotice()`，验证 `Reconnecting... 1/5`、`Reconnecting... 5/5` 能解析出 attempt/total。
2. 保留 `isTransientAppServerError()` 兼容旧判断，并验证非法 attempt 不再被识别为 transient reconnect。
3. 使用 fake app-server 发送 `Reconnecting... 1/5`，验证仍只产生普通 `assistant.progress`，不导致 `turn.failed`。
4. 使用 fake app-server 发送 `Reconnecting... 5/5`，验证除普通 progress 外，额外产生 `codex.notification kind=connection`。
5. 使用 `BridgeRouteQueue` 验证普通进度被 silent/suppressed 时，`kind=connection` 的 notification 仍会投递到 channel。
6. 执行全量测试确认没有影响现有微信、飞书、Bridge、TUI 和 app-server 行为。

## 实际结果

定向测试通过：

```text
tests 57
pass 57
fail 0
```

全量测试通过：

```text
tests 477
pass 477
fail 0
```

关键覆盖：

- `app-server notification helpers map progress and errors`
- `AppServerCodexAdapter keeps running across transient reconnect notifications`
- `AppServerCodexAdapter emits connection notification on final reconnect attempt`
- `BridgeRouteQueue delivers connection notifications even when normal progress is silent`

## 结论

通过。`Reconnecting... n/m` 已具备结构化识别能力；`5/5` 这类最后一次重连尝试会额外走 `codex.notification kind=connection`，普通进度本地显示仍保留。

## 遗留问题

- 本次未进行真实微信/飞书通道实测。通用 mock 链路已覆盖 notification 不受普通 progress silent 影响；真实渠道发送稳定性仍取决于对应平台当前连接和发送限制。
