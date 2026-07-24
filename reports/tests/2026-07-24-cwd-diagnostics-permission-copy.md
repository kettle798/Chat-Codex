# 测试报告：cwd 诊断与权限文案精简

## 测试目标

- Codex app-server 返回 `invalid cwd` 时，聊天侧保留原始错误文本。
- Bridge 记录请求 cwd、继承 cwd、请求来源与 session id，供 `/status` 和终端日志排障。
- 失败 turn 不自动重试、不重建 session、不重放用户任务。
- `/permission` 收敛为当前模式、范围、简短说明和三条带作用说明的切换命令。
- 本地更新的 Codex app-server 协议参考新增接口被显式分类，不意外暴露新能力。

## 测试环境

- 日期：2026-07-24
- 分支：`main`
- 操作系统：macOS
- Codex 参考源码：`references/openai-codex`，HEAD `f61b51ddd`
- 渠道：mock / weixin-like / feishu mock 集成路径

## 执行命令

```bash
npm run build
node --test dist/tests/unit/app-server-codex-adapter.test.js
node --test dist/tests/integration/bridge-mock.test.js
node --test dist/tests/unit/bridge-route-queue.test.js
node --test dist/tests/unit/app-server-mappers.test.js
npm test
git diff --check
```

## 覆盖内容

1. fake app-server 在 `turn/start` 返回 `invalid cwd: Operation not permitted (os error 1)`；adapter 记录诊断，且只发起一次 `turn/start`。
2. mock Bridge 验证聊天侧原样发送 Codex 错误，`/status` 展示 cwd 诊断，终端 logger 收到结构化诊断记录。
3. `/permission` 集成测试验证精简版输出包含三条切换命令及各自作用说明，不再展示 Codex 侧审批人、sandbox 和审批支持等底层字段。
4. 协议库存测试验证参考源码新增的 `app/read`、`app/installed`、`externalAgentConfig/import/recordHistory`、`thread/environment/connected`、`thread/environment/disconnected`、`rawResponse/completed` 均被显式分类；当前均不向聊天侧暴露。

## 实际结果

`npm run build` 通过。

定向测试通过：

```text
AppServerCodexAdapter: 37 passed, 0 failed
Bridge mock: 110 passed, 0 failed
BridgeRouteQueue: 12 passed, 0 failed
app-server mappers: 12 passed, 0 failed
```

全量测试通过：

```text
487 passed, 0 failed
```

`git diff --check` 通过。

## 结论

通过。cwd 问题当前采用“收到原始 Codex 错误后记录诊断”的策略，不改变工作目录，也不会触发自动重试或任务重放。`/permission` 输出已按聊天渠道阅读成本精简。真实微信和飞书渠道尚未针对本次状态文本与日志改动做手工验证；现有 mock、weixin-like、feishu mock 路径已覆盖核心行为。
