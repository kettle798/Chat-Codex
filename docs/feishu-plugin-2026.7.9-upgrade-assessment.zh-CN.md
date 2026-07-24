# 飞书插件 2026.7.9 升级评估

## 结论

从 `@larksuite/openclaw-lark@2026.5.13` 升级到 `2026.7.9` 本身，不要求修改 Chat-Codex 的飞书私聊基础收发代码。

Chat-Codex 直接使用飞书官方 `@larksuiteoapi/node-sdk` 实现 `FeishuAdapter`，不加载 OpenClaw 插件、gateway 或 runtime。此次上游稳定版本从 `2026.5.13` 升至 `2026.7.9` 后，和当前私聊收发直接相关的 WebSocket monitor、事件注册和基础消息发送协议没有变化；现有实现已经覆盖私聊文本、图片/文件、原消息回复回退、typing reaction、入站去重和重连状态。

不过，上游卡片回调的操作者身份兼容结论可用于一个独立的产品能力：本轮已按 Chat-Codex 的通用审批协议实现飞书私聊审批卡片。它不是把 OpenClaw 的卡片、机器人互聊、工具或 runtime 逻辑搬入中间件，而是在现有 `ChannelAdapter` 和 ApprovalManager 边界内增加的最小适配。

## 评估范围

本次对比的版本：

| 项目 | 版本 |
| --- | --- |
| 原参考基线 | `@larksuite/openclaw-lark@2026.5.13` |
| 当前 npm stable | `@larksuite/openclaw-lark@2026.7.9` |
| 中间稳定版本 | `2026.5.20`、`2026.6.10` |
| Chat-Codex 声明的 SDK 依赖 | `@larksuiteoapi/node-sdk@^1.71.1` |
| 当前锁定/安装的 SDK | `1.71.1` |
| 上游插件声明的 SDK 下限 | `@larksuiteoapi/node-sdk@^1.64.0` |

本机下载的 npm tarball 和解包源码位于被 Git 忽略的目录：

```text
openclaw-lark-npm/openclaw-lark-2026.5.13.tgz
openclaw-lark-npm/openclaw-lark-2026.7.9.tgz
openclaw-lark-npm/extracted/openclaw-lark-2026.5.13/
openclaw-lark-npm/extracted/openclaw-lark-2026.7.9/
```

`2026.7.9` tarball SHA-256：

```text
27b1ead3ca54b855cd9ba709b9296658eafee6d99c8a98e0b4932d122fef107f
```

参考来源：

- npm 包页：<https://www.npmjs.com/package/@larksuite/openclaw-lark>
- 插件源码：<https://github.com/larksuite/openclaw-lark>
- 飞书 Node SDK：<https://www.npmjs.com/package/@larksuiteoapi/node-sdk>

## 当前 Chat-Codex 实现对照

| 能力 | 当前实现 | 判断 |
| --- | --- | --- |
| 长连接收消息 | `WSClient + EventDispatcher` | 已实现；上游该路径没有本轮协议变更。 |
| 连接状态 | ready、error、reconnecting、reconnected 映射为 ChannelStatus | 已实现。 |
| 机器人身份和回环 | 启动 probe 获取 bot open_id，过滤 bot/app/self echo | 已实现。 |
| 私聊路由 | 以 `chat_id` 构造 direct route，交给 Bridge 绑定 session | 已实现。 |
| 出站文本 | 优先 reply 原消息，失败再按 `chat_id` create；使用 `post` 的 `md` tag | 已实现。 |
| Markdown | 原生 `post + md` 发送 | 已与上游新版方向一致。 |
| 媒体 | 图片/文件上传，入站图片/文件下载 | 已实现；音频、视频等不在当前范围。 |
| 输入状态 | 对原消息添加/移除 `Typing` reaction | 已实现。 |
| 去重 | 按 `message_id` 的 TTL 去重 | 已实现。 |
| 群聊和 thread | 协议基础存在；当前公开能力仍关闭，群聊路线正在独立推进 | 不是此次插件升级自动带来的兼容缺口。 |

