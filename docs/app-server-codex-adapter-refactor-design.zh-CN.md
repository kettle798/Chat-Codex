# AppServerCodexAdapter 职责拆分重构设计

## 背景

当前 `src/codex/app-server-codex-adapter.ts` 为 1037 行，已经触发 `docs/development-and-test.zh-CN.md` 中对 600 行以上业务文件的拆分检查要求。该规范明确要求不要按行数机械拆分，而要按功能边界、状态所有权、协议边界和测试边界拆分。

这个文件不是单一内聚状态机。它已经把 RPC client、turn controller、approval mapper、run/model policy mapper、input mapper、session store 等能力拆到了 `src/codex/app-server/` 下，但主适配器仍然同时承担多组有状态职责。继续在这里叠加 Codex app-server 新协议、Plan mode、用户输入、压缩、通知路由和模型策略，会让核心行为越来越难验证。

因此本轮目标不是重写 Codex adapter，而是把剩余职责继续拆成清晰模块，让 `AppServerCodexAdapter` 回到薄门面和高层编排角色。

## 已有拆分现状

当前已经存在的 app-server 子模块：

| 模块 | 当前职责 |
| --- | --- |
| `app-server/rpc-client.ts` | 子进程启动、stdio JSON-RPC、请求超时、响应/通知分发。 |
| `app-server/turn-controller.ts` | app-server turn notification 到 `CodexEvent` 的映射、turn queue、background event。 |
| `app-server/session-store.ts` | 本地 session record、threadId 到 sessionId 映射、session status/list。 |
| `app-server/turn-store.ts` | async queue、turn queue record、background turn 判断。 |
| `app-server/approval-handler.ts` | app-server 审批 request 解析和审批决策响应映射。 |
| `app-server/server-request-mapper.ts` | unsupported server request 和 `item/tool/requestUserInput` 映射。 |
| `app-server/notification-mapper.ts` | 普通 progress、plan、command output、app-server error 等通知映射。 |
| `app-server/run-policy.ts` | Chat-Codex run policy 到 app-server approval/sandbox payload 的映射。 |
| `app-server/model-policy.ts` | 模型列表、模型信息、reasoning effort、token usage 解析。 |
| `app-server/goal-api.ts` | Goal 响应解析。 |
| `app-server/input-mapper.ts` | `CodexPromptInput` 到 app-server `userInput` 的转换。 |
| `app-server/session-status.ts` | session status context、模型策略叠加和 collaboration payload。 |
| `app-server/value-parsers.ts` | JSON-RPC 参数窄解析工具。 |
| `app-server/protocol-capabilities.ts` | app-server 协议能力清单。 |
| `app-server/command-output-summary.ts` | 命令输出摘要和进度文案压缩。 |

这些拆分已经降低了协议映射和 turn 事件处理的复杂度，但主适配器仍保留大量状态编排。

## 当前主文件职责盘点

`app-server-codex-adapter.ts` 当前仍承担：

1. **对外 CodexAdapter 门面**
   - 导出 `AppServerCodexAdapter`。
   - 实现 `CodexAdapter` 的 session、run、approval、user input、policy、model、goal、compact 等公开方法。

2. **生命周期与 RPC 编排**
   - 解析 Codex 命令。
   - 创建 `AppServerRpcClient`。
   - `ensureStarted()`、`request()`、`writeMessage()`、`stop()`。
   - fatal app-server error 后清理 pending 状态和 turn。

3. **Session 生命周期**
   - `startSession()`、`resumeSession()`、`reloadSession()`、`loadSessionFromServer()`。
   - `setSessionTitle()`、`setSessionPreview()`。
   - `getStatus()`、`listSessions()`、`ensureKnownSession()`。
   - 这里同时触碰 app-server thread API、Codex 本地历史发现、session store、run/model policy、collaboration 默认值。

4. **Turn 执行编排**
   - `run()` 构造 `turn/start` payload，注册 turn queue，更新 running 状态。
   - `steer()` 构造 `turn/steer` payload。
   - `cancel()` 清理 pending approval/user input，关闭 turn，发送 `turn/interrupt`。
   - `AppServerTurnController` 已经接管 notification 到事件的主体映射，但 turn 启动、取消和 session 状态仍在主文件里。

5. **运行策略、模型策略和协作模式状态**
   - `defaultRunPolicy`、`sessionRunPolicies`。
   - `defaultModelPolicy`、`sessionModelPolicies`。
   - `defaultCollaborationMode`、`sessionCollaborationModes`。
   - `get/setRunPolicy()`、`getRunPolicyStatus()`、`get/setModelPolicy()`、`get/setCollaborationMode()`。
   - 设置模型策略时还会直接修改 session status。

