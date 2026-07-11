# Codex 2026-07 最新模型与协议适配设计

## 背景

Codex CLI / app-server 参考仓库近期继续快速变化，OpenAI 官方模型页也已经进入 GPT-5.6 模型族。Chat-Codex 作为微信、飞书到 Codex 的桥接层，不能把这些变化简单理解成“换几个模型名”。更重要的是：

- 模型能力、思考等级、service tier 变成更动态的模型元数据。
- app-server schema 新增了 thread、account、plugin、fs、command、external agent config 等更多客户端请求。
- server notification 新增了安全缓冲、thread 删除、reasoning 正文 delta、账号/额度更新、外部配置导入进度等更多状态。
- Codex 新功能里有一部分适合聊天桥接，有一部分属于本地富客户端或高权限能力，不应直接暴露到微信/飞书。

本文档给出本轮“模型适配 + 稳定性适配 + 新功能建议适配”的完整设计。实现阶段仍必须先读 `docs/development-and-test.zh-CN.md`，按规范自测并在 `reports/tests/` 留中文测试报告。

## 资料来源与本次基线

### 本地基线

- Chat-Codex 仓库：`main`，当前 HEAD `315b0b1`。
- 当前工作区：存在前序未提交改动，本设计只新增文档和索引，不回滚已有文件。
- Codex 参考源码：`references/openai-codex`，已更新到 HEAD `5c19155c`。
- 旧设计文档：`docs/codex-new-version-adaptation-design.zh-CN.md` 基于参考源码 `b89ce9a`，本轮设计视为对它的补充和更新，不直接覆盖历史判断。

### 官方资料

- `https://developers.openai.com/api/docs/guides/latest-model.md`
  - 当前 latest model metadata 指向 `gpt-5.6-sol`。
  - `gpt-5.6` alias 路由到 `gpt-5.6-sol`。
  - 官方建议按工作负载在 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` 中选择。
  - GPT-5.6 支持 `max` reasoning effort，并继续保留 `none`、`low`、`medium`、`high`、`xhigh` 等 effort。
  - 官方还提到 Programmatic Tool Calling、Multi-agent beta、explicit prompt caching、persisted reasoning、Pro mode、原图 detail 等新能力。
- `https://developers.openai.com/codex/codex-manual.md`
  - 直接 curl 可读取，manual helper 因当前代理响应缺少 `x-content-sha256` 校验头未能生成本地缓存。
  - 手册中 Codex 模型、reasoning effort、skills/plugins、multi-agent、surface 行为等内容仅作为设计参考；实现仍以 app-server schema 和运行时 capability 为准。

### app-server schema 基线

参考源码 `references/openai-codex/codex-rs/app-server-protocol/schema/typescript/` 当前生成类型：

- `ClientRequest`：90 个方法。
- `ServerNotification`：69 个通知。
- `ServerRequest`：10 类服务端反向请求。

与旧设计相比，至少新增或需要重新分类：

- ClientRequest：`thread/delete`、`account/rateLimitResetCredit/consume`、`account/workspaceMessages/read`、`externalAgentConfig/import/readHistories` 等。
- ServerNotification：`thread/deleted`、`model/safetyBuffering/updated`、`externalAgentConfig/import/progress` 等。
- Model schema：`ReasoningEffort` 已是开放字符串，`Model` 增加/保留 `defaultServiceTier`、`inputModalities`、`supportsPersonality`、`upgradeInfo`、`availabilityNux` 等字段。

## 当前已具备能力

Chat-Codex 当前已经覆盖聊天桥接的主链路：

