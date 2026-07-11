# Codex app-server 重连提示独立通知设计

## 背景

真实运行中可能看到类似日志：

```text
Codex 连接恢复中: Reconnecting... 4/5
Codex 连接恢复中: Reconnecting... 5/5
```

这类信息来自 Codex app-server 的 `error` notification，但它不是普通失败。当前代码通过 `isTransientAppServerError()` 识别 `Reconnecting... n/m`，并把它转成普通 `assistant.progress`：

```text
Codex app-server error notification
  -> appServerErrorMessage()
  -> isTransientAppServerError()
  -> assistant.progress kind=other
  -> BridgeProgressDelivery
```

这样做能避免 transient reconnect 直接导致 turn failed，也能让本地 TUI 看到连接恢复进度。但它仍然有一个问题：它被当成普通进度处理，会受 `/progress silent`、brief 节流、progress cooldown 和渠道聚合影响。微信默认 progress mode 是 `silent`，因此这类连接恢复信息默认不会主动发到微信；飞书默认 `brief`，理论上会进入普通进度链路，但仍不是强通知。

从用户角度看，`Reconnecting... 5/5` 不只是普通进度。它表示 Codex app-server 与任务执行链路出现连接抖动或恢复风险，应当从普通 progress 中独立识别，作为低频但明确的连接状态通知投递给当前任务所属聊天渠道。

## 当前行为

当前代码位置：

- `src/codex/app-server/notification-mapper.ts`
  - `appServerErrorMessage()`
  - `isTransientAppServerError()`
- `src/codex/app-server/turn-controller.ts`
  - `notification.method === "error"` 时，把 transient reconnect 转成 `assistant.progress kind=other`
- `src/bridge/progress-delivery.ts`
  - 普通 progress 按 mode、policy、节流、pending、去重和 cooldown 投递
- `src/bridge/notification-delivery.ts`
  - `codex.notification` 会直接走通知投递，不受普通 progress mode 控制

当前链路的结果：

- TUI 能看到 `Codex 连接恢复中: Reconnecting... n/m`。
- 微信默认 `silent` 不会收到。
- 微信 `/progress brief` 和飞书 `brief` 下可能收到，但只是普通进度。
- 如果普通 progress 正在 cooldown，这条信息会被本地记录为未投递，不会主动通知聊天用户。

## 问题判断

`Reconnecting... n/m` 应该拆成两层语义：

1. **本地运行进度**
   - 每次 reconnect attempt 都保留本地可见。
   - 继续显示为 `Codex 连接恢复中: Reconnecting... n/m`。
   - 用于 TUI/transcript 观察 Codex 是否还在尝试恢复。

2. **聊天渠道连接告警**
   - 不应该每次 attempt 都刷微信/飞书。
   - 只在重要节点投递，例如达到最后一次尝试 `attempt === total`。
   - 不受 `/progress silent` 影响。
   - 应走 `codex.notification`，而不是普通 `assistant.progress`。

## 目标

1. 单独解析 `Reconnecting... n/m`，提取 `attempt` 和 `total`。
2. 保留原有 transient reconnect 不导致 turn failed 的行为。
3. 保留本地 TUI/transcript 每次 attempt 可见。
4. 在达到重要节点时，额外发出 `codex.notification`，投递到微信/飞书。
5. 通知不受 `/progress silent/brief/realtime` 影响。
6. 通知要低频去重，避免 `1/5` 到 `5/5` 连续刷屏。
7. 不改微信/飞书 adapter，不写渠道特例。

## 非目标

- 不把所有 app-server transient error 都推送到聊天渠道。
- 不把 `Reconnecting... 1/5` 到 `5/5` 每一条都发到微信/飞书。
- 不改变普通 progress 的节流、聚合、cooldown 策略。
- 不改变 fatal error 和 `turn.failed` 的处理逻辑。
- 不新增用户命令。
- 不依赖真实微信特殊 UI。

## 设计方案

### 1. 增加独立解析函数

在 `src/codex/app-server/notification-mapper.ts` 中，把当前布尔识别升级为结构化解析：

```ts
export interface AppServerReconnectNotice {
  message: string;
  attempt: number;
  total: number;
}

export function parseAppServerReconnectNotice(message: string): AppServerReconnectNotice | undefined;
```

识别规则：

```text
^Reconnecting\.\.\.\s+(\d+)\/(\d+)
```

解析要求：

- `attempt` 和 `total` 必须是正整数。
- `attempt <= total` 才视为有效。
- 保留原始 `message`，避免丢失 Codex app-server 后续可能附带的说明。
- `isTransientAppServerError()` 可以保留，但内部改为复用 `parseAppServerReconnectNotice()`。

### 2. 本地 progress 保持不变

`turn-controller` 收到 transient reconnect 时，继续发：

```text
assistant.progress
kind: "other"
text: "Codex 连接恢复中: Reconnecting... n/m"
```

这样本地 TUI/transcript 仍能看到每一次连接恢复尝试。该部分保持当前行为，不影响现有进度测试。

### 3. 增加连接类 Codex notification

在同一次处理里，当 reconnect notice 达到重要节点时，额外发：

```text
codex.notification
kind: "connection"
method: "appServer/reconnecting"
text: "Codex 连接恢复告警：\napp-server 已重连到最后一次尝试：5/5。\n当前任务仍在运行；如果连接无法恢复，后续会收到失败消息。"
dedupeKey: "appServer/reconnecting:<sessionId>:<turnId>:<total>"
dedupeWindowMs: 5 * 60_000
```

需要扩展 `CodexNotificationKind`：

```ts
export type CodexNotificationKind =
  | "security"
  | "warning"
  | "model"
  | "config"
  | "lifecycle"
  | "deprecation"
  | "connection";
```

