# Codex 权限模式对齐设计

## 背景

Chat-Codex 当前只实现了两个权限模式：

- `approval`：`workspace-write` sandbox，需要审批时交给用户。
- `full`：完全权限，跳过审批和沙箱。

新版 Codex TUI / app-server 已经把“谁来审批”和“沙箱权限”拆得更细。用户在官方 Codex UI 中实际看到的是三个用户可见模式：

1. `Ask for approval`
2. `Approve for me`
3. `Full Access`

此前讨论中把 Codex 底层存在的 `read-only` preset 当成 Chat-Codex 用户可见模式是不严谨的。本文档明确：Chat-Codex 本轮只对齐这三个官方可见模式，不新增 `/permission readonly`。

实现阶段必须先阅读 `docs/development-and-test.zh-CN.md`，按规范完成自测，并在 `reports/tests/` 留中文测试报告。

## 资料来源

### Codex TUI 权限弹窗

参考源码：`references/openai-codex/codex-rs/tui/src/chatwidget/permission_popups.rs`

关键行为：

- 默认权限弹窗通过 `builtin_approval_presets()` 构造。
- `include_read_only = cfg!(target_os = "windows")`。
- 非 Windows 默认跳过 `read-only` preset。
- `auto` preset 会按 `approvals_reviewer` 展示为：
  - `Ask for approval`
  - `Approve for me`
- `full-access` 进入 `Full Access`，并带二次确认。

因此 macOS / Linux 下，`read-only` 不是默认用户可见权限模式。Chat-Codex 不能把它作为聊天命令默认暴露。

### app-server 协议

参考源码：

- `references/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/ApprovalsReviewer.ts`
- `references/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/ThreadSettings.ts`
- `references/openai-codex/codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts`

核心字段：

- `approvalPolicy`
  - `on-request`
  - `never`
  - 以及未来/细粒度扩展值
- `approvalsReviewer`
  - `user`
  - `auto_review`
  - `guardian_subagent`
- `sandboxPolicy`
- `activePermissionProfile`

Chat-Codex 本轮只使用 `user` 和 `auto_review`，不暴露 `guardian_subagent`。

## 目标

1. Chat-Codex 用户可见权限模式收敛为三个：
   - 审批模式：`approval`
   - 自动审批模式：`approve-for-me`
   - 完全权限：`full`
2. `/permission`、`/help`、TUI 文案和状态展示与这三个模式一致。
3. `approve-for-me` 对齐 Codex 的 `ApprovalsReviewer = auto_review`，不伪装成 `full`，也不降级成普通 `approval`。
4. 不新增 `/permission readonly`，不在 README 或帮助里展示 `readonly`。
5. 如果 app-server 通知或 thread settings 中出现 `activePermissionProfile=read-only`，只作为诊断信息展示，不写回 Chat-Codex run policy。

## 非目标

- 不实现 `/permission readonly`。
- 不实现自定义 permission profile 的选择、创建或持久化。
- 不实现 `guardian_subagent`。
- 不把 `permissionProfile/list` 做成完整权限管理 UI。
- 不改变 `/plan`、`/code` 的模型、思考等级、权限策略语义。
- 不改变当前 session owner、route binding 和审批作用域规则。

## 用户交互设计

### `/permission`

查看当前权限状态和切换命令。没有绑定 session 时，范围显示为默认策略，影响后续新会话；完整的聊天侧输出见下一节。

### `/permission` 输出精简要求

当前实现的 `/permission` 输出过长，会把用户已经知道或不需要每次看到的底层细节全部刷出来，例如：

```text
**权限模式**
- 作用范围: 当前会话 `...`
- 当前模式: `approval sandbox=workspace-write`
- 审批支持: 支持微信内审批（实际策略 on-request，审批人 user）
- Codex 侧审批人: `user`
- Codex 侧沙箱: `workspace-write`
- `approval`: 使用 `workspace-write` sandbox；是否能在微信里弹审批取决于 Codex adapter。
- `approve-for-me`: 使用 `workspace-write` sandbox；审批请求交给 Codex 自动审阅。
- `full`: 完全权限，跳过审批和沙箱，风险很高。
- 切回安全沙箱模式: `/permission approval`
- 切到自动审阅模式: `/permission approve-for-me confirm`
- 切到完全权限: `/permission full confirm`
- 说明: codex app-server 会把审批请求回调给中间件，可通过微信 /OK、/P 或 /NO 处理。
```