- app-server stdio 生命周期：启动、初始化、JSON-RPC 请求/响应、通知分发、停止。
- session/thread：`thread/start`、`thread/resume`、`thread/name/set`、本地 session 发现、route/session 绑定和 owner 唯一约束。
- turn：`turn/start`、`turn/steer`、`turn/interrupt`，以及 route 级队列和 busy guard。
- 审批与输入：命令审批、文件变更审批、permissions 审批、`item/tool/requestUserInput` 聊天回答。
- 模型：`model/list`、`/model`、`/model all`、`/model default`、`/model <model> [effort]`。
- 协作模式：`/plan`、`/code`，并且已有“不要启动时改写原 session 模型/思考等级”的约束。
- 上下文和目标：`/compact`、`/goal`。
- 通知：warning、guardianWarning、configWarning、model reroute/verification、thread archive/close、connection reconnect 等通知已能分流到聊天渠道、TUI 或本地日志。
- 进度和旁白：普通 progress、brief commentary、微信/飞书差异化投递策略。

## 核心适配原则

1. 不硬编码最新模型名。模型名、默认 effort、service tier、输入模态都以 `model/list` 和 app-server 返回为准。
2. 不把高权限 app-server 能力直接暴露到聊天渠道。`fs/*`、`command/exec`、config 写入、plugin/marketplace 写入、account 登录登出等默认不开放。
3. 先保证协议稳定，再考虑新命令。未知通知不能导致 turn 失败；未知 ServerRequest 必须 fail-closed 且可解释。
4. 微信/飞书是聊天界面，不复制 Codex App 的富客户端。复杂 UI 能力只做摘要、只读状态或明确的受控命令。
5. 兼容旧 Codex。新增字段必须可选解析，新增方法必须 capability 检测或安全降级。
6. 不影响 `/plan`、`/code` 和已有 session 模型策略。模式切换不能偷偷改模型和思考等级。

## 一、模型适配设计

### 现状问题

当前项目在 `src/codex/types.ts` 中把 `CodexReasoningEffort` 固定为：

```text
none, minimal, low, medium, high, xhigh
```

而最新 app-server schema 的 `ReasoningEffort.ts` 已经是：

```ts
export type ReasoningEffort = string;
```

这会带来两个直接问题：

- Codex 返回 `max`、`ultra` 或未来新 effort 时，`model-policy.ts` 会把它们过滤掉。
- `/model effort max` 会被 `parseReasoningEffort()` 误判为非法，即使当前模型实际支持。

### 目标行为

模型层应改成“开放字符串 + 运行时模型列表校验”：

- `CodexReasoningEffort` 改为 `string`。
- `CODEX_REASONING_EFFORTS` 保留为“常见建议值”，不再作为全局白名单。
- `modelsFromListResponse()` 必须保留 app-server 返回的任意非空 effort 字符串。
- `/model effort <value>` 和 `/model <model> <value>` 优先用当前模型的 `supportedReasoningEfforts` 校验。
- 如果模型列表没有提供 supported efforts，才允许语法安全的非空字符串透传给 app-server，由 Codex 自己判断。
- 错误提示优先展示当前模型支持值，而不是只展示旧固定列表。

建议常见值顺序：

```text
none, minimal, low, medium, high, xhigh, max, ultra
```

这里的 `max` 来自官方 GPT-5.6 API 文档；`ultra` 来自 Codex 手册中对部分 surface / intelligence level 的描述。实现上不应假设所有模型都支持这些值。

### 模型元数据扩展

`CodexModelOption` 建议扩展并解析：

- `defaultServiceTier: string | null`
- `inputModalities: string[]`
- `supportsPersonality: boolean`
- `upgrade: string | null`
- `upgradeInfo`
- `availabilityNux`

首阶段不一定全部展示给普通用户，但必须至少做到“不丢字段、不因字段变化失败”。展示建议：

- `/model` 列表展示 service tier 摘要，例如 `tiers: default, flex; defaultTier=default`。
- 支持图片输入的模型可展示 `input: text,image`。
- hidden、isDefault、upgrade 信息只在 `/model all` 或 debug/status 中展示，避免普通列表过吵。
- availability NUX 不主动推送到微信群/飞书群，避免泄露账号或套餐状态。

### service tier 策略

service tier 需要谨慎处理：

- `/model <model>` 不应继承旧模型的 stale `serviceTier`。
- 如果用户没有显式设置 tier，优先让 Codex 使用模型 catalog 默认，而不是 Chat-Codex 自己猜。
- 后续如新增 `/model tier <tier>`，必须基于当前模型 `serviceTiers` 校验。
- `defaultServiceTier` 可以展示，但第一阶段不强制写入 policy，避免改变 Codex 自身默认策略。

