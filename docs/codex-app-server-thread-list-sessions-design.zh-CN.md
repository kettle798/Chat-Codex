# `/sessions` 对齐 Codex app-server `thread/list` / `thread/read` 设计

## 背景

Chat-Codex 已经有聊天侧 session 列表能力：

- `/sessions`、`/session`：展示当前聊天上下文可见的 Codex 会话。
- `/sessions all`、`/session all`、`/all-sessions`：展示本机可发现的历史会话。
- `/use`、`/resume`：复用 session 列表进入编号选择和绑定。

当前实现已经统一了分页、排序、当前标记、不可选标记和 `/use` 选择逻辑。用户侧交互不能再变化，本轮只评估并设计底层数据源适配。

新版 Codex app-server 已官方提供：

- `thread/list`：列出 thread 元数据，支持分页、排序、来源、归档、cwd 和搜索过滤。
- `thread/read`：读取单个 thread 详情，可选择包含 turns 历史。

这意味着 `/sessions` 不必长期依赖本地 JSONL/状态文件扫描作为唯一历史来源，可以优先使用官方 app-server 元数据接口，并在不改变聊天命令体验的前提下拿到更准确的标题、状态、最近活跃时间和工作目录。

## 当前代码路径

### Chat-Codex 侧

- `src/bridge/status-text.ts`
  - `sessionsText()` 解析 `/sessions` 参数。
  - 调用 `buildSessionList()`。
  - 使用 `formatSessionListPage()` 保持当前分页输出。
- `src/bridge/session-list.ts`
  - 合并 `MemoryStateStore.listSessions(...)` 和 `CodexAdapter.listSessions(...)`。
  - 保留当前 session、可选状态、owner 冲突、排序和分页。
- `src/bridge/session-flow.ts`
  - `/use`、`/resume` 不带参数时同样调用 `buildSessionList(scope: "selectable")`。
  - 绑定仍通过 `codex.resumeSession(sessionId)` 完成。

### AppServer adapter 侧

- `src/codex/app-server-codex-adapter.ts`
  - `listSessions(routeKey?)` 当前直接返回 `this.sessionStore.listSessions(routeKey, this.codexHome)`。
- `src/codex/app-server/session-store.ts`
  - 有 routeKey 时只返回当前进程内 route 绑定记录。
  - 无 routeKey 时合并进程内记录和 `discoverCodexSessions({ codexHome })` 的本地文件扫描结果。

结论：`thread/list` 已在协议清单中登记为候选能力，但还没有接入 `/sessions` 的实际数据源。

## Codex 官方协议结论

参考 `references/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/`：

### `thread/list`

`ThreadListParams` 支持：

- `cursor`
- `limit`
- `sortKey`: `created_at` / `updated_at` / `recency_at`
- `sortDirection`
- `modelProviders`
- `sourceKinds`
- `archived`
- `cwd`
- `useStateDbOnly`
- `searchTerm`

`ThreadListResponse` 返回：

- `data: Thread[]`
- `nextCursor`
- `backwardsCursor`

`Thread` 元数据包含：

- `id`
- `sessionId`
- `preview`
- `name`
- `status`
- `cwd`
- `createdAt`
- `updatedAt`
- `recencyAt`
- `modelProvider`
- `source`
- `threadSource`
- `cliVersion`
- `path`
- `gitInfo`
- `forkedFromId`
- `parentThreadId`
- `ephemeral`

这些字段可以提升 `/sessions` 的准确性，但默认聊天列表不应一次性展示所有字段。

### `thread/read`

`ThreadReadParams` 为：

- `threadId`
- `includeTurns?`

`includeTurns=true` 时会加载 turns 历史，成本明显高于列表元数据。Codex TUI 也只在查找详情、恢复回放或特定 fallback 时调用 `thread/read`，不会在默认列表里对每条记录逐个调用。

结论：

- `thread/list` 适合作为 `/sessions` 的底层数据源。
- `thread/read` 不适合默认 `/sessions` 列表逐项调用。
- `thread/read(includeTurns=true)` 只能作为后续详情、诊断或恢复回放场景的候选，不进入本轮默认列表。

