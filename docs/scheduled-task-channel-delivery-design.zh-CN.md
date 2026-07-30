# 定时任务与精准渠道投递设计（讨论草案）

状态：讨论中，尚未实现。

更新：2026-07-26

参考 Codex 版本：`references/openai-codex` 的 `61a44880a85d2fd0d8770908dea5733495e571c8`。

修订说明：Codex App 产品层原生支持 Scheduled tasks。本草案此前只核查了
`codex app-server` 的 RPC，错误地把“该 RPC 没有调度管理端点”表述成了
“Codex 没有定时能力”。以下内容已按两层能力重新整理。

本次讨论结论：定时任务不能按“先做一个简版、以后再补全”定义。功能完成时必须同时具备
一次性与周期规则、持久化恢复、自然语言工具入口、简短聊天管理命令、TUI 管理、任务隔离
会话、审批/用户输入精准回推、并发安全和运行历史。下面的实施顺序只表示工程依赖，不表示
可以省略后面的产品能力。

## 1. 目标

让用户可以在某个聊天会话中创建定时任务。到点后，Chat-Codex 应当：

1. 对 `turn` 在冻结的 task session 中执行保存的 prompt；只有用户明确选择时才写入固定的 current session。
2. 复用现有权限、审批、队列、上下文和输出处理。
3. 将最终结果、错误、审批和必要通知准确投递回创建任务的同一个渠道会话。
4. 在服务重启后仍保留任务、目标会话和投递归属。

这里的“同一个会话”指 Chat-Codex 的 `routeKey`，而不是模糊的“最近使用过的渠道”。例如：

```text
weixin:primary:direct:wx_user_a
feishu:work:direct:oc_user_b
feishu:work:group:oc_group_c
```

它们是三个独立投递目标，绝不因 session 名称、显示名或最近活动时间相同而互相串发。

## 2. Codex 原生能力与 app-server 边界

### 2.1 Codex App 原生支持 Scheduled tasks