### 与 `/plan`、`/code` 的关系

- `/plan` 只切 collaboration mode，不改模型、不改 effort、不改 service tier。
- `/code` 只恢复默认执行模式，不改模型、不改 effort、不改 service tier。
- 新增模型元数据解析不能重新引入“启动或切模式时修改 session 思考等级”的问题。

### 模型适配测试要求

实现阶段至少补这些测试：

- `modelsFromListResponse()` 能保留 `max`、`ultra`、未来自定义 effort。
- `/model effort max` 在当前模型支持 `max` 时通过。
- 当前模型不支持某 effort 时，错误提示展示模型支持列表。
- 解析 `defaultServiceTier`、`inputModalities`、`supportsPersonality` 不丢字段。
- `/plan`、`/code` 不改变已有 `CodexModelPolicy`。

## 二、稳定性与协议漂移适配

### 协议清单同步

当前 `tests/unit/app-server-mappers.test.ts` 已有协议 inventory 测试，会读取本地 `references/openai-codex` schema 并要求所有方法在 `APP_SERVER_PROTOCOL_CAPABILITIES` 中分类。

由于参考仓库已更新到 `5c19155c`，实现第一步应同步：

- `src/codex/app-server/protocol-capabilities.ts`
- 相关 mapper / notification handler 测试
- `docs/codex-new-version-adaptation-design.zh-CN.md` 或本文档后续状态

新增方法建议分类：

| 方法 | 方向 | 建议分类 | 原因 |
| --- | --- | --- | --- |
| `thread/delete` | client_request | `not_exposed` 初始；通知需 handled | 聊天侧不先开放删除，但外部删除要能解绑 |
| `account/rateLimitResetCredit/consume` | client_request | `not_exposed` | 消耗额度/权益，不应聊天直接触发 |
| `account/workspaceMessages/read` | client_request | `candidate` 或 `not_exposed` | 只读但可能含账号/组织信息，先不公开 |
| `externalAgentConfig/import/readHistories` | client_request | `not_exposed` | 迁移其他 agent 配置，不属于聊天桥接主线 |
| `thread/deleted` | server_notification | `handled` | 当前绑定 session 被删除时必须提示并解绑 |
| `model/safetyBuffering/updated` | server_notification | `handled` 或 `ignored_safe + local log` | 解释模型安全缓冲导致的长等待 |
| `externalAgentConfig/import/progress` | server_notification | `ignored_safe` | 本项目不做外部 agent 配置迁移 |

### 未知通知处理

所有未知 `ServerNotification` 的原则：

- 不抛异常中断当前 turn。
- TUI / transcript 可以记录 debug 或 verbose 日志。
- 不默认推送到微信/飞书，除非它属于安全、权限、模型路由、连接、thread 生命周期等用户必须知道的低频通知。

### 重点通知适配

#### `thread/deleted`

目标：

- 如果被删除的是当前 route 绑定 session，应主动通知用户。
- 清理本地 route/session binding 和 owner 占用。
- 不删除任何本地文件，不尝试恢复删除。

用户文案建议：

```text
Codex 会话已被删除，当前聊天已解除绑定。
请发送 /new 创建新会话，或 /sessions 选择其他会话。
```

#### `model/safetyBuffering/updated`

目标：

- 当 `showBufferingUi=true` 时，本地 TUI 必须能看到“模型安全检查/缓冲中”。
- 聊天渠道建议低频通知，不进入普通 progress 节流队列，避免用户误以为卡死。
- 如果包含 `fasterModel`，只做提示，不自动切模型。

文案建议：

```text
Codex 正在等待模型安全缓冲完成，回复可能会变慢。
Model: gpt-...
```

#### `item/reasoning/textDelta`

当前已处理 reasoning summary delta。新 `item/reasoning/textDelta` 需要保持谨慎：