6. **模型列表和 Goal API**
   - `listModels()` 循环请求 `model/list`。
   - `getGoal()`、`setGoal()`、`setGoalStatus()`、`clearGoal()` 直接请求 `thread/goal/*`。

7. **上下文压缩**
   - `compactWaiters`、超时 timer、压缩状态。
   - `compactSession()`、`handleCompactNotification()`、`resolveCompactWaiter()`、`rejectCompactWaiter()`。
   - 同时依赖 session store、RPC request、app-server error 判断和通知生命周期。

8. **Server request、审批和用户输入**
   - `pendingApprovals`、`pendingUserInputs`。
   - `resolveApproval()`、`resolveUserInput()`。
   - `handleServerRequest()`、`handleUserInputServerRequest()`。
   - `handleServerRequestResolvedNotification()`。
   - 同时负责写 JSON-RPC response、创建 background turn、更新 waiting/running 状态、推送 `approval.requested` / `input.requested` / resolved 事件。

9. **Status notification 和 Codex notification 路由**
   - `handleNotification()` 汇总分发。
   - `handleStatusNotification()` 处理 thread name/settings/status/archive/close/unarchive、model reroute/verification、warning/config/security/deprecation。
   - `emitProgressNotice()`、`emitCodexNotification()`、`notificationTurnId()`。
   - 文件底部还保留 `notificationText()`、`notificationDedupeKey()`、`formatNotificationValue()`、`startedAtFromTurn()`、`runningStartedAt()` 等 helper。

## 问题判断

这个文件值得继续拆，原因不是“1037 行”本身，而是：

- **状态所有权混杂**：policy maps、pending approvals、pending user inputs、compact waiters、session records、turn records 同时由主文件操作。
- **协议边界混杂**：thread API、turn API、model API、goal API、server request、notification 都在一个类里分支处理。
- **测试边界变粗**：很多行为只能通过 `AppServerCodexAdapter` 假 app-server 测试覆盖，无法直接单测 pending request、compact waiter 或 status notification 的局部状态机。
- **后续风险集中**：Plan mode、commentary、request user input、context compact、model policy 都是核心能力，继续堆在同一文件会增加回归概率。

## 重构目标

1. 保持 `src/codex/app-server-codex-adapter.ts` 的公开导出不变。
2. 保持 `CodexAdapter` 外部行为不变。
3. 主文件收敛为薄门面，负责构造依赖、公开方法转发和少量高层编排。
4. 把有状态子流程按所有权拆出，避免继续扩大主类。
5. 让新增模块具备独立单元测试边界。
6. 每轮实现后按开发规范执行自测，并在 `reports/tests/` 增加中文测试报告。

## 非目标

- 不重写 Codex app-server JSON-RPC 协议。
- 不改变 `/plan`、`/code`、模型、reasoning effort、approval、user input、compact、commentary 的语义。
- 不改变微信、飞书或 Bridge Core 行为。
- 不为了行数把强相关逻辑拆成跳转成本很高的小碎片。
- 不在重构过程中顺手改 UI 文案、渠道投递策略或命令行为。
- 不引入大型框架或依赖注入容器。

## 目标结构

建议新增或扩展这些模块：

```text
src/codex/
  app-server-codex-adapter.ts
  app-server/
    policy-store.ts
    compact-controller.ts
    server-request-controller.ts
    status-notification-handler.ts
    notification-text.ts
    session-lifecycle.ts
    time-utils.ts
```

### `app-server-codex-adapter.ts`

保留：

- `AppServerCodexAdapterOptions`。
- `AppServerCodexAdapter` 对外类。
- 构造 `AppServerRpcClient`、`AppServerSessionStore`、`AppServerTurnController` 和新增 controller。
- `onBackgroundEvent()`、`stop()`、`run()`、`steer()`、`cancel()` 等与多个子模块交叉的高层编排。
- 对公开 API 的转发。

目标行数：最终控制在 400-600 行左右。如果 `run/steer/cancel` 继续膨胀，再单独评估 `turn-runner.ts`，不在第一轮硬拆。

### `app-server/policy-store.ts`

职责：

- 持有 default/session run policy。
- 持有 default/session model policy。
- 持有 default/session collaboration mode。
- 提供 clone 后的 getter/setter。
- 提供 `runPolicyForSession()`、`modelPolicyForSession()`、`collaborationModeForSession()`。

