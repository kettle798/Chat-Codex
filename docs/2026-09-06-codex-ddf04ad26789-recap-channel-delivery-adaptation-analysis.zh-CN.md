# Codex Recap（`/recap`）渠道投递适配分析

审计日期：2026-09-06
Codex 源码基线：`references/openai-codex` @ `ddf04ad26789d040f9ef6a96736f76602e35a6cc`
Chat-Codex 分析时提交：`211f31114ded31d075536ecef3038a7ee6cbf6e7`（`main`）

> 文件名中的日期和 `ddf04ad26789` 是本轮审计日期及 **Codex 参考源码** commit 短 ID，
> 不是 Chat-Codex 的提交号。

状态：**仅完成源码与现有渠道链路分析；尚未改运行代码，尚未开放 `/recap`。**

## 1. 先给结论

你说的是 **Recap**（官方命令为 `/recap`），不是 `ContextCompaction`，也不是 app-server 里的
`getConversationSummary` 元数据查询。

它的作用是：为用户生成一小段“回来看这个任务时，现在做到哪里、下一步是什么”的会话回顾。它不改变
原 Codex session 的上下文，也不执行代码、工具或审批。

**可以把 Recap 精确发回触发它的微信或飞书聊天。**现有的通用 `ChannelTarget`、`BridgeDelivery.sendText()`、
微信 `sendText()` 和飞书 `sendText()` 已足够投递普通文本，不需要为 Recap 新写渠道 SDK 协议。

但有一个关键前提：官方 Codex 的 Recap 是 **TUI 本地功能**，不是 app-server 向外发送的
`recap` 通知。Chat-Codex 当前只启动 `codex app-server`，不运行官方 TUI，所以不会“收到官方自动
Recap 再转发”。要兼容此能力，必须由 Chat-Codex 自己：

1. 保存一份受限、用户可见的 route 会话片段；
2. 以官方同样的隔离方式启动临时、只读、无工具的 app-server thread；
3. 让它输出受 JSON Schema 约束的 Recap 文本；
4. 将结果只投递给该 route 原来的 `ChannelTarget`，绝不广播到其它 route；
5. 清理临时 thread，且绝不把这段 Recap 写进原 session。

建议的第一步是先开放**手动 `/recap`**。自动 Recap 需要先明确聊天渠道里“失焦”的等价语义；不能把
官方 TUI 的窗口失焦条件不加区分地变成“每隔几分钟主动给用户发一条消息”。

## 2. 三个容易混淆的“摘要”能力

| 名称 | 官方源码中的实际含义 | 是否改原 Codex thread | Chat-Codex 当前状态 | 本文结论 |
| --- | --- | --- | --- | --- |
| **Recap** / `/recap` | 面向用户的短回顾：目标、已完成/已知、下一步或阻塞 | 否 | 未实现 | 本文要适配的能力 |
| **Context compaction** / `/compact` | 为释放上下文，把较早历史压缩后写回原 thread | 是 | 已实现 `/compact` 确认流 | 不是 Recap，不能复用为 Recap |
| `getConversationSummary` | 读取 thread 的 `preview`、rollout 路径、cwd、模型提供方等元数据 | 否 | 明确 `not_exposed` | 它没有生成的会话回顾正文，不能拿来替代 Recap |

尤其要避免把 `/recap` 接到现有 `/compact`：前者是可读的侧边回顾，后者改变 Codex 后续可见的历史上下文。
两者的用户确认、并发限制和失败处理都不应混在一起。

## 3. 官方 Codex 源码确认到的事实

### 3.1 正式名称、入口和归属

主证据位于参考源码的 TUI：

- `codex-rs/tui/src/slash_command.rs`：`SlashCommand::Recap`，说明为“立即总结当前会话”；
- `codex-rs/tui/src/chatwidget/slash_dispatch.rs`：`/recap` 发出 `AppEvent::GenerateRecap`；
- `codex-rs/tui/src/app/recap.rs`：触发判定、历史裁剪、临时 thread、结构化输出和结果校验；
- `codex-rs/tui/src/temporary_structured_request.rs`：临时结构化请求的隔离、超时和清理；
- `codex-rs/tui/src/history_cell/notices.rs`：生成后只插入 `ThreadRecapHistoryCell` 到 TUI transcript。