## 设计目标

1. 不改变现有 `/sessions` 用户交互。
2. 不改变现有 `/use`、`/resume` 编号选择交互。
3. 不新增聊天命令。
4. `thread/list` 作为 app-server adapter 内部数据源增强。
5. `thread/read` 暂不进入默认列表，只保留为未来候选。
6. Chat-Codex 本地 route/session owner 规则继续权威。
7. app-server 不支持、返回失败或协议漂移时，回退到现有本地发现。
8. 保持轻量，不把 Chat-Codex 做成 Codex App/TUI 的完整会话浏览器。

## 非目标

- 不新增 `/thread/list`、`/thread/read`、`/fork`、`/rollback` 等命令。
- 不在 `/sessions` 默认展示 turns 历史、diff、完整 preview 或 git 详情。
- 不改变 `/sessions` 每页数量、翻页命令、当前标记和不可选标记。
- 不改变 `/use 1`、`/resume 1` 的编号解释方式。
- 不让 app-server `thread/list` 覆盖 Chat-Codex 本地 owner/route 归属。
- 不让 `/session <id>` 调用 `thread/read(includeTurns=true)` 或投递完整历史 turns。

## 交互保持策略

现有输出结构继续保持：

```text
**Codex 会话**

- 范围: 当前聊天 / 全部可发现
- 页码: `1 / N`
- 数量: `N`

1. Session: `...`
   - 最近活跃: `...`
   - 标题: ...
   - 状态: ...
   - 工作目录: `...`
```

本轮允许变化的是这些字段背后的数据质量：

- `标题`：优先使用 app-server `Thread.name`，没有时用 `Thread.preview`，再回退到本地历史标题。
- `最近活跃`：优先使用 `recencyAt`，没有时用 `updatedAt`，再回退本地扫描时间。
- `状态`：将 app-server `Thread.status` 映射为 Chat-Codex 的 `CodexSessionStatus`。
- `工作目录`：优先使用 app-server `Thread.cwd`，没有时用本地记录。

本轮不新增默认展示字段。`modelProvider`、`source`、`cliVersion`、`gitInfo` 可以先进入内部 summary 扩展或映射测试，不在聊天列表里直接展开，避免打破现有轻量体验。

## 数据源设计

### route-scoped `/sessions`

`/sessions` 的语义是“当前聊天上下文相关 session”，不是“app-server 全部 thread”。

因此 route-scoped 列表仍以 Chat-Codex 本地状态为准：

1. 先读取 `MemoryStateStore.listSessions(routeKey)`。
2. 再读取 `CodexAdapter.listSessions(routeKey)` 的当前进程内记录。
3. 如果需要增强字段，可对已知 session id 使用 app-server 元数据缓存或一次性 `thread/list` 结果补充，但不能把所有 app-server thread 暴露到当前聊天。

理由：

- app-server 不知道微信/飞书 route 归属。
- 群聊、私聊和飞书 chat_id 的 owner 冲突由 Chat-Codex 管。
- 其它聊天绑定过的 session 不能因为 app-server 能列出就出现在当前聊天默认列表里。

### unscoped `/sessions all`

`/sessions all` 展示“全部可发现 Codex 会话”，适合优先走官方 `thread/list`：

1. 调用 app-server `thread/list`。
2. 将 `Thread[]` 映射为 `CodexSessionSummary[]`。
3. 合并当前进程内 session store。
4. 如果 `thread/list` 失败或不支持，回退现有 `discoverCodexSessions()`。
5. 去重时以 `thread.id` / `summary.id` 为主，保留本地 owner 和当前绑定信息。

建议请求参数：

```ts
{
  limit: 100,
  sortKey: "recency_at",
  sortDirection: "desc",
  archived: false,
  useStateDbOnly: false
}
```

说明：

