# 测试报告：Session 详情与权限模式对齐

## 测试目标

验证本轮两项适配：

1. `/session <id>`、`/session detail <id>` 可以通过 Codex app-server `thread/read(includeTurns:false)` 展示 session 详情，同时保留 `/session`、`/session all`、`/session cwd` 和数字分页原有交互。
2. 权限模式对齐官方可见的三档模式：`approval`、`approve-for-me`、`full`，不暴露 `readonly`，并在 `/permission`、`/status`、`/help`、CLI/TUI 展示和持久化中保持一致。

## 测试环境

- 日期：2026-07-11
- 分支/提交：`main` / `315b0b1`（工作区有未提交变更）
- Node.js 版本：`v24.14.0`
- 操作系统：macOS Darwin 25.5.0 arm64
- Codex 版本：`codex-cli 0.144.1`
- 渠道：mock / 本地单元测试 / 本地集成测试

## 执行命令

```bash
git diff --check
npm test
```

接续实现阶段已执行过定向测试：

```bash
npm run build
node --test dist/tests/unit/app-server-mappers.test.js dist/tests/unit/app-server-codex-adapter.test.js dist/tests/unit/bridge-command-router.test.js dist/tests/unit/bridge-formatters.test.js dist/tests/unit/codex-cli.test.js dist/tests/unit/file-state-store.test.js dist/tests/unit/exec-codex-adapter.test.js dist/tests/unit/serve-helpers.test.js dist/tests/unit/serve-wizard.test.js dist/tests/unit/tui-navigation.test.js dist/tests/unit/ink-tui.test.js dist/tests/integration/bridge-mock.test.js
```

## 测试步骤

1. 检查开发规范，确认本轮需要自测并新增中文测试报告。
2. 执行 `git diff --check`，检查补丁空白格式。
3. 执行 `npm test`，覆盖 TypeScript 构建、全部单元测试和集成测试。
4. 重点确认 session 详情、`thread/list` / `thread/read` 映射、权限模式映射、命令路由、状态文本、持久化、CLI/TUI 和 mock bridge 流程测试通过。

## 实际结果

- `git diff --check`：通过，无空白错误。
- `npm test`：通过。
  - 构建：`tsc -p tsconfig.json` 通过。
  - 测试汇总：`485 passed, 0 failed`。
- 定向测试结果：通过，`254 passed, 0 failed`。
- `codex --version` 能返回 `codex-cli 0.144.1`，本机环境提示 PATH alias 创建受限，但不影响本轮构建和测试。

## 结论

通过。

本轮已完成 `/session <id>` 详情适配和三档权限模式对齐，并通过完整本地自动化测试。

## 遗留问题

- 本轮未进行真实微信、飞书通道人工投递测试；相关命令和状态展示已由 mock / 单元 / 集成测试覆盖。
- `approve-for-me` 依赖 app-server adapter 支持 `auto_review`；exec adapter 不支持时会明确拒绝，不做静默降级。
