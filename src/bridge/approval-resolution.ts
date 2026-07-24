import type { ApprovalManager } from "../approvals/approval-manager.js";
import type { ApprovalDecision, PendingApproval } from "../approvals/types.js";
import type { CodexAdapter } from "../codex/types.js";
import { formatApprovalDecision } from "./formatters.js";

export interface ApprovalResolutionOptions {
  approvals: ApprovalManager;
  codex: CodexAdapter;
}

export type ApprovalResolutionResult =
  | {
    ok: true;
    text: string;
    pending: PendingApproval;
    decision: ApprovalDecision;
  }
  | {
    ok: false;
    text: string;
  };

export async function resolveApproval(
  options: ApprovalResolutionOptions,
  input: {
    approvalKey: string;
    routeKey: string;
    decision: ApprovalDecision;
  },
): Promise<ApprovalResolutionResult> {
  try {
    const pending = options.approvals.decide(input.approvalKey, input.routeKey, input.decision);
    await options.codex.resolveApproval?.(pending.adapterApprovalId ?? pending.approvalKey, input.decision);
    return {
      ok: true,
      text: `审批已处理: ${formatApprovalDecision(input.decision)}`,
      pending,
      decision: input.decision,
    };
  } catch (error) {
    return {
      ok: false,
      text: error instanceof Error ? error.message : String(error),
    };
  }
}
