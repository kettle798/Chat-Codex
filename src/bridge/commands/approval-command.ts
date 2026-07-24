import type { ApprovalDecision } from "../../approvals/types.js";
import type { ApprovalManager } from "../../approvals/approval-manager.js";
import type { CodexAdapter } from "../../codex/types.js";
import type { ChannelMessage, ChannelTarget } from "../../protocol/channel.js";
import type { BridgeDelivery } from "../delivery.js";
import { resolveApproval } from "../approval-resolution.js";

export interface ApprovalCommandOptions {
  approvals: ApprovalManager;
  codex: CodexAdapter;
  delivery: BridgeDelivery;
}

export async function handleApprovalCommand(
  options: ApprovalCommandOptions,
  message: ChannelMessage,
  target: ChannelTarget,
  args: string[],
  decision: ApprovalDecision,
): Promise<void> {
  const parsed = parseApprovalArgs(options.approvals, message.routeKey, args);
  const key = parsed.approvalKey ?? options.approvals.latest(message.routeKey)?.approvalKey;
  if (!key) {
    await options.delivery.sendText(target, "当前没有待处理审批。");
    return;
  }
  const result = await resolveApproval(options, {
    approvalKey: key,
    routeKey: message.routeKey,
    decision,
  });
  await options.delivery.sendText(target, result.text);
}

function parseApprovalArgs(approvals: ApprovalManager, routeKey: string, args: string[]): {
  approvalKey?: string;
} {
  if (args.length === 0) return {};
  const [first = ""] = args;
  const knownApproval = approvals.get(first);
  if (knownApproval?.routeKey === routeKey) {
    return { approvalKey: first };
  }
  return { approvalKey: first };
}
