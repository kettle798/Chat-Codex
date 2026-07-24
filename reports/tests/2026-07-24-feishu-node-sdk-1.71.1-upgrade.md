# 测试报告：飞书 Node SDK 1.71.1 升级

## 测试目标

将 Chat-Codex 直接依赖的官方飞书 SDK 从 `@larksuiteoapi/node-sdk@1.66.1` 升级到 `1.71.1`，确认现有飞书私聊 adapter 的编译和自动化行为保持可用。

本次不安装或运行 `@larksuite/openclaw-lark`，也不修改 `FeishuAdapter` 的私聊业务逻辑。

## 测试环境

- 日期：2026-07-24
- 分支：`main`（工作区包含其他待提交改动）
- 基线提交：`0b33dbc`
- Node.js：`v24.14.0`
- 渠道：mock / 自动化测试
- SDK：`@larksuiteoapi/node-sdk@1.71.1`

## 变更范围

- `package.json`：依赖范围更新为 `^1.71.1`。
- `npm-shrinkwrap.json`：锁定的 SDK tarball 更新为 `1.71.1`。
- `node_modules`：本机安装结果为 `1.71.1`。

## 执行命令

`npm install @larksuiteoapi/node-sdk@^1.71.1 --save --cache /private/tmp/chat-codex-npm-cache`

`npm ls @larksuiteoapi/node-sdk --depth=0`

`npm run build`

`npm test`

`git diff --check`

共享 npm 缓存目录存在历史 root-owned 文件，首次安装无法写入缓存；改用 `/private/tmp/chat-codex-npm-cache` 后安装成功。该处理不修改系统缓存权限，也不影响项目依赖内容。

## 测试结果

- `npm ls @larksuiteoapi/node-sdk --depth=0`：安装版本为 `1.71.1`。
- `npm run build`：通过。
- `npm test`：通过，`496` 个测试通过、`0` 个失败。
- 飞书相关的私聊、媒体、typing、去重、回复回退、Bridge 集成和群聊关闭保护测试均包含在全量测试中并通过。
- `git diff --check`：通过。

## 真实飞书测试待补

自动化测试不连接真实飞书应用。升级后需要在真实私聊中验证：

1. 飞书机器人启动后状态为 connected。
2. 私聊文本能够进入 Chat-Codex，并优先回复原消息。
3. Codex 执行期间 Typing reaction 能添加并移除。
4. 图片和文件收发保持可用。
5. 断开并恢复网络后，WebSocket 状态能恢复。

## 结论

SDK 升级未发现编译或自动化回归。现有飞书私聊代码不需要为了 `1.71.1` 增加兼容分支；真实渠道验证完成后，再单独讨论审批卡片能力。
