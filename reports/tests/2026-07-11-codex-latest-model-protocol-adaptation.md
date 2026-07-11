# 测试报告：Codex 最新模型与协议稳定性适配

## 测试目标

验证本次 Codex 2026-07 最新模型与协议稳定性适配：

- app-server 协议清单能覆盖 `references/openai-codex` 最新 schema。
- `ReasoningEffort` 不再被旧固定枚举过滤，支持 `max` 和未来格式合法的 effort。
- 模型列表解析保留 `defaultServiceTier`、`inputModalities`、`supportsPersonality`、升级提示等新增元数据。
- `/model` 命令按当前模型 supported efforts 判断支持性。
- `thread/deleted` 进入生命周期解绑路径。
- `model/safetyBuffering/updated` 能转为低频 Codex 通知。

## 测试环境

- 日期：2026-07-11
- 分支/提交：`main`，HEAD `315b0b1`，工作区有前序未提交改动
- Codex 参考源码：`references/openai-codex` HEAD `5c19155c`
- Node.js：本机当前 `npm`/`node --test` 环境
- 操作系统：macOS
- 渠道：mock / app-server fake / 单元测试

## 执行命令

```bash
npm run build
node --test dist/tests/unit/app-server-mappers.test.js dist/tests/unit/app-server-codex-adapter.test.js dist/tests/unit/bridge-formatters.test.js dist/tests/unit/bridge-command-router.test.js dist/tests/integration/bridge-mock.test.js
npm test
node --test dist/tests/unit/ink-tui.test.js
npm test
node --test dist/tests/unit/ink-tui.test.js
node --test --test-concurrency=1 dist/tests/unit/*.test.js dist/tests/integration/*.test.js
npm test
git diff --check
```

## 测试步骤

1. 执行 TypeScript 构建。
2. 执行 app-server mapper、app-server adapter、Bridge formatter、命令路由和 mock bridge 定向测试。
3. 执行默认全量测试。
4. 对默认全量中出现的 TUI 失败用例单独重跑 `ink-tui.test.js`。
5. 用串行模式执行全量 Node 测试，排除并行/时序互相影响。
6. 执行 `git diff --check` 检查补丁空白。

## 实际结果

### 构建

`npm run build` 通过。

### 定向测试

定向测试通过：

```text
171 passed, 0 failed
```

覆盖重点：

- 协议 inventory：最新 reference schema 全部方法已在 `APP_SERVER_PROTOCOL_CAPABILITIES` 分类。
- 模型 mapper：保留 `max`、`ultra`、`defaultServiceTier`、`inputModalities`、`supportsPersonality`。
- `/model`：mock 渠道可设置 `gpt-next max`，不支持的 future effort 会按当前模型 supported efforts 拒绝。
- app-server adapter：`model/safetyBuffering/updated` 转成 Codex 通知。

### 默认全量测试

`npm test` 执行了三次，均完成构建。前两次默认并行测试各出现 1 个 TUI 相关失败：

第一次：

```text
476 passed, 1 failed
失败：Ink TUI first run exit action is selectable
```

随后单独重跑：

```bash
node --test dist/tests/unit/ink-tui.test.js
```

通过：

```text
23 passed, 0 failed
```

第二次：

```text
476 passed, 1 failed
失败：Ink TUI manages route pairing trust and blocks untrusted binding actions
```

随后单独重跑同一 TUI 测试文件，通过：

```text
23 passed, 0 failed
```

这两个失败点都在前序未提交的 TUI 测试范围内，且单独重跑通过；本次 Codex 协议/模型适配定向测试未复现失败。

第三次默认全量测试通过：

```text
477 passed, 0 failed
```

### 串行全量测试

为排除默认并行测试互相影响，执行：

```bash
node --test --test-concurrency=1 dist/tests/unit/*.test.js dist/tests/integration/*.test.js
```

结果通过：

```text
477 passed, 0 failed
```

### 补丁检查

`git diff --check` 通过。

## 结论

本次 Codex 最新模型与协议稳定性适配通过构建、定向测试、TUI 单独重跑、串行全量测试、最终默认全量 `npm test` 和 diff 检查。

默认 `npm test` 的并行全量模式曾出现 TUI 用例偶发失败，第三次已通过；该现象与本次 Codex 模型/协议适配路径无直接关联，但仍建议后续单独关注 TUI 测试稳定性。

## 遗留问题

- 可后续单独排查默认并行 `npm test` 下 `ink-tui.test.js` 偶发失败的问题。
- 未做真实微信/飞书渠道验证；本次改动主要是 app-server 协议、模型解析和 mock 命令路径。