- `limit` 先取足够覆盖聊天侧分页的轻量值，避免一次拉取无限历史。
- `sortKey` 优先 `recency_at`，更贴近用户“最近使用”的理解；如果兼容性有问题，回退 `updated_at`。
- `archived: false` 保持默认只展示可恢复的常规历史。
- `sourceKinds` 初始可不传，沿用 Codex 默认 interactive sources；如测试发现 Chat-Codex 自己创建的 app-server 会话不在默认范围内，再显式使用 `["cli", "vscode", "appServer"]`。

### `/use` 和 `/resume` 选择列表

`/use` / `/resume` 的选择列表仍走 `buildSessionList(scope: "selectable")`。

适配后：

1. app-server `thread/list` 可以提供更多候选 session。
2. 本地 owner 冲突仍由 `MemoryStateStore.getSessionOwner()` 判断。
3. 已被其它 route 绑定的 session 仍不可选或被隐藏。
4. 最终绑定仍调用 `codex.resumeSession(sessionId)`，不因 `thread/list` 结果直接建立绑定。

## 增强目标：`/session <id>` 详情页

用户希望继续保留现有 `/session` 作为 `/sessions` alias 的基础交互，同时允许显式查看某个 session 的详情。设计为：

```text
/session
/sessions
```

仍展示当前聊天 session 列表。

```text
/session all
/sessions all
```

仍展示全部可发现 session 列表。

```text
/session cwd
/sessions cwd
```

仍进入按工作目录浏览和选择。

新增：

```text
/session <session-id>
/session detail <session-id>
```

展示指定 session 的官方元数据详情。

### 数据来源

优先调用 app-server：

```ts
thread/read({
  threadId: sessionId,
  includeTurns: false,
})
```

要求：

- `includeTurns` 必须为 `false` 或省略，不能加载 turns 历史。
- 如果 `thread/read` 不支持、失败或返回 thread 不存在，回退到当前 `CodexAdapter.listSessions(undefined)` 已发现的 summary。
- 详情页不能隐式绑定或切换 session，只做只读展示。
- 如果 session 被其它 route 拥有，详情页可以展示“已绑定到其它聊天上下文”，但不能提供切换动作。

### 展示字段

默认展示稳定、轻量、可诊断的字段：

```text
**Codex 会话详情**

- Session: `...`
- Thread: `...`
- 标题: ...
- 预览: ...
- 状态: ...
- 工作目录: `...`
- 最近活跃: `...`
- 创建时间: `...`
- 来源: `cli / vscode / appServer / exec / unknown`
- Thread source: `...`
- Model provider: `openai`
- CLI 版本: `...`
- 历史文件: `...`
- Git: `branch @ commit`
- Fork 来源: `...`
- Parent thread: `...`
- Ephemeral: `true/false`
- 归属: 当前聊天 / 已绑定到其它聊天上下文 / 未绑定
```

字段规则：

- 没有值的字段不展示，避免聊天消息冗长。
- `Session` / `Thread` 必须保留完整 id。
- `cwd` 和 `path` 使用现有紧凑路径格式。
- `preview` 和 `name` 需要截断，避免刷屏。
- `gitInfo` 只展示安全摘要，例如 repo root、branch、commit，不展示大段 diff。

### 与 `/sessions` 列表的关系

`/session <id>` 不改变现有列表、分页和选择态：

- 不复用 `/sessions` 当前页编号。
- 不消耗 `/use` 或 `/sessions cwd` 的裸数字选择态。
- 不改变当前绑定。
- 不改变 session owner。

用户如果想切换，仍使用：

```text
/use <session-id>
```

或 `/sessions cwd` / `/use` 的编号选择流程。

## 增强候选：`/sessions cwd` 按目录浏览与切换

用户希望在不改变基本 `/sessions` 操作的前提下，增加按工作目录查看 session 的能力。该能力适合作为显式子命令：

```text
/sessions cwd
/session cwd
```

普通命令保持不变：

- `/sessions`：仍展示当前聊天相关 session。
- `/sessions all`：仍展示全部可发现 session。
- `/sessions next` / `/sessions prev`：仍翻当前聊天列表。
- `/sessions all next` / `/sessions all prev`：仍翻全部列表。
- `/use` / `/resume`：仍按现有编号选择会话。

