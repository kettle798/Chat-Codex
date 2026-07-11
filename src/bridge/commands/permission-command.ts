import type { CodexRunPolicy } from "../../codex/codex-cli.js";
import type { CodexAdapter } from "../../codex/types.js";
import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import type { MemoryStateStore } from "../../state/memory-state-store.js";
import type { BridgeDelivery } from "../delivery.js";
import type { BridgeRouteQueue } from "../route-queue.js";
import type { BridgeStatusText } from "../status-text.js";
import { isConfirmed } from "../formatters.js";

export interface PermissionCommandOptions {
  codex: CodexAdapter;
  state: MemoryStateStore;
  delivery: BridgeDelivery;
  routeQueue: BridgeRouteQueue;
  statusText: BridgeStatusText;
  runPolicyStatus(sessionId?: string): ReturnType<NonNullable<CodexAdapter["getRunPolicyStatus"]>> | undefined;
}

export async function handlePermissionCommand(
  options: PermissionCommandOptions,
  message: ChannelMessage,
  target: ChannelTarget,
  args: string[],
): Promise<void> {
  if (!options.codex.getRunPolicy || !options.codex.setRunPolicy) {
    await options.delivery.sendText(target, "当前 Codex Adapter 不支持运行时切换权限模式。");
    return;
  }
  const binding = options.state.getBinding(message.routeKey);
  const sessionId = binding?.sessionId;
  const rawMode = args[0]?.toLowerCase();
  if (!rawMode) {
    await options.delivery.sendText(target, options.statusText.permissionText(sessionId));
    return;
  }
  if (rawMode === "approval" || rawMode === "approve" || rawMode === "safe" || rawMode === "审批") {
    const policy: CodexRunPolicy = { permissionMode: "approval", sandbox: "workspace-write" };
    options.codex.setRunPolicy(policy, sessionId);
    if (sessionId) options.state.setSessionRunPolicy(sessionId, policy);
    const policyStatus = options.runPolicyStatus(sessionId);
    await options.delivery.sendText(target, [
      "已切换 Codex 权限模式: approval",
      sessionId ? `作用范围: 当前会话 \`${sessionId}\`` : "作用范围: 默认策略（后续新会话）",
      "后续任务将使用 workspace-write sandbox。",
      policyStatus && !policyStatus.interactiveApprovals
        ? "注意：当前 Codex Adapter 不支持交互审批；真实生效的 approval_policy 仍是 never。"
        : "后续审批请求会交给当前 Adapter 处理。",
      policyStatus?.note ? `说明: ${policyStatus.note}` : undefined,
      options.routeQueue.hasWorker(message.routeKey) ? "当前正在运行的任务不会被改写；需要立即生效请先 /stop。" : undefined,
    ].filter(Boolean).join("\n"));
    return;
  }
  if (rawMode === "approve-for-me" || rawMode === "auto" || rawMode === "自动审批") {
    const policyStatus = options.runPolicyStatus(sessionId);
    if (policyStatus?.supportedPermissionModes && !policyStatus.supportedPermissionModes.includes("approve-for-me")) {
      await options.delivery.sendText(target, "当前 Codex Adapter 不支持 Approve for me。请继续使用 /permission approval 或 /permission full confirm。");
      return;
    }
    if (!isConfirmed(args.slice(1))) {
      await options.delivery.sendText(target, [
        "Approve for me 会让 Codex 自动审阅审批请求，只在自动审阅认为需要时再阻断。",
        "它不是完全权限，但会减少你手动确认的机会。",
        "",
        "确认切换请发送:",
        "/permission approve-for-me confirm",
      ].join("\n"));
      return;
    }
    const policy: CodexRunPolicy = { permissionMode: "approve-for-me", sandbox: "workspace-write" };
    options.codex.setRunPolicy(policy, sessionId);
    if (sessionId) options.state.setSessionRunPolicy(sessionId, policy);
    await options.delivery.sendText(target, [
      "已切换 Codex 权限模式: approve-for-me",
      sessionId ? `作用范围: 当前会话 \`${sessionId}\`` : "作用范围: 默认策略（后续新会话）",
      "后续审批请求将交给 Codex 自动审阅；这不是完全权限，仍使用 workspace-write sandbox。",
      options.routeQueue.hasWorker(message.routeKey) ? "当前正在运行的任务不会被改写；需要立即生效请先 /stop。" : undefined,
    ].filter(Boolean).join("\n"));
    return;
  }
  if (rawMode === "full" || rawMode === "danger" || rawMode === "完全权限") {
    if (!isConfirmed(args.slice(1))) {
      await options.delivery.sendText(target, [
        "完全权限会跳过审批和沙箱，Codex 可以直接执行命令并修改文件，风险很高。",
        "确认切换请发送:",
        "/permission full confirm",
      ].join("\n"));
      return;
    }
    const policy: CodexRunPolicy = { permissionMode: "full" };
    options.codex.setRunPolicy(policy, sessionId);
    if (sessionId) options.state.setSessionRunPolicy(sessionId, policy);
    await options.delivery.sendText(target, [
      "已切换 Codex 权限模式: full",
      sessionId ? `作用范围: 当前会话 \`${sessionId}\`` : "作用范围: 默认策略（后续新会话）",
      "后续任务将跳过审批和沙箱。建议完成高权限任务后发送 /permission approval 切回安全沙箱模式。",
      options.routeQueue.hasWorker(message.routeKey) ? "当前正在运行的任务不会被改写；需要立即生效请先 /stop。" : undefined,
    ].filter(Boolean).join("\n"));
    return;
  }
  await options.delivery.sendText(target, "未知权限模式。可用命令: /permission、/permission approval、/permission approve-for-me confirm、/permission full confirm。");
}