这个输出不适合聊天渠道，尤其是微信。`/permission` 应优先回答“现在是什么、怎么切换”，不应每次展开 app-server reviewer、sandbox、adapter 支持说明和审批命令说明。

建议收敛为：

```text
**权限模式**
- 当前: `approval`（手动审批，workspace-write）
- 范围: 当前会话 `...`
- 说明: Codex 可在工作区内执行；越界或高风险操作会请求审批。

切换:

/permission approval
- 手动审批：遇到需要授权的操作，由你用 `/OK`、`/P` 或 `/NO` 决定。

/permission approve-for-me confirm
- 自动审阅：Codex 自动处理审批请求，仍限制在工作区沙箱内。

/permission full confirm
- 完全权限：跳过审批和沙箱，仅用于完全信任的任务。
```

不同模式的一行说明：

```text
approval: 手动审批，workspace-write。越界或高风险操作会请求审批。
approve-for-me: 自动审阅，workspace-write。Codex 自动审阅审批请求，不等于完全权限。
full: 完全权限。跳过审批和沙箱，只在信任任务时使用。
```

展示规则：

- 默认显示当前模式、作用范围、当前模式的一行说明，以及切换命令。
- 每条切换命令下方保留一句作用说明，帮助用户在聊天渠道直接判断该命令的风险与效果。
- 只保留当前模式的一行说明，不展示 `approval` / `approve-for-me` / `full` 的长解释。
- 不展示 “Codex 侧审批人”、“Codex 侧沙箱”、“审批支持” 等底层字段。
- 不展示 “可通过微信 /OK、/P 或 /NO 处理” 这类审批说明；审批请求消息自身已经包含这些操作。
- 只有在状态异常、adapter 不支持某模式、Codex 返回和 Chat-Codex run policy 不一致时，才追加一行诊断说明。
- 详细说明应放在 README、`/help` 或 TUI 说明页，不放在每次 `/permission` 响应里。

### 实施状态（2026-07-24）

已在 `src/bridge/status-text.ts` 实现上述精简输出，并由 Bridge mock 集成测试覆盖：

- 当前模式、作用范围和一行说明保留。
- 三条切换命令均保留一行作用说明。
- 不再展示 Codex 侧审批人、sandbox、adapter 审批支持和重复的审批操作说明。

### `/permission approval`

含义：

- 对齐官方 `Ask for approval`。
- Codex 可以在 workspace 内工作。
- 需要越界或高风险动作时，由用户审批。

命令：

```text
/permission approval
```

该命令不需要二次确认，因为它是默认低风险模式。

### `/permission approve-for-me confirm`

含义：

- 对齐官方 `Approve for me`。
- 仍使用 workspace 级沙箱。
- 审批请求不直接交给用户，而是交给 Codex app-server 的 `auto_review`。
- 这不是完全权限，也不是跳过所有保护。

主命令：

```text
/permission approve-for-me confirm
```

兼容别名：

```text
/permission auto confirm
```

需要二次确认，原因是它会减少用户手动审批次数，安全语义和普通 `approval` 不同。

确认提示建议：

```text
Approve for me 会让 Codex 自动审阅审批请求，只在自动审阅认为需要时再阻断。
它不是完全权限，但会减少你手动确认的机会。

确认切换请发送:
/permission approve-for-me confirm
```

如果当前 adapter 不支持 app-server `auto_review`，必须明确拒绝：

```text
当前 Codex Adapter 不支持 Approve for me。请继续使用 /permission approval 或 /permission full confirm。
```

不得静默降级成 `approval`。

### `/permission full confirm`

含义：

- 对齐官方 `Full Access`。
- 跳过审批。
- 使用完全权限沙箱。
- 高风险，必须确认。

命令：

```text
/permission full confirm
```

确认提示继续保留并强化风险说明。

## 模式映射

| Chat-Codex 模式 | 官方 UI 标签 | `approvalPolicy` | `approvalsReviewer` | sandbox | 是否确认 |
| --- | --- | --- | --- | --- | --- |
| `approval` | `Ask for approval` | `on-request` | `user` | `workspace-write` | 否 |
| `approve-for-me` | `Approve for me` | `on-request` | `auto_review` | `workspace-write` | 是 |
| `full` | `Full Access` | `never` | 不参与审批，建议省略或传 `null` | `danger-full-access` | 是 |

