# Codex 参考版本 81da9deb0 兼容性评估

## 目标

本文件只回答一个问题：在 Codex 参考源码更新后，Chat-Codex 是否需要调整 app-server 协议或关键运行行为，才能继续稳定地服务本地微信、飞书和终端聊天渠道。

目标是保护现有能力：会话创建/恢复、普通 turn、审批、`/P`、`/NO`、`/stop`、模型切换、`/plan`、Goal、上下文压缩、文件输入和状态查询。不是把 Codex App、远程执行环境、Apps、插件或 MCP 富客户端全部搬进聊天渠道。

## 当前基线

- 参考仓库：`references/openai-codex`。
- 已于 2026-07-24 拉取并切换到官方 `origin/main`：`81da9deb065d7adb283816b19b40f89bcc484276`。
- 参考仓库本地 `main` 与 `origin/main` 同步。
- 当前本机 Codex CLI：`codex-cli 0.145.0`。CLI 版本号不携带参考源码 commit，因此源码审计不能替代升级后的真实二进制冒烟测试。
- Chat-Codex 当前提交：`0b33dbc Add cwd diagnostics and simplify permission output`。

## 结论

**当前不需要为 `81da9deb0` 新增 app-server 协议代码。**

与上一份已审计的参考基线 `f61b51ddd` 相比，`81da9deb0` 在 `codex-rs/app-server` 和 `codex-rs/app-server-protocol` 下没有文件变更；变更只落在 `codex-rs/core` 的远程执行环境等待工具上。现有 `thread/start`、`thread/resume`、`turn/start`、审批、模型和通知协议字段不需要改写。

Chat-Codex 的协议 inventory 测试会读取当前参考仓库的生成 schema，并要求每一个 client request、server request、server notification 都被显式分类。该测试已在 `81da9deb0` 下通过，因此参考源码新增方法不会被静默遗漏。

这表示当前本地聊天桥接的代码适配状态为：

| 项目 | 状态 | 决策 |
| --- | --- | --- |
| 基础 app-server 请求与通知 | 已兼容 | 保持现有实现 |
| 新增 schema 方法分类 | 已完成 | 保持 inventory 测试作为更新门禁 |
| 远程 code-mode host / WebSocket | 未实现 | 不影响本地 cwd 模式，暂不接入 |
| `wait_for_environment` | 不适用 | 仅远程 Deferred Executor 场景考虑 |
| Apps、plugin、动态工具、MCP 富交互 | 安全未暴露 | 保持 fail-closed |

## 本次上游变化：`wait_for_environment`

`81da9deb0` 的主题是让远程环境 host 自定义模型可见的 `wait_for_environment` 工具说明和 `environment_id` 参数说明。

它的边界很明确：

- 配置以 Core 内部的 `WaitForEnvironmentToolConfig` 形式作为 thread extension data 注入。
- 工具仍受 `DeferredExecutor` feature 开关控制；未启用时不会注册该工具。
- 这不是新增的 `thread/start`、`thread/resume` 或 `turn/start` 必填字段，也不是 Chat-Codex 必须响应的新 server request。
- 它服务于“某个远程环境正在启动，模型等待该环境就绪”的执行模型；本项目当前每个 session 使用本机 cwd，不选择远程 executor。

因此不能为了跟随版本而盲目发送 `environments`、`runtimeWorkspaceRoots` 或自定义等待工具描述。当前生成的 `ThreadStartParams`、`ThreadResumeParams`、`TurnStartParams` 继续接受 Chat-Codex 已发送的 `cwd`、审批策略、sandbox、模型、service tier、effort 和 collaboration mode；没有要求本项目改变本地工作区模型。

## 已完成的协议漂移适配

参考仓库从此前的 `5c19155c` 更新到 `f61b51ddd` 期间，出现了一批新方法和通知。它们已经在 `0b33dbc` 中完成分类，并由 inventory 测试覆盖：