- 默认不直接投递到聊天渠道，避免暴露大量内部推理正文。
- 如果 Codex 未来把原本 summary delta 改成 text delta，应在 adapter 内转换为安全摘要或本地日志，而不是原样推送。
- 不进入最终回复拼接。

#### `turn/moderationMetadata`

建议：

- 存为本地状态或 verbose 日志。
- 只有当它导致 turn 阻断、降级或用户可见等待时，才转成 `codex.notification kind=warning/security`。

#### 终端错误与 turn completion

参考仓库近期有“terminal errors in turn completion events”的变化。Chat-Codex 应确认：

- `turn/completed` 中如果带错误或 terminal failure，不能被当作纯成功。
- 最终状态、TUI、聊天提示要能区分“Codex turn 完成但某个终端步骤失败”和“整个 turn RPC 失败”。
- 这类错误不能只停留在普通 progress 摘要里。

#### outbound response item id 前缀

参考仓库近期有“Require prefixes for outbound response item IDs”。Chat-Codex 若生成或透传任何 client-side item id，应检查：

- `clientUserMessageId`
- pending approval/input id
- local image/file input 相关 id
- 后续可能的 `thread/inject_items`

要求：

- 不依赖裸数字或无前缀短 id。
- 使用稳定前缀，例如 `chat-codex-user-...`、`chat-codex-input-...`。
- 不改变用户可见 session id。

### ServerRequest 稳定性

当前 10 类 ServerRequest 仍是：

- command/file/permissions approval
- `item/tool/requestUserInput`
- MCP elicitation
- dynamic tool call
- ChatGPT auth token refresh
- attestation generate
- legacy applyPatch/exec approvals

原则保持不变：

- 审批和 request user input 是已支持主线。
- MCP elicitation、dynamic tool call、auth token refresh、attestation 继续 fail-closed。
- fail-closed 必须给用户可解释进度或通知，不能静默失败。
- 不在聊天桥接里接管 ChatGPT token。

## 三、轻量化范围与 `/status` 增强

Chat-Codex 的定位是微信/飞书到 Codex 的轻量桥接工具，不复制 Codex App 的完整功能面。新版本适配优先保证“协议不漂、模型不被旧枚举挡住、关键通知不丢、状态可诊断”，而不是继续增加聊天命令。

当前用户可见增强收敛到 `/status`：

- 展示当前会话标题，帮助用户确认当前绑定的是哪条 Codex session。
- 展示最近关键 Codex 通知摘要，例如安全提示、配置警告、模型切换、安全缓冲、连接恢复、thread 生命周期变化。
- 保持账号、workspace、token、provider 密钥等敏感信息不进入群聊状态页。
- 空闲状态隐藏 `0` 值噪声；只有队列、附件、审批、补充消息等非 0 或等待确认时才显示。
- `/status` 仍是诊断视图，不替代主动安全通知；安全、配置、模型和生命周期通知仍应主动推送一次并低频去重。

以下新能力本轮不实现为新命令：

### 不做独立 `/usage` 或 `/limits`

`account/rateLimits/read`、`account/usage/read` 属于账号/套餐维度信息，容易包含组织、额度、套餐或使用量细节。当前不新增 `/usage` 或 `/limits` 顶层命令。

后续如果确有需要，只考虑作为私聊限定的 `/status account` 或 `/status limits` 子视图，并且必须脱敏、只读、不展示完整账号标识；群聊默认不开放。

### 不新增 `/fork`

`thread/fork` 有实际价值，但它会引入新的绑定语义：fork 后当前聊天是否自动切换、群聊谁能触发、如何选择 `lastTurnId`、如何防止多 route 争抢 fork 结果。当前不新增 `/fork` 命令，避免扩大交互复杂度。

后续如果需要，应单独设计交互和权限；不要在本轮协议适配中顺手实现。

### 不做 `/rollback`

最新 app-server schema 已标记 `thread/rollback` 即将移除。Chat-Codex 不新增 `/rollback`，避免依赖 deprecated 能力。需要“回到某个历史点”时，后续优先评估基于 `thread/fork` 的分叉方案，而不是修改原 thread 历史。