在同一份源码中，`recap` 不存在于 `codex-rs/app-server-protocol/` 的 ClientRequest、ServerRequest 或
ServerNotification 定义里。也就是说，没有 `thread/recap` RPC，也没有 `thread/recapped` 通知可供
Chat-Codex 被动转发。

`getConversationSummary` 虽然名字像摘要，但在
`codex-rs/app-server/src/request_processors/thread_processor.rs` 中只是从持久 thread 读出
`conversationId`、`preview`、路径、时间、cwd、provider、CLI 版本和 git 信息；它不调用模型，也没有
“已完成什么/下一步是什么”的正文。因此不能误接为 Recap。

### 3.2 手动 `/recap` 的官方语义

官方 TUI 的手动入口具有下列边界：

- 只作用于当前显示的 thread；
- 当前 task 仍在运行或有用户 turn 待处理时拒绝，提示先等待任务完成；
- 同一时刻只允许一个 Recap 生成请求；
- 没有可用用户/助手会话内容时拒绝；
- 即使 `tui.auto_recap = false`，手动 `/recap` 仍可用；
- 成功后在 TUI 中显示标题 `Conversation recap` 和正文；失败时只向手动发起者显示失败提示。

它并不向原 thread 追加“请总结”这一轮，也不把结果作为原 thread 的 assistant message 写回。

### 3.3 官方自动 Recap 的实际触发条件

自动行为是 **TUI 窗口失焦策略**，不是每个 Codex session 的服务端策略。

`codex-rs/tui/src/app.rs` 只在收到 `TuiEvent::FocusLost` 时开始检查；窗口重新获得焦点会取消尚未执行的
检查，并取消正在生成的自动 Recap。`tui.auto_recap` 未设置时默认启用，但可关闭；这个开关不会关闭手动
`/recap`。

在 `recap.rs` 中，自动生成还必须同时满足：

1. 当前 thread 已完成至少 3 个 turn；
2. 上一次成功自动 Recap 后，又至少完成了 2 个 turn；
3. TUI 已失焦，且当前没有用户 turn 正在等待或运行；
4. 从“最后一次完成 turn”和“失焦”两者中较晚的时刻起，已经过去 3 分钟；
5. 生成前后 thread、turn 修订号和完成 turn 数仍一致，否则丢弃过期结果；
6. 自动生成失败后，才会在同一修订号下等待 30 秒重试一次。

这解释了为什么 Chat-Codex 不能机械照搬“3 分钟后自动发摘要”：微信和飞书聊天没有 TUI 的
`FocusLost` / `FocusGained` 事件。若直接把“本轮完成”当作失焦，用户会在正常聊天后被无请求地推送摘要，
语义和打扰程度都不同。

### 3.4 官方如何生成正文

官方不是把整个 Codex rollout 原样交给模型，而是从 TUI transcript 中选取用户消息和最终助手消息：

- 最多回看 8 个用户 turn；
- 忽略工具输出、审批、进度、推理内容和已有 Recap；
- 构造给模型的历史文本最多 900 bytes，并优先为最近用户消息保留约一半预算；
- 要求使用用户语言，在一两句、最多 40 词内说明目标、完成/已知、下一步或阻塞；
- 结果通过 JSON Schema 约束为 `{ "recap": string }`，正文最多 320 个字符；
- 空字符串、无效 JSON 或超过边界的结果不会直接显示。

这段文本是面向用户的结果摘要，而不是 reasoning 内容，也不是 context compaction 生成的内部摘要。

### 3.5 官方如何隔离这次模型调用

Recap 使用一个新建的 `ephemeral: true` 临时 thread，而不是原 thread。它沿用当前模型/模型提供方和 cwd，
但在 `temporary_structured_request.rs` 中执行了额外隔离：

- 先读取有效配置，找出已配置的 MCP server，再显式禁用全部 MCP；
- 禁用 shell、web search、skills、plugins、apps、hooks、memory、multi-agent、image generation、
  request-user-input 等工具/功能面；
- 默认 `approvalPolicy: never` 且只读 sandbox；
- 临时 thread 不继承原 session 的可执行工具面；
- `turn/start` 使用 `outputSchema`，只收集该临时 turn 的最终 `agentMessage`；
- 生成或超时后，无论成功失败都 best-effort 调 `thread/unsubscribe`；
- 结构化请求和正文各有 30 秒、8 KiB 等上界，避免无限等待或不受限输出。

这一层隔离是 Recap 适配的必要部分。不能为了“简单”在原 session 执行普通 prompt，也不能让临时摘要 turn
继承原会话的 shell、MCP、文件写入或审批权限。

