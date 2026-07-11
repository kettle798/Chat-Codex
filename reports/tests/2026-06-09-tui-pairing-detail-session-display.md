# 测试报告：TUI 配对详情显示绑定 session

## 测试目标

验证 TUI 的“配对详情”页面在聊天 route 已绑定 Codex session 时，除了显示当前绑定状态，也明确显示当前 session 标题、完整 Session ID、最近活跃时间和工作目录。

## 测试环境

- 日期：2026-06-09
- 分支/提交：`main` / `315b0b1`
- Node.js 版本：`v24.14.0`
- 操作系统：Darwin Mac 25.5.0 arm64
- Codex 版本：不涉及真实 Codex 调用
- 渠道：Ink TUI mock dashboard

## 执行命令

```bash
npm run build
node --test dist/tests/unit/ink-tui.test.js
npm test
git diff --check
```

## 测试步骤

1. 在配对详情页把“当前绑定”改为状态字段。
2. 对已绑定 session 的 route 额外展示“当前 session”、“Session ID”、“Session 活跃”和“Session 目录”。
3. 新增 Ink TUI 渲染测试，构造已信任且已绑定 session 的配对 route，进入配对详情并断言上述字段可见。
4. 执行构建、定向 TUI 测试、全量测试和 diff 空白检查。

## 实际结果

- `npm run build` 通过。
- 定向测试 `node --test dist/tests/unit/ink-tui.test.js` 通过：`23 passed, 0 failed`。
- `npm test` 全量通过：`475 passed, 0 failed`。
- `git diff --check` 通过。

## 结论

通过。配对详情现在能清楚展示当前绑定的 Codex session 信息。

## 遗留问题

无。该改动只影响本地 TUI 展示，不涉及微信、飞书真实通道投递。