边界：

- 不直接发送 RPC。
- 尽量不直接操作 session store。
- `setModelPolicy()` 造成的 session status 更新可以由 adapter 或 session service 调用现有 `modelInfoWithPolicy()` 完成，避免 policy store 反向依赖 session store。

### `app-server/compact-controller.ts`

职责：

- 持有 `compactWaiters`。
- 实现 `compactSession()`。
- 实现 `handleNotification()`、`resolveWaiter()`、`rejectWaiter()`。
- 提供 `stop(reason)` / `clearForRestart(reason)`，用于 adapter stop/reload/fatal error。

依赖：

- 小型 `request(method, params, options)` 接口。
- `AppServerSessionStore` 或更窄的 session 读写接口。
- `withContext()`、`appServerErrorMessage()`、`isTransientAppServerError()`。

### `app-server/server-request-controller.ts`

职责：

- 持有 `pendingApprovals` 和 `pendingUserInputs`。
- 实现 `resolveApproval()`、`resolveUserInput()`。
- 实现 `handleServerRequest()`。
- 实现 `handleResolvedNotification()`。
- 实现 `cancelPendingForTurn(sessionId, turnId)`，供 `cancel()` 调用。
- 负责审批/用户输入等待状态与 resolved 事件。

依赖：

- `writeMessage(message)`。
- session store 的 resolve/get。
- turn controller 的 create/push/get。
- `emitProgressNotice()` 回调。

边界：

- 只处理 app-server server request，不处理普通 thread/status/model notification。
- 不直接知道微信、飞书或 Bridge command。

### `app-server/status-notification-handler.ts`

职责：

- 接收普通 `JsonRpcNotification`。
- 处理 thread name/settings/status/archive/close/unarchive。
- 处理 model reroute/verification。
- 处理 warning、guardianWarning、configWarning、deprecationNotice 等 Codex notification。
- 调用 `emitCodexNotification()` 回调。

依赖：

- session store。
- `modelPolicyForSession(sessionId)`。
- notification text helper。

边界：

- 不处理 turn item 事件；仍由 `AppServerTurnController` 负责。
- 不处理 compact notification；由 compact controller 负责。
- 不处理 server request resolved；由 server request controller 负责。

### `app-server/notification-text.ts`

职责：

- `notificationText()`。
- `notificationDedupeKey()`。
- `formatNotificationValue()`。

这是纯函数模块，应补直接单元测试，避免 status handler 测试只能走 adapter。

### `app-server/session-lifecycle.ts`

职责：

- `startSession()`。
- `resumeSession()` / `loadSessionFromServer()`。
- `setSessionTitle()`。
- `setSessionPreview()`。
- 可选：`restartAppServerForReload()` 的纯清理流程仍由 adapter 触发，session lifecycle 只负责 reload 后重新加载。

依赖：

- request 接口。
- session store。
- policy store。
- codexHome。
- `findCodexSessionById()`、`displayCodexSessionTitle()`、`ensureCodexStatePreviewIfEmpty()`。

边界：

- 这是依赖最多的一块，建议放在后期拆。先拆 policy、compact、server request 和 status notification，把主文件状态压力降下来后再动 session lifecycle。

### `app-server/time-utils.ts`

职责：

- `startedAtFromTurn()`。
- `runningStartedAt()`。
- `isoFromMilliseconds()`。

注意：`turn-controller.ts` 内部也有类似 helper。实现时应优先复用或合并，避免继续复制同名逻辑。

## 分阶段实施计划

本次拆分建议按 **7 个代码阶段 + 1 个基线确认阶段** 推进。每个代码阶段都应能独立 build、独立跑 targeted tests，并在通过后单独提交；不要把多个 controller 的迁移压成一次大改。

阶段总览：

| 阶段 | 主题 | 主要产物 | 风险 |
| --- | --- | --- | --- |
| 阶段 0 | 基线确认 | 确认工作区、提交边界、测试基线 | 低 |
| 阶段 1 | 纯 helper 抽离 | `notification-text.ts`、`time-utils.ts` | 低 |
| 阶段 2 | PolicyStore | `policy-store.ts` | 中 |
| 阶段 3 | CompactController | `compact-controller.ts` | 中 |
| 阶段 4 | ServerRequestController | `server-request-controller.ts` | 中高 |
| 阶段 5 | StatusNotificationHandler | `status-notification-handler.ts` | 中高 |
| 阶段 6 | SessionLifecycle | `session-lifecycle.ts` | 高 |
| 阶段 7 | 收口 | adapter 瘦身、循环依赖检查、全量测试 | 中 |