说明：

- `approve-for-me` 和 `approval` 的 sandbox 相同，差异在 `approvalsReviewer`。
- `full` 不应使用 `auto_review`，因为已经没有审批请求需要自动审阅。
- `read-only` 不在此表中，因为它不是本轮用户可见模式。

## 数据模型设计

当前类型：

```ts
export type CodexPermissionMode = "approval" | "full";
```

目标类型：

```ts
export type CodexPermissionMode = "approval" | "approve-for-me" | "full";
```

`CodexRunPolicy` 继续保持轻量：

```ts
export interface CodexRunPolicy {
  permissionMode: CodexPermissionMode;
  sandbox?: CodexSandboxMode;
}
```

不建议在 `CodexRunPolicy` 上直接开放任意 `approvalsReviewer` 字符串，避免把 app-server 底层协议泄漏成聊天侧 API。Chat-Codex 的公开模式先固定为三个稳定语义。

`CodexRunPolicyStatus` 可扩展只读诊断字段：

```ts
export interface CodexRunPolicyStatus {
  policy: CodexRunPolicy;
  interactiveApprovals: boolean;
  effectiveApprovalPolicy?: "never" | "on-request" | string;
  effectiveApprovalsReviewer?: "user" | "auto_review" | string | null;
  effectiveSandbox?: string;
  activePermissionProfile?: string | null;
  note?: string;
}
```

这些字段只用于 `/permission`、`/status` 和 TUI 展示，不作为用户命令入口。

## app-server 适配设计

### `run-policy.ts`

目标映射：

```ts
approvalPolicyForRunPolicy("approval") = "on-request"
approvalPolicyForRunPolicy("approve-for-me") = "on-request"
approvalPolicyForRunPolicy("full") = "never"

approvalsReviewerForRunPolicy("approval") = "user"
approvalsReviewerForRunPolicy("approve-for-me") = "auto_review"
approvalsReviewerForRunPolicy("full") = null

sandboxModeForRunPolicy("approval") = "workspace-write"
sandboxModeForRunPolicy("approve-for-me") = "workspace-write"
sandboxModeForRunPolicy("full") = "danger-full-access"
```

`sandboxPolicyForRunPolicy()` 中 `approve-for-me` 与 `approval` 使用同一套 workspace-write policy。

### `thread/start`、`thread/resume`、`turn/start`

- 新会话使用当前默认 run policy。
- resume 已有 session 时使用 session 级 run policy。
- 单个 turn 的 policy 改写只影响后续 turn，不回写历史。
- `/plan`、`/code` 不调用 `setRunPolicy()`，不改变权限模式。

### `thread/settings/updated`

如果 app-server 推送了 thread settings：

- 更新状态展示中的 `approvalPolicy`、`approvalsReviewer`、`sandboxPolicy`、`activePermissionProfile`。
- 不自动把 `activePermissionProfile` 反向转换为 Chat-Codex run policy。
- 如果显示为 `read-only`，只提示“Codex 侧当前 profile: read-only”，不新增 `/permission readonly`。

## exec adapter 行为

`codex exec` 非交互模式不具备完整 app-server 审批回调能力。当前 `approval` 在 exec adapter 中本来就只是恢复 workspace-write sandbox。

本轮建议：

- `exec` adapter 支持 `approval`。
- `exec` adapter 支持 `full`。
- `exec` adapter 不支持 `approve-for-me`，收到切换请求时明确拒绝。

这样可以避免用户以为 `approve-for-me` 已经真实生效。

## TUI 与启动配置

TUI 权限设置应展示三个选项：

1. 审批模式
2. Approve for me
3. 完全权限

默认仍是审批模式。

完全权限继续保留二次确认。Approve for me 建议也保留确认页，说明“由 Codex 自动审阅审批请求，不等于完全权限”。

如果当前 Codex adapter 不支持 `approve-for-me`，TUI 中该项应显示不可用或选择后给出明确错误，不应静默切换。

## 帮助和文档

需要同步：

- `/help`
  - `/permission [approval|approve-for-me confirm|full confirm]`
- `/permission` 输出
- README 聊天命令表
- TUI 权限设置文案
- 设计文档索引 `docs/README.md`

不写入：

- `/permission readonly`
- `read-only` 用户操作说明