当前适配器边界见 `src/channels/feishu/`。Bridge 仍只依赖通用 `ChannelAdapter`、capability 和 delivery policy，不依赖飞书 SDK 原始类型。

## 上游变化与处理决定

### 1. 原生 Markdown 渲染

上游 `2026.7.9` 不再为了代码块或表格强制改走 interactive card，而是统一通过 `post` 的 `md` tag 原生渲染。这样能避免卡片路径对 @ 提及和机器人互聊造成的限制。

Chat-Codex 已经使用相同的 `post + md` 文本结构，因此没有迁移工作，也不需要引入 OpenClaw 的 Markdown table 转换器。

### 2. 机器人互聊防环和强制 @ 提及

上游新增了机器人互相 @ 时的防环、名称到 open_id 缓存、强制 @ 回发，以及自然语言“停止对话”识别。它服务于 OpenClaw 的群内 bot-to-bot 对话，避免两个机器人无限互相唤醒。

Chat-Codex 当前：

- 公开版群聊接收关闭。
- 入站 bot/app 消息会过滤，不允许机器人互聊。
- `/stop` 已由 Bridge 统一处理并终止当前 Codex turn。

因此不应照搬这套逻辑。未来如果开放飞书群聊，仍应保持“仅人类 @bot 触发”的产品策略；除非明确要支持 bot-to-bot，才需要单独设计防环、提及缓存和额度，不应默认启用。

### 3. thread/topic 回复路由

上游增加了更完整的 `thread_id` / `root_id` 推断，以及 `reply_in_thread` 路由策略，用于 topic 群、bot-to-bot 和 OpenClaw session 隔离。

Chat-Codex 当前把飞书 `thread` capability 声明为 `false`，并且群聊公开开关尚未打开。群聊是正在独立推进的工作，不是本次评估新增的待办。现有“回复原消息，失败回退为 chat create”在私聊范围正确；群聊实现准备公开前，应把以下 thread 边界纳入该路线验收：

1. 按 `chat_id + thread_id` 构造稳定 route/session 边界。
2. 在 `ChannelTarget` / `SendOptions` 中显式表达 `replyInThread`。
3. 为 `root_id` 仅有、`thread_id` 缺失的 topic 群消息定义映射规则。
4. 通过真实群聊验证线程可见性和 session 隔离。

这不是仅更新依赖即可获得的能力。

### 4. 交互卡片与 Schema 2 操作者身份

上游新增卡片回调操作者身份的 `operator.open_id` / `operator.user_id` 兼容，并继续扩展卡片状态、流式卡片和 confirmation button。

Chat-Codex 已实现飞书私聊审批卡片，但没有把 OpenClaw 卡片 runtime 引入项目。实现只在现有 `EventDispatcher` 中注册 `card.action.trigger`：Bridge 继续拥有 ApprovalManager 和 Codex resolve，adapter 负责卡片发送、`operator.open_id` / `operator.user_id` 解析、卡片消息/私聊/操作者校验及 callback toast。

文本 `/OK`、`/P`、`/NO` 仍是完整兜底；interactive 卡片发送失败会立即回退文本。`messageUpdate` 继续为 `false`，因为处理成功后的状态使用飞书 callback 返回的结果卡片，并不声明通用消息更新能力。设计和真实应用事件订阅要求见 `feishu-direct-approval-card-design.zh-CN.md`。

飞书进度卡片、CardKit 流式更新和群聊卡片仍未纳入本轮，不应为了降低进度刷屏直接迁移 OpenClaw 的卡片运行时。

### 5. OpenClaw 工具、Skills、UAT 和 runtime

新版插件包含文档、日历、任务、多维表格、用户授权令牌、OpenClaw 工具注册和 plugin-sdk 兼容逻辑。这些能力依赖 OpenClaw 的 host/runtime、授权策略和工具协议。