Codex Desktop App 和 ChatGPT Web 的产品层原生支持 [Scheduled tasks](https://developers.openai.com/codex/app/automations)。用户可以在
Codex chat 中描述任务、时间和目标：

- 任务可在未来某个时间执行，也可按周期执行。
- 可以创建“回到当前 chat”的任务；每次运行会复用该 chat 的上下文。
- 也可以创建独立任务；每次运行使用独立 chat，并在 Scheduled 视图显示结果。
- Desktop 上需要电脑开机、应用持续运行，才能访问本地项目文件。

因此，在该功能已为当前账户/工作区启用的 Codex Desktop App 正常 chat 中，用户说“3 分钟后提醒我”，
正确的产品行为应是创建一个一次性的、回到当前 chat 的 Scheduled task；三分钟后
它在该 Codex chat 中产生提醒或后续处理结果。

官方文档同时明确：Codex CLI 没有 Scheduled 的管理界面；该能力由 Desktop App 或
Web 的宿主产品提供，而不是每个 Codex 客户端自动获得的通用本地 timer。

### 2.2 app-server 没有调用原生 Scheduled tasks 的管理 API

当前 app-server 的稳定请求、通知和 server request 协议中，没有 `schedule/create`、`task/create`、`cron/create`、`schedule/run` 等可用于“到点启动 Codex turn”的通用能力。

最新版源码里确实有 `ScheduledTaskSummary`，可表达 hourly、daily、weekdays、weekly 等规则：

```text
references/openai-codex/codex-rs/app-server-protocol/src/protocol/v2/plugin.rs
```

但它只出现在远程插件目录的 `plugin/read` 详情中：

- 它是插件目录返回的展示元数据。
- 本地插件详情明确返回 `scheduled_tasks: None`。
- 没有对应的创建、启停、触发或投递协议。

因此它不能作为 Chat-Codex 的任务调度器。

这还意味着 Chat-Codex 当前不能通过 app-server：

- 创建、查询、暂停或删除 Codex App 的原生 Scheduled task。
- 将 Chat-Codex 的 `routeKey` 注册为原生任务的投递目标。
- 订阅一个原生任务启动、完成或失败后回传的事件。

原生任务的结果属于 Codex App/Web 的 chat 或 Scheduled inbox；当前没有一条公开
app-server 事件能让 Chat-Codex 据此可靠地转投微信、飞书或后续渠道。

### 2.3 `dynamicTools` 只是可选的自定义工具入口，不是原生 scheduler

最新版 app-server 提供了实验性动态工具协议：

```text
thread/start.dynamicTools
  -> item/tool/call (server request)
  -> client response
```

它只提供“客户端注册一个函数，模型调用后 app-server 把调用转交客户端处理”的
通用扩展点；它本身不会保存 timer、不会在未来唤醒进程，也不会投递消息。

例如本文使用的 `chat_codex.schedule` 只是一个**尚未实现、由 Chat-Codex 自己定义**
的假想工具名。它不在官方 Codex 源码中，也不是对 Codex App 原生 Scheduled tasks
的调用。即使未来采用它，真正的 timer、任务存储和渠道投递仍全由 Chat-Codex 实现。

Chat-Codex 已在 `initialize` 时启用 `experimentalApi: true`，因此可以在新建 session
时注册例如 `chat_codex.schedule` 的动态工具，并在收到 `item/tool/call` 后交给
中间件实现。这个方案的含义是：

- 用户仍可自然地说“3 分钟后提醒我”或“每天 9 点检查 CI 并把结果发到这里”。
- Codex 以结构化工具调用请求创建、查看或修改任务。
- Chat-Codex 宿主保存任务、在到点时触发执行，并投递回原渠道会话。

它最多只能复用“用户用自然语言提出定时意图，模型发出结构化工具调用”的交互形式；
不能复用 Codex App 的内部 Scheduled 服务。调度持久化和渠道投递仍必须由
Chat-Codex 持有。

### 2.4 `currentTime/read` 不是定时任务

最新版 app-server 增加了实验性 `currentTime/read` server request。它只在一个已经开始的 turn 因“时间提醒”需要外部时钟时，向客户端索取当前 Unix 时间；客户端不响应时，该 turn 反而会停止。

它不能：

- 在未来某个时刻唤醒 app-server。
- 创建或保存任务。
- 启动新的 turn。
- 向聊天渠道发送通知。

不能把它误当成 scheduler。

### 2.5 结论

三个场景要明确区分：

| 场景 | 合理实现 |
| --- | --- |
| 用户直接使用 Codex Desktop/Web | 使用 Codex 原生 Scheduled tasks。 |
| 用户从微信、飞书等 Chat-Codex 渠道发起，且结果必须回到该渠道 | 当前只能由 Chat-Codex 中间件持久化调度；动态工具只是可选的自然语言入口。 |
| 仅使用 app-server 的第三方客户端 | 不能直接委托 Codex App 的原生调度器；使用宿主调度器，或等待未来公开 API。 |

对 Chat-Codex 而言，Codex adapter 继续只承担：

```text
在已确定的 session 中启动和观察 turn
```

渠道 adapter 继续只承担：

```text
向已确定的 ChannelTarget 发送文本、卡片、媒体、typing
```

这样既不否认 Codex 的原生能力，也不会把渠道投递的责任错误地交给一个没有
`routeKey` 概念的 Codex App 服务。

## 3. 现有能力与缺口

### 已有能力

- `routeKey` 已包含渠道实例、账号、会话类型和会话 ID。
- `SessionBindings` 已保证一个 Codex session 同一时间只有一个 owner route。
- `ChannelRegistry` 已能按 `ChannelTarget.channelId` 路由到对应 adapter。
- `BridgeRouteQueue` 已串行化同一 route 的普通任务，并复用全局 `TurnScheduler`。
- `BridgeBackgroundTurns` 已能把 Codex background/Goal 的最终回复、错误、审批、进度和通知投递到原 route。
- `FileStateStore` 已持久化 route、session owner、权限和渠道实例信息。

### 当前缺口

`BridgeBackgroundTurns` 的目标来自运行期内存中的 `routeMessages` 和 `routeTargets`。它适合正在运行的 Goal 自动续跑，不足以支持“进程重启后一小时仍要准确投递”的定时任务。

定时能力必须额外持久化一个不含临时回复上下文的目标快照。

## 4. 推荐架构

```text
用户渠道消息
  -> BridgeRouteQueue（只处理用户前台 session）
  -> Codex 调用“由 Chat-Codex 自己注册”的 chat_codex.schedule 工具
  -> AppServerCodexAdapter 收到 item/tool/call
  -> ScheduleToolController（按冻结的 TurnOrigin 取得 route/actor/target）
  -> ScheduleService
  -> ScheduleStore（任务、运行记录、投递 outbox）

到点事件
  -> DurableScheduler（计算下一次到点）
  -> ScheduledRunDispatcher
  -> TaskExecutionQueue（按 task session / taskId 串行，不占用用户前台 route worker）
  -> 共享 TurnScheduler（前台消息优先，统一并发上限）
  -> CodexAdapter.run(taskSessionId, frozenPrompt)
  -> ScheduledRunContextRouter（按 runId / turnId 路由审批、输入、final、error）
  -> BridgeDelivery -> ChannelRegistry -> 对应 ChannelAdapter
```

`chat_codex.schedule` 是自然语言入口，`/timer` 是所有 session 都可用的命令管理入口。
前者让用户直接说出定时意图，后者覆盖旧 session、列表和明确操作；两者都调用同一个
`ScheduleService`，动态工具不会减少任何调度实现工作。

关键约束：`DurableScheduler` 不直接调用任何渠道 API，也不直接调用 `AppServerCodexAdapter`。它只能创建一个中间件内部的 scheduled invocation，由任务执行链决定何时启动、如何审批以及怎样投递。

这样可以避免：

- 微信、飞书各自维护一套 timer。
- 定时任务绕过 `/permission`、审批或全局并发限制。
- 定时任务占用或污染用户正在聊天的 Codex session。
- 长期任务依赖“当前 route 最近一条消息”寻找 target，导致新消息覆盖原任务投递目标。
- 未来新渠道重复实现调度逻辑。

### 4.1 动态工具契约与安全边界

自然语言入口由 Chat-Codex 自行注册一个受限命名空间：

```text
chat_codex
```

命名分层固定如下，避免把协议术语暴露给普通用户：

| 场景 | 名称 |
| --- | --- |
| 聊天帮助、TUI、用户文案 | 定时任务 |
| 技术设计和代码职责 | Chat-Codex 定时任务动态工具 |
| 用户前台 session 的主要函数 | `chat_codex.schedule` |
| 时间读取辅助函数 | `chat_codex.get_time` |
| 条件投递 task session 的内部回调 | `chat_codex.schedule_report` |

因此用户不需要知道或输入“dynamic tool”；这是 app-server 对该扩展点的技术名称。

这里的“注册”不是安装 Codex 插件、Skill、MCP server，也不会写入用户的
`~/.codex/config.toml` 或修改 Codex 二进制。Chat-Codex 已是 app-server 的客户端，
只在它发起 `thread/start` 时把 `dynamicTools` 放入该次 RPC payload；工具只属于这个
Chat-Codex session，其他 Codex App、CLI 或项目不会自动看到它。

但“无安装”不等于“对模型完全无感”：模型必须知道工具和 schema 才能主动调用它。
正式能力应将两个简短工具放在独立 `chat_codex` namespace 下并直接暴露给符合条件的
新 session，保证用户随口说出定时意图时模型能稳定发现。不能依赖 tool search 的隐式
发现，也不能为了表面无侵入而改用模型最终文本暗号或中间件中文正则解析。

模型侧只暴露两个小而确定的函数：

```ts
chat_codex.get_time()
chat_codex.schedule({ action, proposal?, draftId?, scheduleId?, mutation? })
```

这是**用户前台 session**的工具集。task session 不获得任何创建或管理任务的工具；仅当任务
选择 `on_problem`、`on_change` 或 `digest` 时，才额外获得内部 `chat_codex.schedule_report`
回调。它只能报告当前 `runId` 的结构化结果，不能读取或修改其它任务。

`action` 包括 `propose`、`confirm`、`cancel_draft`、`list`、`get`、`update`、`pause`、
`resume`、`delete`、`run`、`snooze`、`history`；schema 用 `oneOf` 按 action 收紧必填字段。
其中 `propose` 的 `proposal` 包含名称、时间规则、execution 和 delivery policy；其余 action
只能操作由冻结 actor 有权管理的任务。工具内部可以拆成独立 service 方法，但不需要把十多个
函数同时暴露给模型。

`get_time` 返回由服务端决定的当前时间和默认 IANA 时区。模型遇到“明天 9 点”这类
绝对时间时先读取它；“3 分钟后”直接传 `delaySeconds: 180`，不需要模型猜当前日期。

当 `action: "propose"` 时，`schedule` 只接受经过 schema 约束的结构化时间：

```ts
type ScheduleSpec =
  | { kind: "after"; delaySeconds: number }
  | { kind: "at"; localDateTime: string; timeZone: string }
  | { kind: "interval"; everySeconds: number }
  | { kind: "daily"; localTime: string; timeZone: string }
  | { kind: "weekly"; weekdays: string[]; localTime: string; timeZone: string }
  | { kind: "monthly"; dayOfMonth: number; localTime: string; timeZone: string; missingDay: "skip" | "last_day" }
  | { kind: "yearly"; month: number; dayOfMonth: number; localTime: string; timeZone: string };

type ScheduledExecution =
  | { type: "reminder"; message: string }
  | { type: "turn"; prompt: string; contextMode?: "task_session" | "current_session" };
```

这不是对 Codex 原生 scheduler 的 API 调用，而是 Chat-Codex 自己的函数。模型负责把
自然语言转换为这些字段；中间件负责范围、日期、时区、最小/最大延迟和重复规则验证，
不从最终回复文本中提取约定标记。

实际调用链必须是本地 RPC 回调，而不是模型直接访问存储或渠道：

```text
Codex model
  -> app-server item/tool/call { threadId, turnId, tool, arguments }
  -> AppServerCodexAdapter 的 DynamicToolHost
  -> ScheduleService.validateAndPersist(...)
  -> ScheduleStore 原子写入任务/草案
  -> item/tool/call result { success, contentItems }
  -> Codex model 根据结果回复用户
```

当前 `AppServerCodexAdapter` 会把 `item/tool/call` 作为未支持请求拒绝；实现时只替换
该分支为一个显式注入的 `DynamicToolHost`，其余未知工具仍拒绝。这样 schedule 功能不会
变成 adapter 中默认放行任意客户端工具的后门。

工具参数绝不接受 `channelId`、`conversationId`、`recipient`、`routeKey` 或任意
`sessionId`。每个前台 turn 在启动时都要冻结一个 `TurnOrigin`：`turnId`、route、
target snapshot、sender、session 和 `source: "user"`。收到 `item/tool/call` 后，
工具 host 只能按 `(threadId, turnId)` 读取该 origin；若不存在、route 不可信或 sender
无权操作，调用失败，不创建任务。这使模型不能通过参数把任务投递到另一个用户、群聊
或渠道。

### 4.1.1 必须写入工具描述的执行上下文契约

动态工具不是只给 Codex 一个“创建 timer”的按钮。工具 `description` 和每个 `turn`
参数的 schema 描述必须明确以下事实，否则模型会错误地把“当前对话上下文”当成未来仍可用：

1. `reminder.message` 是到点后直接发给创建者原渠道的最终文本，不会经过 Codex 二次改写。
2. `turn.prompt` 是到点后会传给 Codex 的**完整、持久化执行指令**；默认在隔离的 task session 中执行，不能写“按上文继续”“看看刚才那个项目”这类依赖主聊天历史的话。
3. 工具调用时，Bridge 会从当前可信用户 turn 冻结 `target`、创建者、cwd、模型、权限和 collaboration mode；模型不得、也不能在参数中指定渠道、收件人、route 或 session。
4. `contextMode: "current_session"` 是显式隔离豁免：只有用户明确要求“回到当前会话继续”时才能提议，并且确认文案必须提示它会写入该 session。省略该字段一律使用 `task_session`。
5. scheduled turn 内不注册管理任务的写操作；模型无法通过一次定时执行递归创建、确认、修改或删除任务。

建议工具描述包含等价的约束文字：

```text
For a turn, provide the exact self-contained instruction that will be delivered later.
It runs in an isolated task session by default and does not inherit the foreground chat history.
Do not include channel, recipient, route, or session identifiers. Use current_session only when
the user explicitly asks to continue in this conversation.
```

这不是让模型决定安全边界；它只是让模型在生成草案时知道 Bridge 实际会传递什么。最终的
target、session profile 和确认结果仍只由中间件持久化和执行。

确认策略按风险分级：一次性的 `reminder` 只会向创建者的原 route 发送一条文本，
可立即创建并回显取消方式；`turn`、任何重复规则、或会使用更高权限的任务先生成
`pending_confirmation` 草案，回显时间、时区、执行方式、task session（或显式 current session）和固定投递
会话，用户确认后才启用。管理操作必须再次校验任务创建者和 route 权限，不能只凭
`scheduleId`。

为了避免模型自我复制定时任务，`source: "schedule"`、Goal/background turn 和没有
可信用户 origin 的 turn 一律不能调用创建、确认或修改任务的函数；最多允许读取状态。

### 4.2 推荐的自然语言交互

用户说：

```text
3 分钟后提醒我喝水
```

推荐流程：

```text
Codex -> chat_codex.schedule({ action: "propose", proposal: {
  schedule: { kind: "after", delaySeconds: 180 },
  execution: { type: "reminder", message: "喝水" }
}
})
-> ScheduleService 校验并立即持久化
-> 工具结果：任务已创建、到点时间、任务 ID
-> Codex 正常回复“已设置，3 分钟后提醒你。”
-> 到点后 BridgeDelivery 向冻结的 ChannelTarget 发送提醒
```

用户说：

```text
每天早上 9 点检查 CI，失败才通知我
```

推荐流程：

```text
Codex -> chat_codex.get_time()
Codex -> chat_codex.schedule({ action: "propose", proposal: { schedule: daily, execution: turn } })
-> ScheduleService 创建 awaiting_confirmation 草案
-> Codex 回显将运行的 prompt、时区、原渠道、task session 和冻结权限配置
-> 用户回复“确认”或使用确认按钮/兼容命令
-> Bridge 仅为该 draft 启用任务
```

“确认”不应由模型自由猜测。Bridge 应只在同一 route、同一 sender 存在未过期草案时
拦截明确确认/取消词；否则按普通消息交给 Codex。飞书可随后增加同一 draft 的确认卡片，
微信先使用文本确认即可。

### 4.3 传输与暴露策略

调度工具使用现有 app-server stdio 连接上的 JSON-RPC `item/tool/call` 回调：

- 不启动 HTTP server，不增加端口、鉴权、网络暴露或重试协议。
- 不 spawn CLI 子进程，不解析 stdout，也不会触发 shell 审批路径。
- 不注册 MCP server；MCP 更适合可共享的外部能力，而此功能只属于当前 Chat-Codex
  进程及其 route/session 安全模型。

定时功能正式发布后，`scheduling` 默认启用，不需要用户发送开启命令或修改配置。
每个符合条件的新 Chat-Codex session 都在 `thread/start` 附带这两个工具；保留一个
仅供运维故障熔断的全局禁用开关，不把它做成普通用户设置。

当前满足以下条件时附带工具：

1. 运维熔断开关未关闭。
2. 这是由 Chat-Codex 新建的 session，而非旧 session 的 `thread/resume`。
3. 当前 route 已可信，且发起者拥有该 route 的定时任务管理权限；私聊和已具备 group access 规则的群聊走同一套授权检查。

工具描述必须明确：只在用户**明确要求**未来提醒、延后执行、重复检查或管理已有任务时
调用；时间被提及、讨论某个计划、或假设性提问都不能自动创建任务。缺少时间、任务
内容或时区时，模型应先提问，不调用 `propose`。

### 4.4 现有 session 的兼容边界

`dynamicTools` 当前只能随 `thread/start` 注册；最新版 `thread/resume` 没有对应
的动态工具更新字段。因此发布后新建的 Chat-Codex session 可以获得自然语言定时
能力，已经存在的 session 不能通过公开协议原地补装该工具。这是协议约束，不是
用户需要手动“开启定时功能”。

兼容策略应是：

1. 新 session：可使用 `chat_codex.schedule` 动态工具。
2. 已有 session：完整支持受控的 `/timer` 创建和管理命令，直到用户显式新建或迁移 session；这不是功能降级，只是自然语言工具入口受 app-server 协议限制。
3. 不直接改写 Codex rollout 文件伪造工具配置；那会破坏 app-server 的持久化契约。

实现前必须用真实 app-server 做一个动态工具最小验证：注册、调用、参数校验、
成功/失败响应、重启后恢复以及普通 turn 输出是否都符合预期。该接口仍标记为
experimental，不能只依据 schema 假定行为稳定。

## 5. 持久化模型

建议新增独立领域目录 `src/schedules/`，不要把调度、JSON 文件读写和 Bridge 事件堆进 `bridge.ts` 或某个渠道 adapter。

建议文件：

```text
src/schedules/types.ts
src/schedules/schedule-store.ts
src/schedules/file-schedule-store.ts
src/schedules/durable-scheduler.ts
src/schedules/schedule-service.ts
src/schedules/schedule-tool-controller.ts
src/codex/app-server/dynamic-tool-handler.ts
src/bridge/scheduled-run-dispatcher.ts
src/bridge/commands/schedule-command.ts
```

建议本地状态文件：

```text
~/.chat-codex/schedules.json
~/.chat-codex/schedule-runs.json
~/.chat-codex/schedule-deliveries.json
```

任务最小模型：

```ts
interface ScheduledTask {
  id: string;
  name: string;
  state: "enabled" | "paused" | "running" | "blocked" | "completed" | "deleted";
  createdAt: string;
  updatedAt: string;
  createdBy: {
    routeKey: string;
    senderId: string;
  };
  route: {
    routeKey: string;
    channelId: string;
    accountId?: string;
    conversation: { id: string; kind: "direct" | "group" | "thread" };
    recipient: { id: string; displayName?: string };
  };
  execution: {
    type: "reminder" | "turn";
    message?: string;
    prompt?: string;
    context: {
      mode: "task_session" | "current_session";
      sessionId?: string;
      cwd?: string;
      modelPolicy?: PersistedModelPolicy;
      permissionMode?: PersistedPermissionMode;
      collaborationMode?: CodexCollaborationMode;
    };
  };
  schedule: {
    rule: ScheduleRule;
    timeZone: string;
    startsAt?: string;
    endsAt?: string;
    maxOccurrences?: number;
  };
  delivery: {
    reportPolicy: "always" | "on_problem" | "on_change" | "digest";
    targetLabel?: string;
  };
  nextRunAt?: string;
  lastRunAt?: string;
}

interface ScheduledRun {
  id: string;
  taskId: string;
  state: "queued" | "running" | "waiting_approval" | "waiting_input" | "completed" | "failed" | "blocked" | "interrupted" | "skipped_overlap" | "missed";
  dueAt: string;
  startedAt?: string;
  completedAt?: string;
  taskSessionId?: string;
  codexTurnId?: string;
  target: ChannelTarget;
  actor: { routeKey: string; senderId: string };
  prompt?: string;
  approvalKeys: string[];
  result?: ScheduledRunResult;
  deliveryId?: string;
}
```

`route` 是创建时冻结的 `ChannelTarget` 必要字段，不保存微信 `context_token`、source message ID、Feishu reply message ID 等短寿命上下文。这样重启后仍能主动发送，同时不会错误复用旧回复上下文。

不能在执行时从 `RouteRecord` 重建这个 target：`RouteRecord.identity.lastSenderId` 会随新消息
变化，尤其群聊中可能已经变成另一位成员；它也不包含所有渠道收件人信息。必须在用户
创建任务的那个 turn 中冻结 target，并以任务自己的不可变字段持久化。

用户提出的四项核心持久化字段完全正确：**何时发、一次性或周期性、到点做什么、投递到
哪个渠道会话**。完整实现还必须保存创建者/权限、task session profile、下一次运行、每次
run 的状态、审批关联和 delivery outbox；否则重启、多任务审批或渠道失败时无法保证同一
任务的安全语义。

其中 `reminder` 是纯通知，例如“3 分钟后提醒我喝水”；到点后直接向目标 route
发送保存的提醒，不需要 session，也不消耗 Codex turn。`turn` 才会在到点后启动 Codex，
适合“每天 9 点检查 CI 并报告异常”这类任务。它保存的必须是用户确认过的 durable
prompt，而不是创建时那句带有“3 分钟后”的原始自然语言。

### 5.1 时间、执行和投递是三个独立维度

“提醒”不能只按一句自然语言存储。任务需要把以下三件事分别持久化，才不会在触发时
产生歧义：

| 维度 | 完整定时任务能力 | 例子 |
| --- | --- | --- |
| 何时触发 | 一次性相对/绝对时间；固定间隔；每天、周一至周五、每周、每月、每年；结束边界 | `3 分钟后`、`每 6 小时`、`每周一 09:00` |
| 触发后做什么 | 直接提醒；启动固定的 Codex turn | `喝水`；`检查当前项目 CI` |
| 何时投递结果 | 每次投递；仅异常；仅变化；按周期汇总 | `每次都发结果`；`失败才通知` |

这几个维度不能混为一种“提醒类型”。例如“每天 9 点检查 CI，失败才通知”是：

```text
日历周期（每天 09:00）
  + scheduled turn（固定 CI 检查 prompt）
  + 条件投递（仅异常）
```

`always` 可直接发送最终结果；`on_problem`、`on_change` 和 `digest` 不能通过解析模型
自由文案实现。它们必须要求 scheduled turn 产出经过 schema 校验的 `ScheduledRunResult`
（例如 `ok` / `problem` / `changed`、摘要、稳定 fingerprint），由中间件依据该结果决定
是否写入 outbox。实现时要么为 task session 注册仅允许“报告本次 run 结果”的受限回调工具，
要么采用等价的 app-server 结构化结果能力；未具备可验证结果契约前，不得假装“仅异常”可靠。

## 6. 精准渠道和会话投递规则

### 6.1 route 固定

任务创建时捕获 route snapshot。后续投递一律使用该 snapshot：

```text
任务 A
  routeKey = weixin:primary:direct:wx_user_a
  -> 只投递到 wx_user_a

任务 B
  routeKey = feishu:work:direct:oc_user_b
  -> 只投递到 oc_user_b
```

不做“找当前最活跃渠道”“转投另一渠道”“同 session 广播”的隐式行为。

### 6.1.1 投递目标的决定权

投递到哪个渠道、哪个私聊/群聊，完全由 Chat-Codex 中间件决定和持久化，不由 Codex
模型决定。这里必须区分两个不同概念：

| 概念 | 所属 | 作用 |
| --- | --- | --- |
| `taskSessionId` / `currentSessionId` | Codex 执行上下文 | 到点后在哪个 Codex session 中运行任务 |
| `ChannelTarget` / `routeKey` | Chat-Codex 渠道上下文 | 审批、输入、最终结果和错误投递到哪个渠道会话 |

创建链路固定为：

```text
可信用户渠道消息
  -> Bridge 冻结 TurnOrigin.route + ChannelTarget + actor
  -> Codex 仅提出时间规则和 execution 内容草案
  -> ScheduleService 从 TurnOrigin 写入 task.route / target snapshot
  -> 到点后 ScheduledRunContextRouter 取回该 snapshot
  -> ChannelRegistry 投递到创建时的同一个渠道会话
```

`chat_codex.schedule` 的 schema 不接受 `channelId`、`accountId`、`conversationId`、
`recipient`、`routeKey`、任意渠道 message ID 或任何 session ID。即使模型在自然语言中提到
“发到飞书”或“发给某人”，也不能凭模型参数改写 target；这样可以避免模型误解、提示注入或
错误工具调用造成跨渠道/跨用户投递。

到点后所有事件都使用同一份冻结 snapshot：

- `reminder` 直接发送到该 target。
- scheduled turn 的 approval、`request_user_input`、final、error、notification 和 outbox retry
  都发送到该 target。
- 渠道暂时不可用时，任务进入 delivery retry 或 `blocked`；绝不静默改投到另一渠道、当前
  最活跃 route 或同名联系人。

默认产品规则是“发回创建任务的这里”。跨渠道/跨会话改投不能由 Codex 自动完成；若后续开放，
只能作为 Chat-Codex 的显式管理操作：用户在 `/timer` 或运行期 TUI 从自己已信任且有权管理的
target 列表中选择，系统重新校验源/目标 route 权限、二次确认、冻结新 snapshot 并写入审计记录。
是否开放这一显式改投能力仍是待决策项；在决定前，不提供隐式或自然语言自动改投。

### 6.2 task session 模式

`reminder` 不需要 Codex session。`turn` 必须在创建时确定 session 模式，不能到点时
按“当前活跃会话”猜测：

- 所有 scheduled `turn` 默认 `task_session`：任务确认时创建或绑定一个仅属于该任务的
  Codex session，结果仍投递回原渠道，但不会把定时执行写进用户日常聊天上下文。
- `current_session` 不是默认值，而是用户明确说“到点后在这个对话继续”的隔离豁免。确认
  文案必须展示该 session、说明它会追加历史，并在执行时与该 session 的前台消息严格串行。

task session 在确认任务时创建，冻结确认时的 cwd、模型策略、权限模式和 collaboration
mode；它不是 route 的 active session，也不应因用户后来 `/use` 切换会话而改变。周期任务
可在自己的 task session 内积累“这个任务过去运行过什么”的上下文，但该上下文永远不进入
用户前台 session。

固定而非跟随的原因：定时任务常常依赖当时的项目、权限或上下文；若它自动跟随 route
后来切换的新 session，可能在错误的项目、权限或上下文中执行。默认的 task session 还
解决了“任务正在执行时用户继续聊天”会污染同一 Codex 历史的问题。

执行前必须验证：

1. route 仍存在且可信。
2. 对应渠道实例仍启用。
3. `execution.context.sessionId` 仍由该 route 拥有并可恢复。
4. session 的工作目录仍可访问。

任何一项不满足时任务进入 `blocked`，只记录状态并向原 route 发送一次可解释通知；不静默改绑到别的 session 或别的渠道。

不提供“跟随当前 route active session”的隐式模式。用户若确有继续当前对话的需求，只能
明确选择 `current_session`，且该选择固定到创建时的 session ID，不会随着 route 之后的
切换变化。

### 6.3 多渠道边界

调度器只认识通用 `route` 和 `ChannelTarget`；它不需要知道微信或飞书的 API。

- 微信：沿用当前最终结果、错误和审批可投递，普通 progress 仍由微信 delivery policy 抑制。
- 飞书：沿用私聊文本和审批卡片能力。
- 后续 Slack、Telegram、飞书群聊：只要 adapter 能发送到构造出的 `ChannelTarget`，无需重写 scheduler。

## 7. 执行、审批和通知语义

### 7.1 执行必须走中间件队列

`execution.type === "reminder"` 到点后不启动 Codex turn，只创建一条带原 route
snapshot 的通知 delivery，直接经 `BridgeDelivery -> ChannelRegistry` 发出。

到点后“给 session 发什么”不能再由 Codex 临场决定。职责应固定为：用户提出意图，
Codex 在创建时把意图整理成结构化 execution 和 durable prompt，Bridge 校验并加入不可
变的 scheduled-run 边界，用户确认后锁定。触发时只使用已持久化的内容，例如：

```text
[Chat-Codex scheduled run]
任务 ID: sch_xxx
计划时间: 2026-07-26T09:00:00+08:00
执行要求: <用户确认过的 durable prompt>
要求: 完成后简洁报告；不要创建、修改或确认任何定时任务。
```

因此 `reminder` 由 Bridge 发送保存的 `message`；`turn` 由 Bridge 发送保存的 prompt
和固定包裹，而不是到点时再让 Codex 重新解释“当时用户想做什么”。

### 7.1.1 任务内容的决定权

不是由 Codex 在任务触发时自行决定“该向 session 发什么”。职责必须分开：

| 参与方 | 可以决定的内容 | 不可以决定的内容 |
| --- | --- | --- |
| 用户 | 想做的事、时间意图、是否确认、是否暂停/删除 | 跨 route、跨渠道或绕过确认的投递目标 |
| Codex | 在创建时把用户意图整理为结构化规则和 prompt 草案 | 在到点时重新解释任务、改变目标或新增权限 |
| ScheduleService | 校验/规范化时间、时区、频率、权限和 task session 选择 | 依据自然语言猜测用户未表达的任务 |
| Bridge | 冻结 target、session 与 durable prompt，并在触发时添加固定边界包裹 | 将任务改投到当前活跃会话或另一个渠道 |

具体而言：

1. 纯 `reminder` 不进入 Codex session；Bridge 在到点时向冻结 target 发送已经保存的 `message`。
2. `turn` 的原始意图来自用户。Codex 仅在创建时生成可读的 prompt 草案和执行模式；周期任务或会启动 Codex 的任务必须由用户确认。
3. 确认后，Bridge 持久化用户确认过的 durable prompt。到点时只发送该 prompt 和固定的 scheduled-run 边界，不重新询问模型“现在应该做什么”。
4. Codex 在该 turn 内可以执行任务并生成结果，但不能通过这次 scheduled turn 创建、确认或修改定时任务。

这样“3 分钟后提醒我喝水”不会因模型上下文变化被改写成别的内容；“每天检查 CI”也不会在
某天触发时因为主会话正在讨论另一件事而被重新定义。

`execution.type === "turn"` 到点后不能直接 `codex.run()`，也不能伪造一条普通入站
`ChannelMessage` 后塞进 `BridgeRouteQueue`。应生成：

```ts
interface ScheduledRunInvocation {
  source: "schedule";
  scheduleId: string;
  runId: string;
  routeKey: string;
  target: ChannelTarget;
  actor: { senderId: string };
  sessionId: string;
  prompt: string;
  dueAt: string;
}
```

随后由独立 `ScheduledRunDispatcher` 处理：

1. 将 invocation 放入以 `taskId` / `taskSessionId` 为键的 `TaskExecutionQueue`，同一个任务或
   同一个 session 永不并发执行。
2. 通过与前台共用的 `TurnScheduler` 取得执行槽位；该 scheduler 必须新增优先级，用户实时
   消息高于尚未开始的 scheduled run。已开始的 scheduled run 不会被偷偷中断，除非用户
   显式停止该任务。
3. 以冻结的 session profile 启动 `codex.run()`，并在 `turn.started` 后把 app-server `turnId`
   绑定到 `ScheduledRunContext`。
4. 所有后续 event 都由 `ScheduledRunContextRouter` 按 `runId` / `turnId` 找回不可变的 target、
   actor、taskId 和 session，而不是从 `routeMessages` / `routeTargets` 的“最近一条消息”推断。

这会保留全局并发限制、模型、权限、sandbox、collaboration mode、`/stop`、审批、
`request_user_input`、错误和最终回复处理，同时避免把任务排到用户前台 route worker 后面。

用户在定时任务运行期间继续发消息时，规则应是：

- 普通消息仍走原来的 `BridgeRouteQueue` 和用户 active session，不等待 task session。
- 若全局并发已满，前台消息排在尚未开始的 scheduled run 前；任务排队状态在 TUI 和任务详情可见。
- task session 的审批或用户输入继续投递回创建任务的 target；用户正常聊天和该任务审批可以同时存在。
- 若用户显式选择 `current_session`，为了保护同一 Codex session，上述例外改为严格串行；确认时必须展示这个影响。

因此定时执行不会污染用户会话，也不会因为用户在同一个微信/飞书聊天发了新消息而丢失
原任务的 event 归属。

### 7.2 审批不自动通过

定时任务继承它冻结的 task session 权限模式：

- `approval`：命令、文件或权限请求照常发到创建任务的 route，等待 `/OK`、`/P`、`/NO` 或飞书卡片操作。
- `approve-for-me`：沿用 Codex 自动审阅语义。
- `full`：沿用已有完全权限语义；创建任务时需要明确确认，不能因为“定时”额外放宽权限。

审批必须从 `ScheduledRunContext` 取得冻结的 `target` 和 `actor`，然后创建带 `runId`、
`taskId`、`routeKey`、`requestedBy` 的 pending approval。它不能复用“当前 route 最近一次
入站消息”的 sender 或 target。这样审批会准确推送到创建任务的微信/飞书会话；用户发了
一条新的普通消息，也不会改变审批投递位置。

审批默认不超时，和项目现有 pending approval 规则一致。任务 run 在等待审批时保持
`waiting_approval`；同一周期任务的后续 occurrence 记录为 `skipped_overlap`，不能叠加
多个无人处理的同类审批。

多任务可能在同一路由同时等待审批，因此必须补齐现有按 route 取“最新一条”的快捷行为：

- 飞书审批卡片必须携带精确 `approvalKey`，卡片操作再校验 route、sender 和 run/task 归属。
- 文本 `/OK`、`/P`、`/NO` 只有在当前 actor 恰好有一条 pending approval 时才可省略 key；
  有多条时返回编号/短 ID 列表，要求 `/OK a001` 这类精确操作。
- 无论文本还是卡片，都必须校验 `routeKey + requestedBy`；群聊还要复用 group access 权限，
  不能只凭知道 approval key 越权处理。

定时任务绝不因为无人在线就自动批准审批。`request_user_input` 也应复用同一个 run-scoped
context：输入提示发往原 target，回答只恢复对应 run，不能被同一路由的普通消息或另一任务
截获。

### 7.3 最终通知与 outbox

一次 scheduled run 至少记录：`started`、`completed` / `failed` / `blocked`、最终文本和投递状态。

执行成功但渠道发送失败时，只重试“结果投递”，不重跑 Codex turn。建议使用独立 delivery outbox，避免因网络短暂失败让可能有副作用的任务执行两次。

`always`：每次执行都投递最终结果、错误或审批。`on_problem`、`on_change` 和 `digest`
必须依据 schema 校验后的 `ScheduledRunResult`、历史 fingerprint 和持久化汇总窗口决定；
它们不能仅靠模型自由文案判断“有没有问题”。无论采用哪种投递策略，渠道发送失败只重试
outbox，不重跑 Codex turn。

## 8. 调度规则与运行期可靠性

### 支持的规则范围

一次性和周期性都是这个功能的基本能力。定时任务完成时应支持下面这些可验证的规则：

```text
一次：N 分钟 / 小时后
一次：指定绝对时间
周期：每 N 分钟 / 小时
日历：每天 HH:mm
日历：周一至周五 HH:mm
日历：每周指定星期和 HH:mm
日历：每月指定日期和 HH:mm
日历：每年指定月日和 HH:mm
```

每个周期规则必须支持明确的停止边界：`endsAt` 或 `maxOccurrences` 至少其一。还应支持
pause/resume、snooze 一次 occurrence、手动立即运行和删除；否则“每小时提醒我”很容易
成为不可控的永久任务。

月度规则必须保存 29/30/31 日不存在时的策略，例如 `skip` 或 `last_day`。周一至周五只是
固定 weekday 规则，不等于法定工作日；后者需要地区化节假日历，属于一个显式可配置的
calendar provider，不能由模型猜测。任意 raw cron 不是用户聊天产品的必需接口：若以后
开放，必须经过独立 parser、时区、最短间隔和资源上限校验，不能把 cron 字符串直接交给
底层 timer。

“每隔一段时间检查某事，只有异常才提醒”也不是新的计时规则，而是周期 `turn` 加条件
投递策略。`on_problem`、`on_change`、安静时段和日报汇总建立在 `ScheduledRunResult` 契约
之上，而不是另建一套 scheduler。

事件触发（例如 CI webhook、GitHub issue 更新、文件变更）是独立的 automation/event
子系统，不伪装成 scheduler 的时间规则；它可以复用同一份任务、权限、route snapshot 和
delivery outbox 模型，但不作为时间调度实现的一部分。

所有日历规则必须保存 IANA 时区，例如 `Asia/Shanghai`，而不是写死“北京时间”或只保存机器当前 UTC offset。动态工具收到 `after` 时由中间件解析为绝对触发时间；收到日历规则时保留 IANA 时区，下一次触发时间由 scheduler 计算。

### 调度器实现

- 任务状态和 `nextRunAt` 先原子写盘，再建立内存 timer。
- 运行期只保持一个“最近到点”的 timer，到点后重新计算；避免每个任务各自长时间 `setInterval`。
- 超过 Node `setTimeout` 上限的未来时间分段唤醒。
- 服务启动时从 store 恢复任务并重新计算 next run。
- Chat-Codex 未运行期间不会执行任务；如需长期常驻，应由 launchd/systemd/容器守护 Chat-Codex 进程，而不是把 OS cron 逻辑塞进 channel adapter。

### 重启与重复执行

精确一次执行无法在“Codex 已执行但进程尚未来得及写完成记录时崩溃”的情况下完全保证。安全优先的规则是：

1. 启动前把 run 标记为 `running` 并持久化。
2. 重启发现未结束 run 时，标记为 `interrupted`。
3. 不自动重跑该 run；用户可显式重试。
4. 重试最终通知可以自动进行，因为它不重复执行 Codex。

这提供 at-most-once 的自动执行倾向，避免定时任务在故障恢复后重复修改文件、发消息或调用外部服务。

## 9. 忙碌、错过和重叠策略

定时任务不能因为投递目标相同，就和用户前台对话使用同一个执行队列。确定的默认行为：

- 同一个 task 和同一个 task session 不允许并发 scheduled run；上一次未结束时，新 occurrence
  记为 `skipped_overlap`，不堆积第二次执行。
- 用户前台 route worker 与 task worker 分离。用户在任务执行期间发送普通消息，仍立即进入
  用户 active session；不会被正在运行的 task session 阻塞。
- 两类 turn 共用全局 `TurnScheduler` 并发上限。调度器要支持优先级：前台用户消息优先于
  尚未启动的 scheduled run；已经运行的任务只可通过显式停止取消。
- 记录计划时间、进入任务队列时间和实际开始时间。超过每个任务的 `maxStartDelay` 时，本次
  occurrence 进入 `missed` / `skipped_delay`，不积压无限 backlog。
- 服务停机期间错过的周期 occurrence 默认记录 `missed` 不补跑；一次性任务也保持 `missed`，
  用户可从聊天命令或 TUI 显式重试。任何自动补跑必须是任务自身明确持久化的 policy，而非
  timer 的隐式行为。
- 显式 `current_session` 任务是唯一例外：它与该 session 的前台 turn 串行，详情和确认页
  必须显示“可能等待当前会话完成”的影响。

渠道投递可以在同一个聊天会话中与前台结果交错，但发送仍经 channel adapter 的串行队列。
scheduled final/error/approval 应带任务名称或短 ID，便于用户区分；微信继续不投递普通
progress，飞书按渠道策略处理 progress。

## 10. 命令和管理界面草案

命令根使用 `/timer`；不增加过于极简且语义不清的 `/t` 别名，也不把较长的
`/schedule` / `/schedules` 暴露为用户入口。自然语言仍是新 session 的主要创建方式，命令负责兼容旧 session 和
明确管理动作：

```text
自然语言（新 session，经 chat_codex.schedule）：
3 分钟后提醒我喝水
每天 9 点检查当前项目 CI，异常才发到这里

兼容创建与管理命令：
/timer add after 30m -- 检查当前项目测试并把结果发回这里
/timer                         # 列表
/timer pause sch_xxx
/timer resume sch_xxx
/timer delete sch_xxx
/timer run sch_xxx
/timer snooze sch_xxx 30m
/timer history sch_xxx
```

### 10.1 `/timer` 列表与编号详情

`/timer` 应先展示当前创建者在当前 route 可管理的任务列表，而不是一次性把每个
任务的完整 prompt、运行记录和投递状态全部刷出。格式沿用现有 `/sessions` 的选择体验：

```text
定时任务
- 页码: 1 / 2
- 数量: 13

1. [启用] 3 分钟后提醒喝水
   - 下次: 2026-07-26 14:03 Asia/Shanghai
   - 类型: 直接提醒
2. [启用] 每个工作日 09:00 检查 CI
   - 下次: 2026-07-27 09:00 Asia/Shanghai
   - 类型: 独立任务会话

回复编号查看详情；回复 `n` 下一页，`p` 上一页；回复“取消”退出。
```

用户回复 `2` 仅打开该任务详情，绝不直接暂停、删除或执行。详情至少展示：任务 ID、状态、
创建/下次/上次执行时间、规则和时区、执行类型、task session 或显式 current session、保存的
prompt/提醒文案、原投递目标、最后一次运行结果、审批/输入等待状态、delivery outbox 状态、
以及可执行的显式管理命令：

```text
/timer pause sch_xxx
/timer resume sch_xxx
/timer delete sch_xxx
/timer run sch_xxx
/timer snooze sch_xxx 30m
```

这样数字是安全的“查看”动作；会改变任务状态的动作始终带明确命令和真实任务 ID，后续
飞书才可在同一权限校验之上增加卡片按钮。

编号选择状态必须是短命的列表快照，而不是把 `2` 当作永久任务编号：

```ts
interface ScheduleListSelectionState {
  routeKey: string;
  senderId: string;
  taskIds: string[];
  page: number;
  pageSize: number;
  createdAt: number;
}
```

- 列表按 `routeKey + senderId` 查询；群聊任务还要经过 group access 的管理权限校验，不能把群 route 当成单一用户。
- 状态有效期与现有 `/sessions` 选择一致，暂定 10 分钟；翻页刷新有效期。
- 收到裸数字时，以当前页快照的 `taskIds` 解析，再重新校验任务仍存在、未删除且当前 actor 仍有管理权；不能按数据库排序重新取“第 2 条”。
- 只有同一 actor 有活动中的定时列表选择时才解释裸数字；否则它是普通聊天内容。命令仍优先按命令处理。
- 同一 actor/route 同时只能保留一个“数字选择”交互。打开 `/timer` 时若正在 `/use` 或 `/resume` 选择，Bridge 必须明确结束旧选择；反之亦然，避免 `1` 被两个列表同时解释。

一次性纯提醒创建后立即回显目标时间和取消方式。会启动 Codex 或重复执行的任务则应
先回显目标时间、时区、task session（或显式 current session）、目标渠道会话、执行方式、权限模式和 prompt，
再要求明确确认。这样避免模型或自然语言误解导致后台任务在错误会话运行。

任务创建者可以管理自己的任务；群聊中必须复用 group access 的管理权限，不能仅凭知道任务 ID 操作。TUI 作为本机运维界面可查看全部任务，但所有变更仍走 task ID、显式确认和审计记录。

### 10.2 TUI 管理

现有 Ink TUI 分为“启动前配置” `ChatCodexTui` 和“服务运行中日志” `RuntimeLogView`。scheduler
和内存 timer 只存在于运行中的 Bridge，因此 Schedules 管理必须加入**运行期 TUI**，不能只在
启动前配置 TUI 里直接改 JSON；后者会让持久化文件与已注册 timer、outbox、run context 脱节。

Bridge 应暴露一个进程内 `ScheduleAdminController` 给 `runRuntimeLogTui`：它调用
`ScheduleService` 后同步重算 timer、刷新 run/outbox 状态。启动前 TUI 最多展示摘要或跳转提示，
不承担运行中的任务变更。

运行期 TUI 必须增加 `Schedules` 页面，而不是只靠聊天命令排障。页面至少包含：

- 总览：enabled、running、waiting approval/input、blocked、missed、delivery retry 数量。
- 列表：按渠道、route、状态、下一次执行时间筛选；展示任务名称、规则、目标和短 ID。
- 详情：完整规则、durable prompt/提醒内容、冻结 session profile、最近 run 历史、审批关联、outbox 状态和错误原因。
- 动作：创建/编辑、pause、resume、snooze、立即运行、重试遗漏 run、删除；破坏性动作必须二次确认。
- 可观测性：当前执行的 task/session/turn、排队原因、前台优先等待情况，以及 channel delivery 重试情况。

TUI 的动作调用 `ScheduleService`，绝不直接修改 JSON 文件；聊天命令、动态工具和 TUI 必须共用同一份权限、状态转换和审计规则。

## 11. 必须完成的核心模块与实现依赖

下列模块共同构成一个完整功能。可以按依赖顺序开发和测试，但在全部模块完成前不能将
“定时任务”标记为完成。

### A. Chat-Codex 与 Codex app-server 适配

- 在 `thread/start` 注册 `chat_codex.get_time`、`chat_codex.schedule`，实现显式注入的
  `DynamicToolHost` 和 `item/tool/call` 回复；未知工具继续拒绝。
- 冻结前台 `TurnOrigin`，由 `(threadId, turnId)` 关联可信 route、actor、target、cwd 和
  session profile；工具参数不接受任何跨渠道/跨会话标识。
- 创建 task session 时注册其最小受限工具集：不得管理任务，只允许必要的 run result 回报。
- 新增 `ScheduledRunContextRouter`，将 app-server `turnId`、审批、input、背景 event 与
  不可变 `ScheduledRunContext` 关联；不得使用 `routeMessages` / `routeTargets` 的最近值。
- 真实验证 dynamic tool 的注册、调用、失败响应、task session、重连和恢复。该协议仍是
  experimental，必须以实际 app-server 行为为准。

### B. 调度领域与持久化

- `ScheduleStore`、`ScheduleRunStore`、delivery outbox，采用原子写入和 schema migration。
- 一次性、interval、daily、weekday、weekly、monthly、yearly、停止边界、时区和夏令时计算。
- 任务、run、审批、input、delivery 的状态机、审计记录和重启恢复。
- 单一最近 timer、长延迟分段唤醒、missed/interrupted/overlap 语义和显式重试。

### C. 隔离执行、并发与精准投递

- `ScheduledRunDispatcher`、`TaskExecutionQueue` 与支持优先级的共享 `TurnScheduler`。
- 默认 task session、显式 current-session 豁免、冻结 cwd/model/permission/collaboration mode。
- run-scoped approval、request-user-input、final/error/notification 路由；多审批精确 key 与
  actor 授权校验。
- `ScheduledRunResult`、条件投递、delivery outbox 与通道串行发送。

### D. 聊天命令和自然语言入口

- 新 session 通过动态工具自然语言创建、确认、查询和管理任务。
- 所有 session 都通过 `/timer` 获得完整的创建、列表、编号详情、pause/resume/
  snooze/run/history/delete 功能。
- `/timer` 数字选择与 `/use` / `/resume` 交互互斥，且按 route + actor 隔离。

### E. TUI 管理与可观测性

- 运行期 Ink TUI 的 `ScheduleAdminController`、Schedules 总览、列表、详情、创建/编辑和全套管理动作。
- 当前 task run、队列优先级等待、审批/input、delivery retry、missed/interrupted 的可视化。
- TUI 与聊天入口调用同一 `ScheduleService`，不形成第二套状态规则。

### F. 完整测试与文档

- 单元、集成、真实微信/飞书私聊与 TUI 覆盖以下测试要求。
- 新增中文测试报告到 `reports/tests/`，并更新命令帮助、架构文档、状态/TUI 文案和文档索引。

### 11.1 开发计划（严格依赖顺序）

以下是工程实施顺序，不是可以分别对用户发布的低配版本。`scheduling` 只在所有步骤验收后
默认启用；开发中可以使用仅供本机验证的开关，但不能让半成品动态工具、timer 或 TUI 管理
入口进入正常聊天渠道。

#### 步骤 1：中间件调度核心

目标：先完成一个完全不依赖 Codex、微信或飞书的持久化 scheduler。它只认识任务、时间、
run 和 delivery outbox，不直接发送消息、不启动 Codex。

实现内容：

1. 在 `src/schedules/` 建立领域类型、schema version、任务/run/delivery 状态机和审计模型。
2. 实现 `FileScheduleStore` 的原子读写、迁移、损坏文件诊断和并发实例保护。
3. 实现规则计算：一次性、interval、daily、weekday、weekly、monthly、yearly、IANA 时区、
   月末策略、`startsAt` / `endsAt` / `maxOccurrences`、DST 边界。
4. 实现 `DurableScheduler`：单一最近 timer、超长延迟分段唤醒、重启恢复、missed、
   interrupted、overlap、max start delay 和显式重试。
5. 实现不含渠道语义的 `ScheduleService`：create/propose/confirm/update/pause/resume/
   snooze/delete/run/history，以及可供后续 TUI 使用的管理查询接口。
6. 定义两个注入端口：`ScheduledExecutionPort` 接收待执行 run，`ScheduleDeliveryPort` 接收
   纯 reminder 或最终 delivery；测试先用内存 fake 实现。

验收门槛：假时钟单元测试覆盖所有规则和状态转换；重启后任务、run/outbox 均可恢复；同一
task 不重叠；没有任何 `src/channels/` 或 `src/codex/` 依赖反向进入 `src/schedules/`。

#### 步骤 2：Chat-Codex 与 Codex 运行时适配

目标：让调度核心能够安全地创建隔离 task session、启动 scheduled turn，并把 app-server
事件绑定到不可变 run context；此时仍可使用 fake delivery，不先接真实聊天渠道。

实现内容：

1. 为 `AppServerCodexAdapter` 增加显式 `DynamicToolHost`，实现 `item/tool/call` 注册、
   参数校验、成功/失败响应和未知工具拒绝。
2. 在新建前台 session 的 `thread/start` 注册 `chat_codex.get_time` 和
   `chat_codex.schedule`；为 task session 注册最小 `chat_codex.schedule_report` 回调，
   不提供任务管理能力。
3. 新增 `TurnOriginRegistry`：在用户前台 turn 启动前冻结 route、actor、target、cwd、
   model、permission、collaboration mode；dynamic tool 只能按 `(threadId, turnId)` 读取。
4. 实现 `TaskSessionFactory`：默认创建独立 task session 并冻结 session profile；显式
   `current_session` 走单独确认与串行路径。
5. 实现 `ScheduledRunDispatcher`、`TaskExecutionQueue` 和有优先级的 `TurnScheduler`：
   前台 turn 高于未启动任务，task/session 内严格串行。
6. 实现 `ScheduledRunContextRouter`：将 `runId`、app-server `turnId`、session、审批、
   input、final/error 关联；不得回退到 route 最近消息。
7. 明确 adapter 兼容性：app-server 支持自然语言 dynamic tool；不具备该协议的 adapter
   仍可执行已创建任务，并通过 `/timer` 管理，但不能假装支持自然语言工具调用。

验收门槛：mock adapter 与真实 `codex app-server` 最小验证均覆盖 tool call、task session、
scheduled turn、context isolation、priority、stop、approval 和 run-scoped input；仍不需要
真实微信/飞书账号。

#### 步骤 3：通用 Bridge 与渠道投递接入

目标：把 run context 接到现有多渠道核心，而不是为每个渠道写一套 scheduler。

实现内容：

1. 任务创建时从 `ChannelMessage` 冻结可持久化 `ChannelTarget` snapshot；排除微信
   `context_token`、来源 message ID、飞书 reply ID 等短寿命字段。
2. 将 `ScheduledExecutionPort` 接入 Bridge，将 `ScheduleDeliveryPort` 接入
   `BridgeDelivery -> ChannelRegistry`；所有 final/error/approval/input 使用 run context target。
3. 改造现有 route busy 语义：前台 `BridgeRouteQueue` 不因 task worker 而停止；全局并发和
   channel 发送串行仍保留。
4. 扩展 `ApprovalManager`、`BridgePendingInputManager` 和停止逻辑为 run-aware：多条审批精确
   key、route + actor 校验、`/stop` 区分前台 turn 与指定 task run。
5. 使用两个 mock channel、多个 route 和多个 sender 做跨渠道、跨 route、并发、重启和 outbox
   集成测试。

验收门槛：一个 scheduled run 无论触发时 route 后来收到多少普通消息，仍只向创建时冻结的
target 投递；用户普通消息不被 task session 阻塞；不存在跨 route 审批或输入恢复。

#### 步骤 4：微信与飞书渠道验证和适配

目标：在不把平台分支泄漏回 scheduler 的前提下，验证真实渠道的主动投递、审批和交互细节。

实现内容：

1. 微信：沿用现有串行发送、重试和 timeout；scheduled reminder/final/error/approval 主动投递
   不带旧 `context_token`；保持 task-start 与普通 progress 抑制，`/fff` 语义不变。
2. 飞书：私聊 scheduled reminder/final/error 正常投递；审批卡片携带精确 `approvalKey` /
   `runId` 并校验操作者；文本命令为卡片失败回退。
3. 两个渠道都验证目标 snapshot、重启后无入站消息主动发送、多个 pending approval、
   delivery outbox retry 和用户前台消息与任务同时运行。
4. 为将来渠道只定义 `ChannelTarget`、delivery policy 和 capability 边界；scheduler 不出现
   `weixin` / `feishu` 条件分支。

验收门槛：微信和飞书真实私聊各完成一次性、周期、审批和失败重试场景；测试结果记录到
`reports/tests/`。通过后才允许对真实渠道默认开启 dynamic tool。

#### 步骤 5：聊天侧 `/timer` 管理体验

目标：让所有 session（包括无法动态注册工具的旧 session）都能完整管理任务。

实现内容：

1. 在 `BridgeCommandRouter` 注册 `/timer`；更新 `/help`、`/status` 和未知命令提示。
2. 实现 `/timer add` 的受控结构化语法，以及 list/detail/pause/resume/snooze/run/history/delete。
3. 实现 `ScheduleListSelectionState`：`/timer` 列表后回复编号查看详情，支持 `n` / `p` /
   “取消”、10 分钟 TTL、任务 ID 快照和 route + actor 隔离。
4. 与 `/use` / `/resume` 的编号选择建立统一互斥协调器，避免裸数字被两个流程同时消费。
5. 管理动作复用 `ScheduleService` 的权限和确认策略；删除、立即运行、切换 current session
   等高影响动作需二次确认。

验收门槛：新旧 session 的管理能力一致；裸数字只在正确的短命选择状态中生效；群聊不会因
知道 task ID 而越权操作。

#### 步骤 6：运行期 TUI 管理与可观测性

目标：把管理能力接入正在运行的 Bridge，而不是在启动前 TUI 直接编辑状态文件。

实现内容：

1. 定义由 Bridge 持有的 `ScheduleAdminController`，供 `RuntimeLogView` 调用并订阅状态变化。
2. 在运行期 Ink TUI 新增 Schedules 总览、列表、详情、筛选和 run/outbox 历史页面。
3. 实现创建/编辑、pause/resume/snooze/run/retry/delete 的键盘交互和确认对话。
4. 展示 task session、当前 turn、前台优先等待、approval/input、missed/interrupted、
   delivery retry 和错误原因。
5. 保持启动前 `ChatCodexTui` 为配置界面；它不直接写 schedule store 或操控运行期 timer。

验收门槛：TUI 任何变更都通过 `ScheduleService`，操作后 timer/outbox 立即同步；TUI 渲染和
键盘操作有 Ink 单元测试，不影响现有 runtime transcript 300 条保留策略。

#### 步骤 7：全链路验收、迁移与默认启用

1. 运行全量 TypeScript build、全部单元/集成/TUI 测试、`git diff --check`，并输出中文测试报告。
2. 验证旧 state 无任务时无迁移风险；有旧草案或中断 run 时状态可解释且不意外重跑。
3. 真实验证微信、飞书、重启、审批、网络发送失败、前台优先、多个任务和 context isolation。
4. 更新 README、命令帮助、状态文案、TUI 帮助、故障排查和文档索引。
5. 仅在以上验收完成后，将 `scheduling` 作为默认开启能力；保留仅供运维紧急熔断的全局开关。

## 12. 测试要求

单元测试：

- 动态工具 schema、`threadId -> sessionId -> route` 解析和拒绝跨 route 参数。
- `TurnOrigin` 冻结、同 route/同 sender 确认草案，以及 scheduled turn 禁止递归创建任务。
- 规则解析和下一次执行时间，包含 interval/daily/weekday/weekly/monthly/yearly、时区、月末策略和夏令时边界。
- 任务状态转换、pause/resume/delete、missed/interrupted。
- route/session 校验和 target snapshot 序列化。
- 工具 schema 不接受 target/route/session 参数；target 一律来自 `TurnOrigin`，渠道失败不会回退到其它 target。
- `/timer` 列表分页、10 分钟过期、快照编号不漂移、所有权复查，以及与 `/use` / `/resume` 选择互斥。
- `reminder` 不启动 Codex；`turn` 只接收冻结的 durable prompt 和固定 scheduled-run 包裹。
- 默认 task session 不污染前台 session；显式 `current_session` 严格串行。
- `ScheduledRunResult`、on-problem/on-change/digest 的结构化结果、fingerprint 和 outbox 判断。
- 多条 pending approval 的精确 key、route + actor 校验、无 TTL、overlap 跳过和 run-scoped input。

集成测试：

- 两个 mock 渠道、多个 route 创建任务后，只向原 route 投递。
- 任务不会跨 session、跨 route 或跨渠道执行。
- 触发后 route 收到新消息、渠道暂不可用或同名联系人出现时，approval/input/final/error 仍只使用冻结 target。
- 正在运行的 scheduled task 与同 route 用户前台消息并发：用户消息不被阻塞、前台优先于未启动任务、同 task 不重叠。
- scheduled approval/input、失败、`/stop`、全局并发限制、重启恢复和 delivery retry。
- 同一路由两个任务同时审批时，文本命令与飞书卡片都只会处理指定 approval/run。
- 渠道投递失败只重试 final delivery，不重复 Codex run。
- 微信保持 progress 抑制但最终结果、错误和审批正常；飞书私聊审批卡片仍工作。

TUI 测试：

- Schedules 总览、筛选、详情、运行历史、outbox 状态和键盘操作。
- pause/resume/snooze/run/delete/edit 的确认与 `ScheduleService` 调用。
- 前台/任务并发、等待审批和失败状态在 TUI 中正确显示。
- 运行期 TUI 经 `ScheduleAdminController` 修改任务后，timer/outbox 同步更新；启动前配置 TUI 不直接写 schedule store。

真实通道测试：

- 微信和飞书私聊分别创建一次性和周期性任务。
- 验证服务重启、无入站消息时主动投递、审批、失败重试和权限边界。

实现阶段必须新增中文测试报告到 `reports/tests/`。

## 13. 当前待决策项

1. 已确定：定时能力按完整模块交付，不以“首版仅一次性”或“以后再补 TUI/审批”为产品边界。
2. 已确定：所有 scheduled `turn` 默认独立 `task_session`；`current_session` 仅能由用户明确选择并二次确认。
3. 已确定：任务默认 route/target/actor/session profile 全部冻结；运行 event 不依赖 route 最近入站消息。
4. 已确定：投递渠道和会话由 Chat-Codex 从可信发起 turn 冻结；Codex 工具参数无权指定或改写 target。
5. 已确定：用户前台消息与任务分执行队列，共用全局并发但前台优先；同一 task 不重叠。
6. 已确定：聊天命令使用 `/timer`，不增加 `/t` 单字母别名。
7. 待确认：是否开放跨渠道/跨会话的显式改投？建议默认不改投；若开放，只能通过 `/timer` 或运行期 TUI 选择已授权 target 并二次确认。
8. 待确认：条件投递使用 run-scoped 受限回调工具返回 `ScheduledRunResult`，而不解析最终自然语言，是否接受？建议如此。
9. 待确认：服务停机期间 missed 的一次性任务是否默认仅记录并由用户显式重试，还是允许任务创建时选择自动补跑？建议默认仅记录。
10. 待确认：单次纯 `reminder` 是否立即创建；所有 `turn`、周期任务、`current_session` 和高权限任务是否都要求确认？建议如此。

## 14. 设计结论

Codex 产品确实原生支持 Scheduled tasks；但当前 app-server 不提供把该服务接入
Chat-Codex 的任务管理或完成回调 RPC。若目标是“复用 Codex 原生 scheduler 并把结果
精准转投渠道”，当前公开协议做不到。若目标是“为渠道增加定时能力”，则需要
Chat-Codex 自己实现 scheduler；动态工具只是可选的自然语言入口。

渠道定时的完整实现应由中间件持久化时间/规则/内容/target、隔离 task session、run-scoped
event 路由和统一 delivery 完成；自然语言使用 Chat-Codex 自定义动态工具，所有 session
使用 `/timer` 管理，TUI 提供同一服务上的全量可观测和操作能力。它不依赖插件目录元数据、
OS cron 或渠道 adapter 私自发起任务。