## 4. Chat-Codex 当前能力与缺口

| 环节 | 当前代码事实 | 对 Recap 的意义 |
| --- | --- | --- |
| 聊天命令 | `BridgeCommandRouter` 没有 `recap` case，`BridgeCommandHandlers` 也没有对应 handler | 需要新增 `/recap` 命令入口 |
| Codex 抽象 | `CodexAdapter` 只有 `run`、`compactSession` 等，没有 `generateRecap` | 需要新增可选的 Recap 能力，不能伪装成普通 `run` |
| app-server adapter | `AppServerCodexAdapter` 已能发 `thread/start`、`turn/start`，也能接收通知 | 协议基础足够，但需专门管理临时 thread 的通知和清理 |
| 临时 thread 通知 | `AppServerTurnController` 只为已注册、正常 session turn 路由事件 | 临时 Recap thread 不能落入普通 turn/background turn，否则会污染状态、可能遗留 early event |
| 会话历史 | `Bridge` 当前只保存最新 route message/target；`TranscriptSink` 是输出日志，不是可查询的会话存储；`FileStateStore` 也只持久化 route 身份和绑定，不持久化正文 | 需要新增受限的 Recap history；当前不能凭空生成可靠回顾 |
| `/compact` | 已经通过 `thread/compact/start` 改变原 thread | 必须与 Recap 保持独立 |
| route 所有权 | 一个 Codex session 只归属一个 route；`MemoryStateStore`/`SessionBindings` 已保存 owner | 可作为“只投递原渠道”的安全基础 |
| 渠道投递 | `BridgeDelivery.sendText(target, text)` 按 `ChannelTarget` 分发 | Recap 可走同一通用文字链路 |

当前项目内对 `recap` 的代码搜索没有任何实现；唯一相关项是
`src/codex/app-server/protocol-capabilities.ts` 中把 `getConversationSummary` 标成不开放。该现状是正确的，
但也说明 `/recap` 不能只补一行协议分类就完成。

## 5. 是否能发到“对应渠道”：可以，且应这样做

### 5.1 路由规则

Recap 的投递键必须是产生该回顾的原始 `routeKey`，不是“当前最后活跃的聊天”，也不是同一台机器上的
全部 session。

```text
某微信/飞书入站消息
  -> routeKey + ChannelTarget + 当前 sessionId
  -> 生成该 route 的 Recap
  -> 同一个 ChannelTarget
  -> 同一个微信联系人 / 飞书 chat_id
```

具体规则应为：

1. **手动 `/recap`**：捕获该命令消息生成的 `ChannelTarget`；成功后回复这个 target。
2. **将来的自动 Recap**：创建定时检查时就捕获 route、session、target 和历史 revision；发送前再次确认
   route 仍绑定同一 session、revision 未变化、没有运行中的任务。任何一项不满足就丢弃，不换到其它渠道。
3. 进程重启后若没有可靠的 live target，不猜测联系人或 chat_id，不跨 route 补发；只在用户下一次消息后
   重新建立可投递上下文，或由用户手动 `/recap`。
4. 不向原 session 的其它历史绑定、session owner 之外的 route、群内其它成员或全局通知广播。

### 5.2 微信和飞书不需要各写一套 Recap 业务

| 渠道 | 现有文字投递行为 | Recap 的接入方式 |
| --- | --- | --- |
| 微信 | `WeixinAdapter.sendText()` 以 target 的 recipient/conversation 发送普通文字，并已有 adapter 自己的出站串行与重试 | 直接走 `BridgeDelivery.sendText()`；无需卡片或新 API |
| 飞书 | `FeishuAdapter.sendText()` 发送 `post` 文本；target 带来源 message id 时优先 reply，失败自动回退到 chat create | 手动 `/recap` 会自然回复命令消息；自动 Recap 使用捕获的目标，仍由现有 fallback 保证可见 |

Recap 不是审批，飞书不应做审批卡；也不是高频 progress，不应套用 `/progress silent` 的抑制策略。它是一条正常的、
低频的最终文本。渠道差异仍留在 adapter，Bridge Core 只使用通用 `ChannelTarget` 和 `sendText()`。

## 6. 建议的 Chat-Codex 设计

### 6.1 建议先落地的交互

先做手动 `/recap`，只在当前 route 空闲时可用：

