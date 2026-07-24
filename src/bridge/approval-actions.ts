import type { ApprovalManager } from "../approvals/approval-manager.js";
import type { CodexAdapter } from "../codex/types.js";
import type { ChannelApprovalAction, ChannelApprovalActionResult } from "../protocol/channel.js";
import { resolveApproval } from "./approval-resolution.js";

export interface BridgeApprovalActionOptions {
  approvals: ApprovalManager;
  codex: CodexAdapter;
}

export async function handleChannelApprovalAction(
  options: BridgeApprovalActionOptions,
  action: ChannelApprovalAction,
): Promise<ChannelApprovalActionResult> {
  const { message } = action;
  if (message.conversation.kind !== "direct") {
    return { status: "rejected", text: "审批卡片目前仅支持私聊。" };
  }
  const pending = options.approvals.get(action.approvalKey);
  if (!pending || pending.status !== "pending") {
    return { status: "rejected", text: "该审批已处理或不可用。" };
  }
  if (pending.routeKey !== message.routeKey) {
    return { status: "rejected", text: "该审批不属于当前聊天。" };
  }
  if (pending.requestedBy !== message.sender.id) {
    return { status: "rejected", text: "只有发起该审批的用户可以处理。" };
  }
  if (pending.availableDecisions && !pending.availableDecisions.includes(action.decision)) {
    return { status: "rejected", text: "该审批不支持此处理方式。" };
  }
  const result = await resolveApproval(options, {
    approvalKey: action.approvalKey,
    routeKey: message.routeKey,
    decision: action.decision,
  });
  if (!result.ok) {
    return { status: "rejected", text: "该审批已处理或不可用。" };
  }
  return {
    status: "resolved",
    text: result.text,
    decision: action.decision,
  };
}
