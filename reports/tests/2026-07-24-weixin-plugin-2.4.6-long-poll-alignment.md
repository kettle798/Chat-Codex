# 测试报告：微信插件 2.4.6 长轮询可靠性对齐

## 测试目标

验证 Chat-Codex 微信 adapter 对齐 `@tencent-weixin/openclaw-weixin` 2.4.4–2.4.6 的长轮询可靠性行为：

- 停止 adapter 时立即取消 pending `getupdates`。
- 客户端自身 long-poll 超时视为正常空轮询。
- 服务端 `longpolling_timeout_ms` 用于下一次轮询。
- 默认参考/wire 版本更新为 `2.4.6`。

## 测试环境

- 日期：2026-07-24
- 分支：`main`
- Node.js：`v24.14.0`
- 操作系统：macOS Darwin `25.5.0` arm64
- 微信参考版本：`@tencent-weixin/openclaw-weixin@2.4.6`
- 渠道：mock Weixin API；真实微信待补测

## 执行命令

```bash
npm run build
node --test dist/tests/integration/weixin-adapter-api.test.js
npm test
git diff --check
```

## 自动化测试范围

新增到 `tests/integration/weixin-adapter-api.test.ts`：

1. `WeixinApiClient` 自身超时返回空轮询，而外部 abort 继续向 adapter 传播。
2. `WeixinAdapter.stop()` 在 pending `getupdates` 时立即结束，不等待 10 秒测试超时。
3. 第一轮响应的 `longpolling_timeout_ms: 20` 使第二轮在远早于初始 2 秒配置的时间内超时，证明服务端建议被采用。
4. 默认 `channel_version` 和 `iLink-App-ClientVersion` 对应 `2.4.6`。

原有登录、二次验证码、`binded_redirect`、文本、媒体、typing、`ret=-2` fallback、发送限流重试、入站附件和 session 过期测试一并回归。

## 实际结果

- `npm run build`：通过。
- 微信 adapter 定向测试：`21 passed, 0 failed`。
- `npm test`：`496 passed, 0 failed`。
- `git diff --check`：通过。

## 结论

P0 长轮询可靠性对齐通过自动化验证。改动只发生在 `src/channels/weixin/`，不接入 OpenClaw runtime，不改变 Bridge Core，也不重新开启微信 progress 投递。

## 代码规模审计

- `src/channels/weixin/weixin-adapter.ts` 当前为 `963` 行，超过开发规范的 `600` 行默认拆分触发点。
- 本轮只在该文件的既有轮询状态机中增加外部中止传递和下一轮超时选择，改动与 `AbortController`、`pollTask`、账号 cursor、adapter status 及入站 handler 使用同一份状态；为这十余行改动抽出 controller 会引入新的回调和共享状态接口，扩大可靠性补丁的风险，因此本轮保留在 adapter 内。
- 后续建议按职责拆分：`weixin-polling-controller.ts` 负责轮询生命周期、cursor、超时和退避；`weixin-outbound-queue.ts` 负责串行发送、重试与 `context_token` fallback；`weixin-message-mapping.ts` 负责入站文本/附件映射。
- `src/channels/weixin/weixin-api.ts` 当前为 `343` 行，本轮的 signal 组合逻辑保留在 API 客户端边界，未触发 600 行审查线。

## 遗留问题

- 尚未连接真实微信账号执行启动、空闲 long-poll、停止、重启的端到端验证。
- 上游 2.4.5 的 fetch 网络错误分类属于 P1 可观测性增强，本轮未实现。