选择新增 `connection` 的原因：

- `warning` 太泛，后续不好区分安全/配置/连接类告警。
- `model`、`config`、`lifecycle` 都不匹配。
- `connection` 能表达这是 app-server 执行连接状态，不是用户代码错误。

### 4. 通知触发策略

第一版只在 `attempt === total` 时主动通知聊天渠道。

原因：

- 前几次 reconnect 可能很快恢复，推送会打扰用户。
- 最后一次尝试代表恢复风险已明显升高，值得通知。
- 本地 TUI 仍能看到每一次 attempt，不丢排障信息。

边界：

- 如果 Codex app-server 后续直接发非 transient error，仍走现有 `turn.failed`。
- 如果同一 turn 连续出现多个 `5/5`，由 `dedupeKey + dedupeWindowMs` 去重。
- 如果未来发现 `attempt === total` 仍太晚，可以把策略调整为 `attempt === 1 || attempt === total`，但第一版先保守。

### 5. 事件投递路径

目标路径：

```text
Codex app-server error notification
  -> parseAppServerReconnectNotice()
  -> assistant.progress kind=other
  -> 本地 TUI/transcript 实时显示
  -> attempt === total 时额外 codex.notification kind=connection
  -> BridgeNotificationDelivery
  -> BridgeDelivery.sendText()
  -> 微信/飞书
```

关键点：

- 聊天告警走 `codex.notification`，绕开普通 progress mode。
- 不绕开渠道真实发送限制；微信/飞书发送失败仍按普通 text send 失败记录 WARN。
- 不改变 `BridgeProgressDelivery`。
- 不改变微信/飞书 `ChannelDeliveryPolicy`。

### 6. 文案

建议聊天渠道文案：

```text
Codex 连接恢复告警：
app-server 已重连到最后一次尝试：5/5。
当前任务仍在运行；如果连接无法恢复，后续会收到失败消息。
```

文案原则：

- 明确这不是最终失败。
- 明确当前任务仍在运行。
- 不要求用户立即操作。
- 不暴露内部堆栈或本机路径。

## 实现计划

### 阶段一：解析函数

修改：

- `src/codex/app-server/notification-mapper.ts`

新增：

- `parseAppServerReconnectNotice()`
- `AppServerReconnectNotice` 类型

测试：

- `tests/unit/app-server-mappers.test.ts`
  - `Reconnecting... 1/5` 解析为 `{ attempt: 1, total: 5 }`
  - `Reconnecting... 5/5` 解析为 `{ attempt: 5, total: 5 }`
  - 非 reconnect 文案返回 `undefined`
  - `isTransientAppServerError()` 继续兼容旧判断

### 阶段二：事件抽离

修改：

- `src/codex/types.ts`
  - 增加 `CodexNotificationKind = "connection"`
- `src/codex/app-server/turn-controller.ts`
  - transient reconnect 继续发 `assistant.progress`
  - `attempt === total` 时额外发 `codex.notification kind=connection`

测试：

- `tests/unit/app-server-codex-adapter.test.ts`
  - transient reconnect 不产生 `turn.failed`
  - `Reconnecting... 1/5` 仍有本地 progress
  - `Reconnecting... 5/5` 产生 connection notification
  - notification 文案包含 `最后一次尝试：5/5`

### 阶段三：Bridge 投递回归

原则上不需要改 Bridge 代码，因为 `codex.notification` 已有投递链路。

测试：

- `tests/unit/bridge-route-queue.test.ts` 或 integration mock：
  - 在 `silent` progress mode 下，`codex.notification kind=connection` 仍会发送到 channel。
  - 相同 dedupe key 在窗口内只发送一次。

## 测试计划

实现阶段至少执行：

```bash
npm run build
node --test dist/tests/unit/app-server-mappers.test.js dist/tests/unit/app-server-codex-adapter.test.js dist/tests/unit/bridge-route-queue.test.js
```

涉及 Bridge mock 行为时追加：

```bash
node --test dist/tests/integration/bridge-mock.test.js
```

提交前执行：

```bash
npm test
git diff --check
git status --short --ignored
```

按 `docs/development-and-test.zh-CN.md`，实现阶段必须新增中文测试报告：

```text
reports/tests/YYYY-MM-DD-codex-app-server-reconnect-notification.md
```

报告需说明：

- 本次只改 Codex app-server 事件映射和 Bridge notification 回归。
- 微信/飞书 adapter 无需改动。
- 真实微信/飞书发送仍需用户运行时观察；mock 测试覆盖“notification 不受 progress silent 影响”的通用链路。

## 风险与控制

| 风险 | 控制 |
| --- | --- |
| 连接恢复提示刷屏 | 只在 `attempt === total` 时发聊天通知，并用 `dedupeWindowMs` 去重。 |
| 用户误以为任务已经失败 | 文案明确“当前任务仍在运行”。真正失败仍由 `turn.failed` 处理。 |
| notification 类型扩展影响现有处理 | `BridgeNotificationDelivery` 不按 kind 分支发送，新增 `connection` 只需类型和测试覆盖。 |
| TUI 本地进度消失 | 保留原 `assistant.progress` 路径。 |
| 微信发送失败 | 仍由 `BridgeDelivery.sendText()` 记录 WARN；不额外做微信特例。 |

## 验收标准

- `Reconnecting... n/m` 被结构化解析。
- `Reconnecting... 1/5` 仍只作为本地/普通进度，不打扰聊天渠道。
- `Reconnecting... 5/5` 额外产生 `codex.notification kind=connection`。
- `/progress silent` 下连接告警仍能投递到当前 route。
- transient reconnect 不导致 turn failed。
- 所有新增/调整测试通过，并有中文测试报告。