### 交互流程

第一步，用户发送：

```text
/sessions cwd
```

系统返回目录列表：

```text
**Codex 会话目录**

- 范围: 全部可发现
- 页码: `1 / 2`
- 目录数: `13`

1. 工作目录: `.../codex-chat-bridge`（当前）
   - 会话数: `8`
   - 最近活跃: `2026-07-11 21:10:00（Asia/Shanghai）`
   - 可切换: `7`
2. 工作目录: `.../openai-codex`
   - 会话数: `4`
   - 最近活跃: `2026-07-10 18:30:00（Asia/Shanghai）`
   - 可切换: `4`

直接回复编号查看该目录下的 session；回复 `n` 下一页，`p` 上一页；回复“取消”退出。
```

第二步，用户回复目录编号，例如：

```text
1
```

系统返回该目录下的 session 列表，继续复用现有 session 列表格式：

```text
**目录下 Codex 会话**

- 范围: 工作目录 `.../codex-chat-bridge`
- 页码: `1 / 1`
- 数量: `8`

1. Session: `...`（当前）
   - 最近活跃: `...`
   - 标题: ...
   - 状态: ...
   - 工作目录: `.../codex-chat-bridge`
2. Session: `...`
   - 最近活跃: `...`
   - 标题: ...
   - 状态: ...
   - 工作目录: `.../codex-chat-bridge`

直接回复编号完成切换；回复 `n` 下一页，`p` 上一页；回复“取消”退出。
```

第三步，用户回复 session 编号，按现有 `/use` 规则切换：

- 可选 session：调用 `codex.resumeSession(sessionId)` 并绑定当前 route。
- 不可选 session：返回不可选原因，不切换。
- 当前 route 正在执行任务：沿用现有 busy guard，拒绝切换。

这里不额外增加二次确认；“回复编号”本身就是确认切换。这样和现有 `/use` 编号选择语义一致。

### 翻页与状态保留

现有 `/sessions` 翻页已经通过 `sessionListStates` 保留列表快照，TTL 为 10 分钟；现有 `/use` 选择态也通过 `SessionSelectionState` 保留列表、当前页和 TTL。

`/sessions cwd` 应沿用同一原则：

- 目录列表进入后保留目录快照和当前目录页。
- 选中目录后保留该目录下的 session 快照和当前 session 页。
- 回复 `n` / `p` 在当前阶段翻页：
  - 还在目录阶段：翻目录页。
  - 已进入某个目录：翻该目录下的 session 页。
- 回复“取消”清理 cwd 浏览状态。
- 状态 TTL 仍使用 `SESSION_LIST_STATE_TTL_MS`，默认 10 分钟。
- 用户重新发送 `/sessions cwd` 时刷新目录快照并回到目录第一页。

这能保证翻页不会因为 app-server 重新返回、历史文件扫描顺序变化或新 session 产生而导致编号漂移。

### 数据范围

`/sessions cwd` 的目录来源建议使用 `buildSessionList(scope: "selectable")` 的完整 item 集合，而不是 route-scoped `/sessions`：

- 它能看到全部可发现 session，符合“按目录找历史会话”的预期。
- item 内仍保留 `selectable` 和 `unavailableReason`。
- 目录列表可以展示 `会话数` 和 `可切换` 数。
- 目录下 session 列表可以继续标记“当前”“不可选”。
- 选择不可选 session 时不允许绑定，owner 规则不变。

目录分组规则：

- 以 `item.cwd` 精确分组。
- 缺失 cwd 的 session 归入“未知目录”。
- 不做 filesystem canonicalize，避免符号链接、远程 workspace 和不存在路径造成额外副作用。
- 排序按目录内最近活跃 session 时间倒序；时间相同按目录字符串升序。

当底层 app-server `thread/list` 接入后，`/sessions cwd` 使用的是 `CodexAdapter.listSessions(undefined)` 能返回的“可发现集合”。如果 adapter 为了轻量设置了最大读取上限，目录列表也只保证覆盖该集合；实现时应避免在聊天命令里无限分页读取所有历史。