提交策略：

- 阶段 0 不提交代码，只确认基线。
- 阶段 1-7 建议每阶段一个 commit，commit message 使用 `refactor:` 前缀。
- 如果某阶段补了测试或测试报告，应与该阶段代码一起提交。
- 如果执行前工作区已有无关未提交改动，应先提交、暂存隔离或明确记录，不把无关改动混进 app-server adapter 拆分提交。

### 阶段 0：基线确认

- 确认工作区状态，不覆盖无关未提交改动。
- 当前 `main` 可能已经与远端同步，但仍需检查是否存在未提交工作区内容；只有 `git status --short --branch` 干净，或无关改动已单独提交/隔离后，才开始代码拆分。
- 若存在类似 TUI 页面、TUI 测试、测试报告或本文档索引这类非 app-server adapter 改动，应先独立提交，避免与后续重构混在同一提交里。
- 记录当前 `app-server-codex-adapter.ts` 行数和测试基线。
- 不做功能改动。

建议命令：

```bash
git status --short --branch
npm run build
node --test dist/tests/unit/app-server-mappers.test.js dist/tests/unit/app-server-core-modules.test.js dist/tests/unit/app-server-codex-adapter.test.js
```

### 阶段 1：纯 helper 抽离

拆出：

- `notification-text.ts`
- `time-utils.ts`

迁移：

- `notificationText()`
- `notificationDedupeKey()`
- `formatNotificationValue()`
- `startedAtFromTurn()`
- `runningStartedAt()`

测试：

- 在 `tests/unit/app-server-mappers.test.ts` 增加 notification text/time helper 的直接覆盖。
- 跑 app-server targeted tests。

风险：

- 低。只迁移纯函数，行为应完全一致。

### 阶段 2：PolicyStore 抽离

新增：

- `app-server/policy-store.ts`

迁移：

- default/session run policy 状态。
- default/session model policy 状态。
- default/session collaboration mode 状态。
- `getRunPolicy()`、`setRunPolicy()`、`getRunPolicyStatus()` 的核心状态逻辑。
- `getModelPolicy()`、`setModelPolicy()` 的 clone 语义。
- `getCollaborationMode()`、`setCollaborationMode()`。

保留在 adapter 或 session service：

- `setModelPolicy(sessionId)` 后同步 session status 的行为。

测试重点：

- 默认 policy 与 session policy 相互独立。
- `/plan` / `/code` 不重置原 session 模型和 reasoning effort。
- 设置 model policy 后 session status 正确展示模型信息。

### 阶段 3：CompactController 抽离

新增：

- `app-server/compact-controller.ts`

迁移：

- `compactWaiters`。
- `compactSession()`。
- `handleCompactNotification()`。
- `resolveCompactWaiter()`。
- `rejectCompactWaiter()`。
- stop/restart/fatal error 时 reject pending compact 的清理入口。

测试重点：

- `thread/compact/start` 正常完成。
- `thread/compacted` 先到和 `turn/completed` 先到都能结束等待。
- 非 transient error 会失败 compact。
- timeout 能恢复 session 状态为 failed。
- app-server stop/reload 时 pending compact 被 reject。

### 阶段 4：ServerRequestController 抽离

新增：

- `app-server/server-request-controller.ts`

迁移：

- `pendingApprovals`。
- `pendingUserInputs`。
- `resolveApproval()`。
- `resolveUserInput()`。
- `handleServerRequest()`。
- `handleUserInputServerRequest()`。
- `handleServerRequestResolvedNotification()`。
- `cancel()` 内 pending approval/user input 清理逻辑。

测试重点：

- command/file/permission approval request 仍能进入 `approval.requested`。
- `/OK`、`/P`、`/NO` 仍能写回 app-server response。
- `item/tool/requestUserInput` 仍能进入 `input.requested`。
- bridge 回答后写回 app-server response 并发出 `input.resolved`。
- `serverRequest/resolved` 外部解决后清理 pending 并恢复 running。
- cancel turn 时 pending approval/user input 被清理。

### 阶段 5：StatusNotificationHandler 抽离

新增：

- `app-server/status-notification-handler.ts`

迁移：

- `handleStatusNotification()`。
- `emitCodexNotification()` 可保留在 adapter，也可以作为回调由 handler 调用。
- `notificationTurnId()` 若仍需要 session store，可保留在 adapter 或成为 handler 内部方法。