### `thread/list` / `thread/read` 只作为 `/sessions` 底层候选

`thread/list`、`thread/read` 不新增用户命令。它们的价值是未来增强 `/sessions` 的底层数据源：

- `thread/list`：由 app-server 原生列出 thread，支持分页、搜索、cwd/source/archive 过滤。
- `thread/read`：读取单个 thread 详情，在需要时获取 turns 历史。

这类适配只能作为现有 `/sessions` 的实现细节，必须保留当前本地发现 fallback；群聊仍只展示当前 route 可见范围。

### 模型 provider 能力暂不命令化

可用方法：

- `modelProvider/capabilities/read`
- `configRequirements/read`

这类能力可帮助解释“为什么搜索/图片/工具不可用”，但当前不新增命令。只有当 app-server 已在现有状态或模型元数据里提供安全摘要时，才考虑在 `/status` 或 `/model all` 中做只读展示；不主动读取或暴露 provider token、账号信息。

### reasoning summary、personality、review 暂不聊天命令化

这些能力属于高级 Codex 行为控制或富客户端工作流，不是本轮稳定性适配主线。保持现有 `/plan`、`/code`、`/model`、`/progress` 能力即可。

### 不建议适配或暂不开放

以下能力当前不建议通过微信/飞书开放：

- `fs/readFile`、`fs/writeFile`、`fs/remove`、`fs/watch` 等文件系统 RPC。
- `command/exec` 系列独立命令执行 RPC。
- `config/value/write`、`config/batchWrite`、`skills/config/write`。
- `plugin/install`、`plugin/uninstall`、marketplace 写入。
- `account/login/start`、`account/logout`。
- `mcpServer/tool/call`、`mcpServer/resource/read` 原始透传。
- realtime audio/transcript 系列。
- `thread/inject_items` 原始历史注入。

这些能力要么权限过高，要么需要富 UI，要么容易绕过现有审批和渠道边界。后续如确实需要，必须单独设计。

## 四、分阶段实施计划

### Phase 0：协议清单同步

目标：

- 更新 `APP_SERVER_PROTOCOL_CAPABILITIES`，让最新 `references/openai-codex` schema 全量分类。
- 不改变运行行为。

涉及文件：

- `src/codex/app-server/protocol-capabilities.ts`
- `tests/unit/app-server-mappers.test.ts`

验收：

- 协议 inventory 测试在参考仓库 HEAD `5c19155c` 下通过。

### Phase 1：模型兼容性修复

目标：

- `CodexReasoningEffort` 改成开放字符串。
- 解析并保留 `max`、`ultra` 和未来 effort。
- `/model` 改为运行时模型支持列表校验。
- 解析 `defaultServiceTier`、`inputModalities`、`supportsPersonality`。

涉及文件：

- `src/codex/types.ts`
- `src/codex/app-server/model-policy.ts`
- `src/bridge/formatters.ts`
- `src/bridge/commands/model-command.ts`
- `src/bridge/status-text.ts`
- `src/codex/mock-codex-adapter.ts`
- 相关单元测试

验收：

- 新 effort 不被过滤。
- `/plan`、`/code` 不改变模型 policy。
- `/model` 展示不丢新字段。

### Phase 2：关键新通知稳定化

目标：

- 处理 `thread/deleted`。
- 处理或明确本地记录 `model/safetyBuffering/updated`。
- 检查 `turn/completed` 终端错误字段。
- 对 `item/reasoning/textDelta` 保持安全忽略或摘要化。

涉及文件：

- `src/codex/app-server/notification-mapper.ts`
- `src/codex/app-server-codex-adapter.ts` 或后续拆分模块
- `src/codex/types.ts`
- Bridge route/session 清理相关模块
- TUI runtime log / transcript 相关模块

验收：

- 外部删除当前 thread 时，聊天侧解绑且提示。
- 安全缓冲不被普通进度吞掉。
- 终端错误不会被误当纯成功。

### Phase 3：`/status` 轻量诊断增强

目标：