### 实现边界

由于 `/sessions cwd` 需要消费后续裸数字回复，它不适合只放在 `BridgeStatusText.sessionsText()` 这种“输入命令，返回字符串”的纯状态渲染路径里。

建议新增或扩展会话选择流程：

- 在 `BridgeCommandRouter` 中识别 `sessions/session` 的首个参数为 `cwd`。
- 普通 `/sessions` 仍调用 `statusTextRenderer.sessionsText()`。
- `/sessions cwd` 调用 `SessionFlow.beginSessionCwdSelection(...)` 或独立的 `SessionDirectoryFlow`。
- `Bridge.handleMessage()` 在普通 prompt 前检查 cwd 选择态，类似现有 `hasSessionSelection()`。
- cwd 选择态和现有 `/use` 选择态共享分页、过期、取消、busy guard 和绑定函数。

建议状态模型：

```ts
interface SessionCwdSelectionState {
  stage: "cwd" | "session";
  directories: SessionDirectoryItem[];
  directoryPage: number;
  selectedCwd?: string;
  sessions: SessionListItem[];
  sessionPage: number;
  pageSize: number;
  createdAt: number;
}

interface SessionDirectoryItem {
  cwd?: string;
  totalSessions: number;
  selectableSessions: number;
  current: boolean;
  latestUpdatedAt: string;
}
```

### Help 与文案

`/help` 中只需要轻量增加一条：

```text
/sessions cwd - 按工作目录浏览历史会话并选择切换
/session <id> - 查看指定 Codex 会话详情，不切换绑定
```

不要把 `thread/list`、`thread/read` 等 app-server 术语暴露给用户。

## 附加适配：`/goal` 最新状态与 `/help` 文案

本轮实现 `/sessions` 官方数据源和 `/sessions cwd` 时，顺手把 `/goal` 的官方状态枚举补齐。这个改动很小，但属于同一类“最新 app-server 协议对齐”，应一起做，避免 `/status` 或 `/goal` 把官方状态误显示成 `active`。

### 当前差距

Codex 官方 `ThreadGoalStatus` 最新枚举为：

```text
active | paused | blocked | usageLimited | budgetLimited | complete
```

Chat-Codex 当前 `CodexGoalStatus` 只覆盖：

```text
active | paused | budgetLimited | complete
```

因此当 app-server 返回 `blocked` 或 `usageLimited` 时，当前 mapper 会把未知状态 fallback 成 `active`。这会让 `/goal` 和 `/status` 显示错误状态。

### 适配目标

- `CodexGoalStatus` 增加 `blocked` 和 `usageLimited`。
- `goalStatusValue()` 识别官方全部 6 个状态。
- `formatGoalStatus()` 和 `/status` 的 Goal 中文展示补齐：
  - `active`：进行中
  - `paused`：已暂停
  - `blocked`：已阻塞
  - `usageLimited`：已达用量限制
  - `budgetLimited`：已达预算
  - `complete`：已完成
- `/goal pause` 和 `/goal resume` 仍只主动设置 `paused` / `active`。
- 不新增 `/goal blocked`、`/goal complete` 这类写命令；`blocked`、`usageLimited`、`budgetLimited`、`complete` 作为 app-server 返回状态展示即可。
- 未来如果官方再增加状态，应避免静默伪装成 `active`。可以保守显示为未知状态，或把 `CodexGoalStatus` 改成开放字符串并在展示层兜底。

### `/help` 文案更新

`/help` 中 `/goal` 说明需要同步调整，不只说“实验 Goal 长期目标”，还要让用户知道这些状态可能由 Codex 自动产生：

```text
/goal [目标] - 查看或设置当前会话的实验 Goal 长期目标。
  - /goal pause: 暂停 Goal，保留目标但暂时不让 Codex 按它持续推进。
  - /goal resume: 恢复 Goal，继续按已暂停的目标推进。
  - /goal clear: 清除 Goal，退出当前会话的 Goal 追踪。
  - 状态可能显示为：进行中、已暂停、已阻塞、已达用量限制、已达预算、已完成。
```

