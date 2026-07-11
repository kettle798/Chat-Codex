# 测试报告：/status 空值降噪

## 测试目标

验证 `/status` 默认视图在空闲状态下不再展示无意义的 0 值项目，同时保留已有状态、上下文 token、渠道状态和非 0 待处理项展示。

## 测试环境

- 日期：2026-07-11
- 分支：`main`
- Node.js：本机当前 `npm` / `node --test` 环境
- 操作系统：macOS
- 渠道：mock / weixin-like 集成测试

## 执行命令

```bash
npm run build
node --test dist/tests/integration/bridge-mock.test.js
git diff --check
```

## 测试步骤

1. 修改 `/status` 运行区默认展示逻辑。
2. 补充 mock 集成测试断言，确认空闲状态不展示 `排队消息: 0`、`待投递补充消息: 0`、`待处理附件: 0`、`待审批: 0`、`上下文压缩: 无`。
3. 执行 TypeScript 构建。
4. 执行 Bridge mock 集成测试，覆盖 `/status`、队列、审批、进度、微信-like 策略等路径。
5. 执行 diff 空白检查。

## 实际结果

`npm run build` 通过。

`node --test dist/tests/integration/bridge-mock.test.js` 通过：

```text
106 passed, 0 failed
```

`git diff --check` 通过。

## 结论

通过。`/status` 默认视图已减少空值噪声，非 0 场景仍由现有测试覆盖，例如待投递补充消息为 1 时继续展示。

## 遗留问题

- 本次未执行真实微信/飞书验证；改动只影响 Bridge 文本格式化，已通过 mock / weixin-like 集成路径验证。