```text
用户：/recap
Chat-Codex：正在生成本会话摘要…
Chat-Codex：会话摘要
          已完成……；下一步……
```

约束：

- 没有绑定 session：说明先 `/new` 或 `/resume`；
- 正在运行、等待审批、等待用户输入、上下文压缩或已有 Recap：拒绝本次请求，不排进普通 prompt 队列；
- 没有足够的可见会话内容：提示暂无可回顾内容；
- app-server adapter 不支持：明确提示当前接入方式不支持 `/recap`；`ExecCodexAdapter` 不做伪实现；
- 手动生成失败：只回复本 route 的失败原因，不修改原 session 状态。

建议正文使用固定标题 `会话摘要`，随后原样发送模型返回的短文本；不要加入“已自动修改代码”之类桥接层推断。

### 6.2 受限的 Recap history

应新增 route + session 作用域的内存 `RecapHistory`，而不是从 Console transcript 或渠道原始日志反向解析。

记录规则建议对齐官方语义：

- 记录已接受进入 Codex 的**用户可见文本**，不要记录 group 注入前缀、`/sendfile` 内部提示、渠道 context token、
  本地上传路径或原始 SDK payload；
- 记录正常 turn 的**最终 assistant 文本**；不记录 reasoning、工具输出、命令输出、审批内容、进度、旁白或已有 Recap；
- 按 `(routeKey, sessionId)` 隔离；`/new`、`/use`、`/resume` 切换 session 时不能混用旧 session 内容；
- 使用官方同等的 8 个用户 turn、900 bytes 输入和 320 字符输出上界，并保证 UTF-8 截断不破坏字符；
- Recap 本身绝不回写此 history，避免下一次出现“摘要的摘要”。

第一版建议只保留进程内历史。重启后的完整历史恢复应等 `thread/turns/list` / `thread/items/list` 分页适配完成后
单独设计；不要为了 Recap 重新使用无上限的 `thread/read(includeTurns: true)`，也不要把含渠道正文的历史默认
写入状态 JSON。

### 6.3 app-server adapter 的隔离实现

建议把真实 RPC 细节放在独立的 `src/codex/app-server/recap.ts`，由
`AppServerCodexAdapter.generateRecap()` 调用。抽象层可增加：

```ts
generateRecap?(input: {
  sessionId: string;
  history: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
}): Promise<{ text: string }>;
```

这里的 `history` 由 Bridge 产生，adapter 只负责安全地调用 app-server，避免 adapter 偷读或持久化渠道内容。

内部流程应为：

1. 校验原 session 已加载，并读取其当前有效模型/提供方/cwd；模型名不能写死，应跟随现有动态模型策略；
2. 建立临时 `ephemeral` thread，按官方意图显式关闭 MCP、工具、web、skills、memory、plugins、hooks、
   multi-agent 等能力，使用 `approvalPolicy: never` 和只读 sandbox；不能因自定义 profile 或旧 server 而放宽权限；
3. 对临时 thread 发带 `outputSchema` 的 `turn/start`，只接受最终 `agentMessage` 中的 JSON；
4. 在 `finally` 中请求 `thread/unsubscribe`；清掉 timeout、临时 collector 和错误状态；
5. 原 session 不发送 `turn/start`，不更改其 `currentTurnId`、状态、模型策略、上下文或 session owner。

临时 thread 的通知需要独立 collector。当前 `AppServerTurnController` 面向正常 session turn；若临时 thread 的
`item/*`、`turn/*` 通知进入它，会被当成未知 background turn 或留下 early event。实现时必须先按临时
`threadId`/`turnId` 截获，收集其 `agentMessage` 和 `turn/completed`，再阻止它进入正常 `turns`、审批、
pending-input 和渠道 background delivery 链路。

理论上临时 thread 不应产生审批或 `request_user_input`。若仍收到这类 server request，必须 fail closed：取消/拒绝
该临时请求并让 Recap 失败，不能把它变成用户聊天里的真实审批卡或输入问题。

### 6.4 自动 Recap 的后续设计，不在第一步偷偷开启

若以后确实要支持自动 Recap，建议把它定义为 Chat-Codex 自己的“route 不活跃”功能，而不是声称已经收到
官方 TUI 的失焦事件：