测试重点：

- thread name update 更新 session title。
- thread settings update 更新 cwd/base model/model status。
- thread status changed 在 idle/running/waiting approval/waiting input/system error 之间转换。
- thread archive/close 发出 lifecycle notification，并带 `unbindRoute`。
- model reroute/verification 发出 notification。
- warning/config/security/deprecation 文案和 dedupe key 保持一致。

### 阶段 6：SessionLifecycle 抽离

新增：

- `app-server/session-lifecycle.ts`

迁移：

- `startSession()`。
- `resumeSession()`。
- `loadSessionFromServer()`。
- `setSessionTitle()`。
- `setSessionPreview()`。

保留在 adapter：

- `reloadSession()` 中的“有 active turn 不允许重启”和跨 controller 清理。

测试重点：

- start session 的 thread/start payload 保持 approval/sandbox/model/service tier 语义。
- resume session 的 thread/resume payload 保持 cwd/model/run policy 语义。
- reload session 会 stop 旧 app-server 并重新加载。
- set title 仍调用 `thread/name/set` 并更新本地 title。
- set preview 仍只补空 preview。

### 阶段 7：收口与评估

- 删除 adapter 中已迁移的私有 helper 和 map 状态。
- 确认没有新增循环依赖。
- 确认 `app-server-codex-adapter.ts` 剩余职责清晰，目标 400-600 行。
- 如果仍超过 600 行，再评估是否拆 `turn-runner.ts` 或 `goal-client.ts`。

## 依赖设计原则

- 不创建万能 `Context` 对象。
- 每个 controller 只拿自己需要的依赖。
- `request`、`writeMessage`、`emitProgressNotice`、`emitCodexNotification` 用小函数接口传入。
- session 读写优先通过 `AppServerSessionStore` 或小接口传入，不直接跨模块读取无关状态。
- turn 事件只通过 `AppServerTurnController` 的公开方法推进。
- 新模块不得依赖微信、飞书、Bridge Core 或 TUI。

## 测试计划

每个实现阶段至少执行：

```bash
npm run build
node --test dist/tests/unit/app-server-mappers.test.js dist/tests/unit/app-server-core-modules.test.js dist/tests/unit/app-server-codex-adapter.test.js
```

涉及 Bridge 可见行为时追加：

```bash
node --test dist/tests/integration/bridge-mock.test.js
```

阶段收口或提交前执行：

```bash
npm test
git diff --check
git status --short --ignored
```

每个代码实现阶段必须按 `docs/development-and-test.zh-CN.md` 在 `reports/tests/` 新增中文测试报告。报告需记录：

- 本阶段迁移范围。
- 执行命令。
- 实际结果。
- 是否发现非本次改动相关失败。
- 是否有真实渠道待补测。该重构原则上只涉及 Codex adapter 本地逻辑，不要求微信/飞书真实通道测试；若后续阶段影响聊天命令或渠道投递，再补 mock/真实通道说明。

## 风险与控制

| 风险 | 控制方式 |
| --- | --- |
| 拆出 controller 后共享状态变多 | 按状态所有权拆分，pending maps/compact waiters/policy maps 分别归属，不用万能 context。 |
| app-server 协议 payload 细节被改坏 | 每阶段先搬代码再重命名，保持 targeted app-server adapter 测试通过。 |
| `/plan` 或模型 reasoning effort 回归 | PolicyStore 阶段必须保留现有 plan/model policy 回归测试。 |
| approval/user input 清理遗漏 | ServerRequestController 阶段新增/保留 cancel、resolved、resolve API 覆盖。 |
| compact 等待状态泄漏 | CompactController 阶段覆盖 success/error/timeout/stop/reload。 |
| status notification 路由丢事件 | StatusNotificationHandler 阶段保留 adapter 级假 app-server 测试，并补纯 helper 单测。 |
| 文件拆太碎导致跳转成本高 | 第一轮只拆状态边界明确的模块；`goal-client.ts`、`turn-runner.ts` 作为后续评估，不默认拆。 |

## 验收标准

- `AppServerCodexAdapter` 公开 API 和 import 路径不变。
- 所有现有 app-server adapter 单元测试通过。
- Bridge mock 集成测试通过。
- `npm test` 通过或测试报告明确记录非本次改动的偶发失败与重跑结果。
- 每个阶段有中文测试报告。
- `app-server-codex-adapter.ts` 剩余职责可以用“构造依赖 + 对外门面 + 高层 turn/session 编排”概括，不再直接持有多类 pending 状态。
