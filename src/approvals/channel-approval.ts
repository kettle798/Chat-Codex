import type { PendingApproval } from "./types.js";
import type { ChannelApprovalDecision, ChannelApprovalRequest } from "../protocol/channel.js";
import { isChannelApprovalDecision } from "../protocol/channel.js";

const DEFAULT_CHANNEL_APPROVAL_DECISIONS: ChannelApprovalDecision[] = [
  "approve",
  "approve-session",
  "deny",
];

export function channelApprovalRequestFromPending(pending: PendingApproval): ChannelApprovalRequest {
  const availableDecisions = pending.availableDecisions
    ? pending.availableDecisions.filter(isChannelApprovalDecision)
    : [...DEFAULT_CHANNEL_APPROVAL_DECISIONS];
  return {
    approvalKey: pending.approvalKey,
    routeKey: pending.routeKey,
    requestedBy: pending.requestedBy,
    kind: pending.kind,
    sessionId: pending.sessionId,
    turnId: pending.turnId,
    itemId: pending.itemId,
    command: pending.command,
    cwd: pending.cwd,
    reason: pending.reason,
    risk: pending.risk,
    availableDecisions,
  };
}