- 仅在用户显式开启该 route 的自动 Recap 后运行；默认关闭，避免无请求推送；
- 候选条件可沿用官方数值：至少 3 个已完成 turn、距上次 Recap 至少 2 个完成 turn、空闲 3 分钟；
- “空闲”定义为没有普通 turn、background turn、审批、输入、压缩，也没有新的入站消息；
- 定时器开始时捕获 `historyRevision`、session 和 target；任一变化即取消或丢弃结果；
- 自动成功才发送一条 `会话摘要`，不另发“正在生成”；自动失败只记录日志，最多按官方的同修订号 30 秒重试一次；
- 应单独决定 route 级开关、TUI 可见状态、重启后是否恢复定时器和用户如何关闭，不能与定时任务功能混为一谈。

## 7. 预计代码边界

| 位置 | 责任 | 是否需要渠道特例 |
| --- | --- | --- |
| `src/bridge/recap-history.ts` | 纯函数：记录、过滤、按官方上界构造历史 | 否 |
| `src/bridge/recap-manager.ts` | 每 route/session 的 in-flight、revision、target 捕获、自动调度（后续） | 否 |
| `src/bridge/commands/recap-command.ts` | `/recap` 的空闲校验、提示和回执 | 否 |
| `src/bridge/command-router.ts`、`src/bridge/bridge.ts`、`src/bridge/route-queue.ts` | 注册命令，记录可见用户/最终助手消息，调用 manager | 否 |
| `src/codex/types.ts` | 可选 `generateRecap` 抽象及结果类型 | 否 |
| `src/codex/app-server/recap.ts` | 临时 thread、结构化输出、通知 collector、超时/清理 | 否 |
| `src/codex/app-server-codex-adapter.ts` | 将 Recap RPC 与普通 turn controller 隔离 | 否 |
| `src/codex/exec-codex-adapter.ts` | 明确不支持，不模拟成原 session prompt | 否 |
| `src/channels/weixin/`、`src/channels/feishu/` | 第一版不改运行逻辑，只补链路验证 | 否 |

`src/codex/app-server/protocol-capabilities.ts` 也要相应更新：`thread/start` 和 `turn/start` 已被正常 adapter 使用，
Recap 新增的是它们的**内部、隔离用法**；`thread/unsubscribe` 和必要的配置读取不能再只是“未开放的用户命令”。
它们仍不应暴露为聊天 RPC 命令。

## 8. 必须覆盖的测试

实现时按项目 `development-and-test.zh-CN.md` 补中文测试报告。至少要覆盖：

1. **Recap history 单元测试**：只选用户/最终助手文本；忽略工具、审批、旁白和旧 Recap；8 turn / 900 bytes /
   UTF-8 截断边界；不同 route 与不同 session 不串线。
2. **app-server fake 协议测试**：临时 `thread/start` 是 ephemeral、只读、无审批、无 MCP/工具；
   `turn/start` 带 JSON Schema；只解析合法正文；无论成功、超时、无效 JSON 或失败都发
   `thread/unsubscribe`。
3. **临时通知隔离测试**：临时 turn 的 delta/completed 不更新原 session status，不进入普通
   `CodexEvent`、background turn、审批或 pending input；意外 server request 被安全取消。
4. **Bridge 集成测试**：`/recap` 只投递原 route；busy/no-history/不支持/过期结果都不发送错误摘要；
   `/recap` 不进入正常 prompt 队列，也不改变原 session 的上下文。
5. **渠道适配测试**：mock + 微信 adapter fake 验证 recipient/route；飞书 fake 验证 reply target 和
   reply 失败后的 chat-create 回退。真实微信、飞书帐号测试仍按规范由用户协助补测。
6. **自动模式（若以后开启）**：使用假时钟测试 3 分钟阈值、最少 turn 数、两 turn 间隔、取消、重试和
   route/session/revision 变化后的不投递；不使用真实等待。

## 9. 下一轮需要确认的产品决定

这份分析建议先做手动 `/recap`，但在开始实现前需要逐项确认：

1. 第一轮是否只开放手动 `/recap`；
2. 自动 Recap 是否需要，以及是否明确默认关闭；
3. 自动生成成功时，是否固定发送 `会话摘要` 标题 + 正文；
4. 重启后没有内存 history 时，是提示用户暂无本轮回顾，还是等后续“分页历史读取”协议适配完成后再补历史恢复。

无论上述交互如何决定，已经确定的不可变边界是：**Recap 只投递原 route、只使用隔离临时 thread、不会修改原
Codex session，也不会把内部推理或 context compaction 摘要直接发到渠道。**