| 协议项 | 当前处理 | 原因 |
| --- | --- | --- |
| `app/read`、`app/installed` | `not_exposed` | Apps/连接器元数据不属于聊天桥核心流程。 |
| `externalAgentConfig/import/recordHistory` | `not_exposed` | 会写入外部 Agent 配置导入历史，不能由聊天命令触发。 |
| `thread/environment/connected`、`thread/environment/disconnected` | `ignored_safe` | 当前没有远程环境模型；忽略不会影响本地 cwd session。 |
| `rawResponse/completed` | `ignored_safe` | 原始响应收尾不改变聊天最终回复或 turn 生命周期。 |

这类“先显式分类、再决定是否开放”的策略是正常运行的关键：未知协议变化不会让 adapter 崩溃，也不会把新增高权限能力意外暴露给微信或飞书。

## 必须维持的兼容性门禁

### P0：每次更新参考源码或实际 Codex CLI 时执行

1. 更新 `references/openai-codex` 后运行 `npm test`。
2. 确认 `tests/unit/app-server-mappers.test.ts` 中的 protocol inventory 通过。
3. 检查新增方法是否属于以下类别：
   - 现有聊天流程必须处理的 request/notification：实现或给出明确的可见失败。
   - 仅富客户端、账号、配置、插件、文件系统或远程执行能力：先标记 `not_exposed` 或 `ignored_safe`。
4. 对实际升级后的 Codex CLI 做一次有登录态的本地冒烟测试：创建/恢复 session、普通 prompt、审批、`/stop`、`/status` 和模型列表。
5. 微信或飞书真实通道只补测最终回复、错误和审批即可；不因为新版协议重新开放过程消息。

第 4、5 项不能由 mock schema 测试完全替代。inventory 测试保证“方法没有漏分类”，但不保证安装在机器上的 Codex 二进制没有改变认证、配置加载或运行时行为。

### P1：只有引入远程执行环境时才实现

以下能力不应作为当前本地桥接的版本兼容修复，而应在明确支持 remote code-mode host 后单独设计：

- route/session 绑定一个显式 environment，而不是只存本机 cwd。
- 保存 environment id、连接状态、远程 cwd 和可写根目录语义。
- 将 `thread/environment/connected`、`thread/environment/disconnected` 变成 `/status` 的低频状态，而不是普通微信 progress。
- 当模型等待远程环境时，给聊天侧一个低频“环境启动中”状态；不要把 `wait_for_environment` 当成用户命令。
- 为 WebSocket host 的认证、断线、重连、权限和日志脱敏建立独立安全模型。

在这些前提具备前，`runtimeWorkspaceRoots` 不是给本机 cwd 扩权的手段，也不应作为修复 `invalid cwd` 的参数；后者继续由 cwd 诊断、挂载状态和 macOS 权限处理。

### P2：明确不作为兼容性适配开放

- `fs/*`、`command/exec*`、`config/*`、账号登录/登出、额度消耗。
- Apps、plugin、marketplace、外部 Agent 配置导入。
- `item/tool/call` 动态工具执行和 MCP OAuth 表单流。
- Realtime 音频、远程控制和完整 Codex App UI。

这些能力即使出现在 app-server schema 中，也不是“为了让现有 Chat-Codex 正常运作”所必需；直接暴露会绕过当前 route、审批、沙箱或聊天身份边界。

## 当前验证结果

2026-07-24 已在 `81da9deb0` 参考树下执行：

```text
npm test
487 passed, 0 failed

node --test dist/tests/unit/app-server-mappers.test.js
12 passed, 0 failed
```

其中 protocol inventory 已确认当前生成 schema 的方法全部有分类。`codex app-server --help` 也确认本机 CLI 仍提供 Chat-Codex 使用的 `--listen stdio://` transport。

## 后续决策

1. 当前不改 app-server adapter 的请求 payload，也不新增聊天命令。
2. 保持参考仓库更新后先跑 inventory 和全量测试的流程。
3. 真实 Codex CLI 升级后，优先做本地 app-server 冒烟测试；发现请求字段、通知或错误语义变化时，再按 P0 范围做最小修复。
4. 只有产品明确需要远程执行环境时，再启动环境模型和 WebSocket host 的独立设计，不与本地聊天桥接兼容性修复混在一起。