- 保存最近关键 Codex 通知到内存状态。
- `/status` 展示会话标题、最近关键通知摘要。
- 空闲状态隐藏无意义的 `0` 值噪声。

限制：

- 不新增顶层命令。
- 不在 `/status` 展示 route key、sender id、完整账号标识、provider token。
- 最近通知只展示摘要和时间，完整正文仍以主动通知和 TUI/runtime log 为准。

### Phase 4：保留为内部候选，不进入当前实现

目标：

- `thread/list` / `thread/read` 只作为未来 `/sessions` 底层增强候选。
- 不新增 `/fork`。
- 不实现 deprecated 的 `/rollback`。

限制：

- 必须保留现有本地发现 fallback。
- `thread/delete` 不作为聊天命令开放。

### Phase 5：暂不做高级模型行为控制

目标：

- reasoning summary、personality、review/start、output schema 等不纳入本轮。
- 只保留现有 `/model`、`/plan`、`/code` 行为，并确保它们不破坏 session 原模型和思考等级。

## 五、测试计划

实现阶段按 `docs/development-and-test.zh-CN.md` 执行，至少包含：

```bash
npm run build
```

定向测试建议：

```bash
node --test dist/tests/unit/app-server-mappers.test.js \
  dist/tests/unit/app-server-codex-adapter.test.js \
  dist/tests/unit/bridge-formatters.test.js \
  dist/tests/unit/bridge-command-router.test.js
```

如果改到 route/session 清理、TUI 或真实投递策略，还需要补：

```bash
node --test dist/tests/unit/bridge-route-queue.test.js \
  dist/tests/unit/ink-tui.test.js \
  dist/tests/integration/bridge-mock.test.js
```

最终提交前：

```bash
npm test
git diff --check
```

测试报告要求：

- 每个实现阶段都在 `reports/tests/` 新增中文报告。
- 报告写明参考 Codex HEAD、执行命令、通过/失败结果、未做真实微信/飞书验证的原因。

## 六、风险与控制

### 模型名风险

风险：官方模型名变化快，硬编码会过期。

控制：只把官方模型名写入文档背景，不写死到运行逻辑；运行时以 `model/list` 为准。

### effort 风险

风险：开放字符串可能允许用户输入 Codex 不支持的值。

控制：优先用当前模型 `supportedReasoningEfforts` 校验；没有模型支持列表时才透传语法安全值。

### 账号信息风险

风险：usage/rate limit 可能含账号、workspace、套餐信息。

控制：只读、脱敏、私聊优先，群聊默认不开放。

### 高权限 RPC 风险

风险：`fs/*`、`command/exec`、config/plugin 写入可能绕过现有审批体系。

控制：协议清单中明确 `not_exposed`，任何开放都必须单独设计和测试。

### 通知噪声风险

风险：新增通知过多会再次刷屏微信/飞书。

控制：安全/连接/thread 生命周期低频通知可推送；普通进度继续走本地实时 + 渠道节流策略；reasoning 正文不直接推送。

### 兼容旧版 Codex 风险

风险：新字段或新方法在旧 Codex 不存在。

控制：所有解析使用 optional；新增 client request 先 capability/fallback；未知 method 失败时给可解释提示。

## 七、结论

本轮最应该优先做的不是“把 GPT-5.6 模型名写进项目”，而是把 Chat-Codex 的模型和协议层改成能持续跟随 Codex 运行时元数据：

1. Phase 0 先同步协议清单，保证 reference 更新后测试不漂。
2. Phase 1 立刻修复 `ReasoningEffort` 固定枚举问题，支持 `max` 和未来 effort。
3. Phase 2 补齐 `thread/deleted`、`model/safetyBuffering/updated`、终端错误等稳定性通知。
4. Phase 3 只增强 `/status` 轻量诊断面，把关键通知、会话标题和非 0 阻塞项展示清楚。
5. `/usage`、`/limits`、`/fork`、`/rollback` 不作为本轮目标；`thread/list` / `thread/read` 仅保留为未来 `/sessions` 底层候选。