Chat-Codex 的目标是独立 Codex 中间件。直接使用这些模块会绕过现有 Bridge 的配对、权限、审批、队列和 session 边界，因此不纳入渠道升级。相关的飞书工具能力仍以 `feishu-skills-command-design.zh-CN.md` 中的独立设计为准。

### 6. 飞书 Node SDK 版本

Chat-Codex 的飞书运行时代码直接使用官方 `@larksuiteoapi/node-sdk`，只调用稳定的 `Client`、`EventDispatcher`、`WSClient` 和 IM API；不安装、不导入 OpenClaw 飞书插件。上游插件 `2026.7.9` 仍只声明 `^1.64.0`。

本次已将项目依赖从 `^1.66.1` 升级为 `^1.71.1`，并同步更新 `npm-shrinkwrap.json` 到实际安装的 `1.71.1`。现有私聊 adapter 不需要代码适配：所使用的低层 API 保持兼容，构建和全量自动化测试均已通过。

SDK 的高层 `LarkChannel` 也包含卡片、流式和自身的队列/策略能力，但不应替换现有 `ChannelAdapter`，否则会与 Bridge 的通用路由、配对、审批和队列模型重叠。当前审批卡片已选择性复用现有 `EventDispatcher` 的 `card.action.trigger`，不切换整个渠道抽象。

## 分级结论

### P0：当前必须处理

私聊基础收发保持兼容；运行时依赖已升级，并已新增飞书私聊审批卡片。

已处理：

- 参考 npm 基线更新为 `2026.7.9`。
- 记录本次源码差异和 Chat-Codex 的适配结论。
- 官方飞书 Node SDK 从 `1.66.1` 升级到 `1.71.1`，构建和全量自动化测试通过；真实飞书私聊回归待执行。
- 已按通用渠道协议实现私聊审批卡片、动作身份校验和文本回退；真实 `card.action.trigger` 补测待执行。

### 正在推进：飞书群聊

飞书群聊及其配对、@bot 触发、权限、成员展示和后续 thread 边界，继续按既有群聊设计独立推进。本次插件升级只提供参考：上游新增的 thread 路由和 @ 提及处理可在群聊实现时按 Chat-Codex 的 route、信任和权限模型选择性吸收，不能直接复制 OpenClaw 的 bot-to-bot 行为。

### 非必要候选：有明确产品需求后再设计

- 飞书可更新进度卡片和 CardKit 流式输出。
- 真实用户/机器人 @ 提及解析和出站 mention 规范化。
- 后续飞书 Node SDK 的常规依赖维护。

### 不属于渠道兼容：OpenClaw 专属能力

- 飞书文档、日历、任务、多维表格等 Codex 工具。
- 用户授权令牌和以用户身份调用 API。
- OpenClaw plugin runtime、命令和 Skills 运行机制。

这里需要区分两个名字相近但不同的概念：

- `@larksuiteoapi/node-sdk` 是飞书官方 Node SDK，也是 Chat-Codex 当前 `FeishuAdapter` 直接使用的基础依赖；它不是 OpenClaw 工具。本次已完成到 `1.71.1` 的独立维护升级。
- OpenClaw 插件中的“飞书工具”是文档、日历、任务、多维表格、用户授权令牌等运行时能力；Chat-Codex 当前不运行 OpenClaw，因此不需要随渠道版本适配这些能力。

## 验收与后续

本评估对应的 SDK 升级已完成；私聊审批卡片另按独立设计实现。后续任何 P1 实现必须：

1. 在实施前补充对应的设计文档和通用协议边界。
2. 覆盖 `FeishuAdapter` 单元测试、Bridge 集成测试和渠道策略测试。
3. 在真实飞书私聊或群聊环境中验证后追加中文测试报告。
4. 保持群聊、thread、进度卡片和 CardKit 能力默认关闭，直到对应链路验收完成。

现有飞书测试入口：

```text
tests/unit/feishu-message.test.ts
tests/unit/feishu-adapter.test.ts
tests/integration/feishu-bridge.test.ts
```
