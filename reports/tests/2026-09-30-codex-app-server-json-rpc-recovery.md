# 测试报告：Codex app-server JSON-RPC 损坏帧恢复

日期：2026-09-30

## 测试目标

验证 `Unterminated string in JSON` 一类 app-server stdout 损坏帧不会让 Chat-Codex 继续复用失效进程，
也不会自动重放可能已有副作用的请求；同时验证长会话恢复和上下文刷新不再主动请求无上限完整历史。

## 测试环境

- 分支：`main`，实现前基线 `211f311`，本地待提交改动。
- Node.js：`v24.14.0`。
- 操作系统：`Darwin 25.5.0 arm64`。
- Codex CLI：`codex-cli 0.159.0`。
- Codex 参考源码：`references/openai-codex` @ `92bc601ad60542c92bf0bb1e7a2eb70b84ac49d2`。
- 渠道：fake app-server、mock channel；未连接真实微信或飞书帐号。

## 执行命令

```bash
npm run build
node --test dist/tests/unit/app-server-core-modules.test.js dist/tests/unit/app-server-codex-adapter.test.js dist/tests/unit/app-server-mappers.test.js dist/tests/unit/approval-manager.test.js dist/tests/unit/bridge-route-queue.test.js dist/tests/unit/pending-input.test.js
npm test
git diff --check
```

## 覆盖场景

1. 合法 25,000,000 字符的单行 JSON-RPC response 可由现有 `readline + JSON.parse` 正常处理。
2. fake app-server 输出未闭合 JSON 时，RPC client 将其作为 `invalid_json` transport fatal：记录受限诊断、
   reject pending request、废弃当前 child process，并只回调一次 fatal handler。
3. 失败的 `turn/start` 不会自动重放；下一条新任务启动新 app-server 进程后才继续。
4. 新进程在执行下一条 `turn/start` 前用同一 session 发送 `thread/resume`，并带 `excludeTurns: true`。
5. `reloadSession()` 使用有界 `thread/turns/list` / `thread/items/list` 获取最后最终回复，跳过 commentary；
   不再发送 `thread/read(includeTurns: true)`。
6. 分页 API 不可用时 reload 仍成功，但不补投最后回复，也不回退完整历史。
7. 一个 turn 失败时只取消该 session/turn 的审批和 pending input，不清空同 route 的其他请求。
8. 最新参考源码新增的协议项仍可通过 protocol inventory 分类门禁。

## 模块边界与行数检查

- `src/codex/app-server/rpc-client.ts`（341 行）保留 app-server child 的启动、JSON Lines 读取、请求关联和
  transport-fatal 生命周期；这是单一内聚的进程状态机。
- `src/codex/transport-diagnostic.ts`（24 行）只定义受限诊断契约；`src/codex/app-server/thread-history.ts`
  （92 行）只处理有界分页历史读取，两者都有直接单元测试。
- `src/codex/app-server-codex-adapter.ts` 当前为 1232 行，已超过开发规范的拆分检查线。本轮只在其中增加
  已加载 session 的生命周期协调，不把传输解析、诊断格式或历史遍历继续堆入该文件；既有
  `docs/app-server-codex-adapter-refactor-design.zh-CN.md` 仍是后续按状态所有权继续拆分的入口。

## 实际结果

定向测试通过：

```text
tests 89
pass 89
fail 0
```

其中 fake app-server recovery 用例确认：

- `Unterminated string` 以原始错误文本进入 `turn.failed`；
- 失败任务仅记录一次 `turn/start`；
- 后续任务使用第二个 app-server child，且 fake server 强制要求先 `thread/resume` 才接受 `turn/start`；
- `getTransportDiagnostic()` 返回 `invalid_json` 与 stdout 行长度，不保存 raw stdout。

完整回归和 diff 检查通过：

```text
npm test: 541 passed, 0 failed
git diff --check: passed
```

## 真实渠道验证

未进行真实微信或飞书登录态测试。本次改动位于通用 Codex adapter、Bridge turn 清理和本地日志边界，
不改变渠道协议。后续可在真实长 session 中验证：发生 app-server 损坏帧后，当前任务只收到一次失败提示；
确认工作目录状态后发送新的任务，任务应在原 session 上继续而不重复前一任务。

## 结论

定向自动化通过。修复将不可解析 stdout 视为不可恢复的当前进程故障，而不是业务 JSON-RPC 错误；
它不会伪造成功、不会自动重复任务，并降低恢复/刷新时由完整历史引起的大 JSON 帧风险。