聊天侧仍不暴露 `thread/goal/*` 协议名。

### Goal 通知边界

`thread/goal/updated` 和 `thread/goal/cleared` 当前标记为 `ignored_safe`。本轮不主动把后台 Goal 状态变化推送到微信/飞书，避免增加通知噪声。

用户可通过：

- `/goal`
- `/status`

查看当前 Goal 最新状态。

如果后续用户需要后台 Goal 状态主动通知，应另起通知分流设计，明确哪些状态需要推送、是否节流以及是否只推送当前 route 绑定 session。

## 映射规则

新增或内部实现一个 mapper，例如：

```text
src/codex/app-server/thread-list.ts
```

核心函数：

```ts
function codexSessionSummaryFromThread(thread: Record<string, unknown>): CodexSessionSummary
```

建议映射：

| app-server Thread 字段 | Chat-Codex 字段 | 规则 |
| --- | --- | --- |
| `id` | `id` | 必须存在；缺失则丢弃该 thread |
| `name` | `title` | 优先 |
| `preview` | `title` | `name` 缺失时使用，截断交给展示层 |
| `cwd` | `cwd` | 字符串化后使用 |
| `recencyAt` | `updatedAt` | 优先转 ISO |
| `updatedAt` | `updatedAt` | `recencyAt` 缺失时使用 |
| `createdAt` | `updatedAt` | 兜底 |
| `status.type=active` | `status.type=running` | 可带 detail |
| `status.type=idle` | `status.type=idle` | 直接映射 |
| `status.type=notLoaded` | `status.type=unknown` | detail 为 `not loaded` |
| `status.type=systemError` | `status.type=failed` | error 使用安全摘要 |

可选扩展 `CodexSessionSummary`：

```ts
interface CodexSessionSummary {
  id: string;
  routeKey?: string;
  title?: string;
  cwd?: string;
  status: CodexSessionStatus;
  updatedAt: string;
  source?: "state" | "filesystem" | "app-server";
  thread?: {
    sessionId?: string;
    modelProvider?: string;
    source?: string;
    threadSource?: string;
    cliVersion?: string;
    path?: string;
    ephemeral?: boolean;
  };
}
```

默认展示层不读取 `thread` 扩展字段，只保留未来诊断余地。

## 错误与回退

`thread/list` 失败时不能影响 `/sessions` 可用性。

处理策略：

1. `unknown method`、`method not found`、schema 不兼容：静默回退本地扫描，可在详细日志记录一次。
2. app-server 启动失败：沿用现有本地扫描能力。
3. 单条 thread 字段异常：跳过该条，保留其它结果。
4. 全部 app-server 结果不可用：回退 `discoverCodexSessions()`。
5. 不把 `thread/list` 失败推送到微信/飞书，除非用户执行的是 `/debug` 或未来显式诊断命令。

## 实施计划

### Phase 1：mapper 和 adapter 数据源

目标：

- 新增 app-server thread 到 `CodexSessionSummary` 的纯函数映射。
- `AppServerCodexAdapter.listSessions(undefined)` 优先调用 `thread/list`。
- 失败时回退 `AppServerSessionStore.listSessions(undefined, codexHome)`。
- `listSessions(routeKey)` 保持 route scoped 当前行为，不泄漏全局 thread。

涉及文件：

- `src/codex/app-server-codex-adapter.ts`
- `src/codex/app-server/session-store.ts`
- `src/codex/app-server/thread-list.ts`
- `src/codex/types.ts`
- `tests/unit/app-server-codex-adapter.test.ts`
- `tests/unit/app-server-mappers.test.ts`

### Phase 1.5：Goal 状态枚举补齐

目标：

- `CodexGoalStatus` 对齐官方 `ThreadGoalStatus`。
- mapper 不再把 `blocked`、`usageLimited` 误判为 `active`。
- `/goal` 和 `/status` 能正确展示全部官方 Goal 状态。
- `/help` 补充 Goal 状态说明。

