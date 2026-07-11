# 测试报告：`/sessions` thread/list + cwd 浏览与 `/goal` 状态适配

## 测试目标

验证本次改动：

- `/sessions all` 底层可优先使用 Codex app-server `thread/list` 元数据，并保持 route-scoped `/sessions` 不泄漏全局 thread。
- `/sessions cwd` 可以按工作目录浏览历史会话，进入目录后按编号切换 session。
- `/goal` 支持官方最新 Goal 状态 `blocked`、`usageLimited`，并同步 `/help` 文案。
- 原有 `/sessions`、`/sessions all`、`/use`、`/resume`、Goal 命令和 Bridge 主要流程不回归。

## 测试环境

- 日期：2026-07-11
- 分支/提交：main，工作区未提交
- Node.js 版本：v24.14.0
- 操作系统：macOS
- Codex 版本：使用项目 fake app-server / mock channel 自动化验证
- 渠道：mock / fake app-server

## 执行命令

```bash
npm run build
node --test dist/tests/unit/app-server-mappers.test.js dist/tests/unit/app-server-codex-adapter.test.js dist/tests/unit/bridge-formatters.test.js dist/tests/unit/bridge-command-router.test.js dist/tests/integration/bridge-mock.test.js
npm test
```

## 测试步骤

1. 运行 TypeScript 构建，确认新增类型、helper 和流程代码通过编译。
2. 运行定向测试，覆盖 app-server mapper、adapter、formatter、command router 和 Bridge mock 集成流程。
3. 运行全量测试，确认跨模块没有回归。

## 实际结果

- `npm run build` 通过。
- 定向测试通过：`176 passed, 0 failed`。
- 全量 `npm test` 通过：`482 passed, 0 failed`。

关键覆盖：

- `AppServerCodexAdapter lists sessions from app-server thread list for unscoped discovery`
- `Bridge lets users browse sessions by cwd and bind a session from that directory`
- `app-server goal mapper accepts camel and snake case responses`
- `bridge formatters preserve status labels and local goal time`
- `BridgeCommandRouter routes /sessions cwd to interactive handler`
- `Bridge manages experimental goal commands for the current session`

## 结论

通过。

## 遗留问题

- 真实微信/飞书渠道下 `/sessions cwd` 的聊天展示效果需要用户后续实测。
- `thread/goal/updated` / `thread/goal/cleared` 本轮仍不主动推送到聊天渠道，用户可通过 `/goal` 或 `/status` 查看最新状态。