如果必须提到 `read-only`，只在开发设计或诊断说明中出现，并明确“不是本轮用户可见模式”。

## 测试计划

实现阶段至少覆盖：

### 单元测试

- `approvalPolicyForRunPolicy()`：
  - `approval -> on-request`
  - `approve-for-me -> on-request`
  - `full -> never`
- `approvalsReviewerForRunPolicy()`：
  - `approval -> user`
  - `approve-for-me -> auto_review`
  - `full -> null`
- `sandboxModeForRunPolicy()`：
  - `approval -> workspace-write`
  - `approve-for-me -> workspace-write`
  - `full -> danger-full-access`
- `formatRunPolicy()` 和 `formatRunPolicyForStatus()` 能展示 `approve-for-me`。
- `permission-command`：
  - `/permission approval` 生效。
  - `/permission approve-for-me` 未确认时提示确认。
  - `/permission approve-for-me confirm` 生效。
  - `/permission auto confirm` 作为别名生效。
  - `/permission full confirm` 仍生效。
  - `/permission readonly` 返回未知模式或不支持，不切换状态。

### 集成测试

- mock bridge 中切换到 `approve-for-me` 后，只影响当前绑定 session。
- 多 session 场景下，A session 切到 `approve-for-me` 不影响 B session。
- busy route 下权限修改仍沿用现有阻断规则。
- `/status` 和 `/permission` 展示三种模式之一。
- `/help` 不展示 `readonly`。

### app-server adapter 测试

- `thread/start` payload 对 `approve-for-me` 传：
  - `approvalPolicy = on-request`
  - `approvalsReviewer = auto_review`
  - `sandbox = workspace-write`
- `turn/start` 或后续 policy 更新 payload 对 `approve-for-me` 传：
  - `approvalPolicy = on-request`
  - `approvalsReviewer = auto_review`
  - workspace sandbox policy
- `full` 不带 `auto_review`。

### TUI 测试

- 权限页展示审批、Approve for me、完全权限。
- 默认选中审批模式。
- 完全权限仍需要确认。
- Approve for me 需要确认或明确提示。

### 测试报告

实现完成后新增：

```text
reports/tests/YYYY-MM-DD-codex-permission-modes-alignment.md
```

报告中记录：

- 执行命令
- 单元测试结果
- 集成测试结果
- 是否执行全量 `npm test`
- 真实微信/飞书是否需要用户补测

## 分阶段实施

### 阶段一：核心 run policy

- 扩展 `CodexPermissionMode`。
- 更新 app-server `run-policy.ts` 映射。
- 更新 mock adapter、app-server adapter、状态格式化。
- 补 mapper 和 adapter 单元测试。

### 阶段二：聊天命令与帮助

- 更新 `/permission` 命令。
- 更新 `/help`、`/status`、README。
- 确保 `/permission readonly` 不可用。
- 补 bridge 集成测试。

### 阶段三：TUI 设置页

- TUI 权限设置新增 Approve for me。
- 完全权限和 Approve for me 的确认交互分别保留。
- 补 TUI 测试。

### 阶段四：诊断信息

- `/permission` 和 `/status` 可展示 app-server 实际 `approvalPolicy`、`approvalsReviewer`、`sandboxPolicy`、`activePermissionProfile`。
- `read-only` 只作为“Codex 侧当前 profile”展示，不提供切换命令。

## 风险与处理

| 风险 | 处理 |
| --- | --- |
| `approve-for-me` 被误解为完全权限 | 文案明确“自动审阅审批请求，不等于完全权限”。 |
| adapter 不支持 `auto_review` | 明确拒绝，不静默降级。 |
| 官方后续改名 | 内部模式保持 `approve-for-me`，展示文案可跟随更新。 |
| 外部 Codex UI 把 session 改成 read-only | 只展示诊断信息，不开放聊天切换命令。 |
| 权限修改影响运行中的 turn | 沿用现有规则：运行中不改当前 turn，需要立即生效先 `/stop`。 |

## 最终决策

Chat-Codex 本轮权限模式只做：

- `approval`
- `approve-for-me`
- `full`

明确不做：

- `readonly`
- 自定义 permission profile 管理
- guardian subagent 审批

这样既对齐用户在官方 Codex UI 中实际看到的三个模式，又避免把底层协议细节过早暴露成聊天命令。