涉及文件：

- `src/codex/types.ts`
- `src/codex/app-server/goal-api.ts`
- `src/bridge/formatters.ts`
- `src/bridge/status-text.ts`
- `tests/unit/app-server-mappers.test.ts`
- `tests/unit/bridge-formatters.test.ts`
- `tests/integration/bridge-mock.test.ts`

### Phase 2：`/sessions` 行为回归

目标：

- 验证 `/sessions all` 使用 app-server 返回的 thread 元数据。
- 验证 `/sessions` 当前聊天范围不被全局 thread 污染。
- 验证 `/use` 选择仍按 owner 规则过滤。
- 验证 `thread/list` 失败回退本地发现。
- 验证 `/session <id>` 使用 `thread/read(includeTurns=false)` 展示详情，不改变绑定。
- 验证 `/session <id>` 在 `thread/read` 失败时回退 summary。
- 验证 `/sessions cwd` 不改变普通 `/sessions`、`/sessions all` 和 `/use` 行为。
- 验证 `/sessions cwd` 目录阶段、目录内 session 阶段都能稳定翻页。
- 验证 `/sessions cwd` 中选择不可选 session 时不会越过 owner 约束。
- 验证 `/help` 展示 `/sessions cwd` 和最新 `/goal` 状态说明。

涉及文件：

- `tests/integration/bridge-mock.test.ts`
- `tests/unit/bridge-session-list.test.ts` 或现有 session list 相关测试
- `tests/unit/bridge-session-directory.test.ts` 或同等覆盖的 session flow 测试

### Phase 3：文档和测试报告

目标：

- 更新文档索引。
- 按 `docs/development-and-test.zh-CN.md` 执行构建和测试。
- 在 `reports/tests/` 新增中文测试报告。

建议测试命令：

```bash
npm run build
node --test dist/tests/unit/app-server-mappers.test.js \
  dist/tests/unit/app-server-codex-adapter.test.js \
  dist/tests/unit/bridge-formatters.test.js \
  dist/tests/integration/bridge-mock.test.js
npm test
```

如全量测试存在非本次改动相关的偶发超时，应单独重跑失败项，并在报告中写清楚。

## 验收标准

- `/sessions`、`/session`、`/sessions all`、`/all-sessions` 命令和输出结构保持不变。
- `/use`、`/resume` 编号选择行为保持不变。
- app-server 支持 `thread/list` 时，`/sessions all` 能看到官方返回的历史 thread。
- app-server 不支持或失败时，`/sessions all` 仍能回退本地历史扫描。
- 当前聊天 `/sessions` 不展示其它 route 的全局历史 thread。
- owner 冲突仍不可选。
- 默认列表不调用 `thread/read(includeTurns=true)`。
- `/session <id>` 能显示官方 thread 元数据详情。
- `/session <id>` 不调用 `thread/read(includeTurns=true)`，不展示 turns 历史，不改变当前绑定。
- `/sessions cwd` 能先列目录、再列目录下 session、再按编号切换。
- `/sessions cwd` 的目录页和 session 页翻页都保留当前快照，编号不漂移。
- `/sessions cwd` 不改变普通 `/sessions`、`/sessions all`、`/use`、`/resume` 的原有交互。
- `/goal` 能正确解析并展示官方全部状态：`active`、`paused`、`blocked`、`usageLimited`、`budgetLimited`、`complete`。
- `/help` 已同步 `/sessions cwd` 和 `/goal` 状态说明。
- 新增/修改代码有单元测试、集成测试和中文测试报告。

## 后续候选

如果后续用户确实需要“更多信息”，建议另起设计，不在本轮默认列表里堆字段。候选方向：

- `/sessions all` 支持搜索关键字，但仍复用现有分页格式。
- 仅在显式详情命令里允许 `thread/read(includeTurns=true)` 的摘要，不把 turns 历史投递到聊天渠道。

这些都不是本轮目标。
