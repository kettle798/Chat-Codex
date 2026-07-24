import type {
  ChannelApprovalAction,
  ChannelApprovalActionHandler,
  ChannelApprovalRequest,
  ChannelMessage,
  ChannelTarget,
  SendResult,
} from "../../protocol/channel.js";
import {
  buildFeishuApprovalCard,
  feishuApprovalCardCallback,
  parseFeishuApprovalCardAction,
} from "./feishu-approval-card.js";
import type { FeishuCardActionTriggerEvent } from "./feishu-types.js";

export interface FeishuApprovalCardControllerOptions {
  channelId: string;
  accountId: string;
  expectedAppId?: string;
  dedupTtlMs: number;
  now: () => number;
  sendInteractiveCard(target: ChannelTarget, content: string): Promise<SendResult>;
}

export type FeishuApprovalCardHandleResult =
  | {
    type: "handled";
    message: ChannelMessage;
    response: unknown;
  }
  | {
    type: "skipped";
    reason: string;
    response?: unknown;
  };

export class FeishuApprovalCardController {
  private readonly channelId: string;
  private readonly accountId: string;
  private readonly expectedAppId?: string;
  private readonly dedupTtlMs: number;
  private readonly now: () => number;
  private readonly sendInteractiveCard: FeishuApprovalCardControllerOptions["sendInteractiveCard"];
  private readonly cards = new Map<string, {
    target: ChannelTarget;
    request: ChannelApprovalRequest;
  }>();
  private readonly seenActions = new Map<string, number>();
  private handler?: ChannelApprovalActionHandler;

  constructor(options: FeishuApprovalCardControllerOptions) {
    this.channelId = options.channelId;
    this.accountId = options.accountId;
    this.expectedAppId = options.expectedAppId;
    this.dedupTtlMs = options.dedupTtlMs;
    this.now = options.now;
    this.sendInteractiveCard = options.sendInteractiveCard;
  }

  onApprovalAction(handler: ChannelApprovalActionHandler): void {
    this.handler = handler;
  }

  clear(): void {
    this.cards.clear();
    this.seenActions.clear();
  }

  async send(target: ChannelTarget, approval: ChannelApprovalRequest): Promise<SendResult> {
    if (target.conversation.kind !== "direct") {
      throw new Error("飞书审批卡片目前仅支持私聊");
    }
    const result = await this.sendInteractiveCard(target, JSON.stringify(buildFeishuApprovalCard(approval)));
    this.cards.set(result.messageId, { target, request: approval });
    return result;
  }

  async handle(event: FeishuCardActionTriggerEvent): Promise<FeishuApprovalCardHandleResult> {
    const action = parseFeishuApprovalCardAction(event, this.expectedAppId);
    if (!action) return { type: "skipped", reason: "invalid_approval_card_action" };
    const card = this.cards.get(action.messageId);
    if (!card) {
      return {
        type: "skipped",
        reason: "unknown_approval_card",
        response: approvalCardToast("info", "该审批已处理或不可用。"),
      };
    }
    if (card.target.conversation.kind !== "direct" || card.target.conversation.id !== action.chatId) {
      return {
        type: "skipped",
        reason: "approval_card_chat_mismatch",
        response: approvalCardToast("warning", "该审批不属于当前聊天。"),
      };
    }
    if (card.request.approvalKey !== action.approvalKey || !card.request.availableDecisions.includes(action.decision)) {
      return {
        type: "skipped",
        reason: "approval_card_payload_mismatch",
        response: approvalCardToast("warning", "该审批动作无效。"),
      };
    }
    if (card.target.recipient.id !== action.operatorId) {
      return {
        type: "skipped",
        reason: "approval_card_sender_mismatch",
        response: approvalCardToast("warning", "只有发起该审批的用户可以处理。"),
      };
    }
    const actionKey = `${action.messageId}:${action.operatorId}:${action.approvalKey}:${action.decision}`;
    if (!this.recordAction(actionKey)) {
      return {
        type: "skipped",
        reason: "duplicate_approval_card_action",
        response: approvalCardToast("info", "该审批动作已提交，请等待处理。"),
      };
    }
    if (!this.handler) {
      return {
        type: "skipped",
        reason: "approval_action_handler_missing",
        response: approvalCardToast("error", "审批处理服务尚未启动。"),
      };
    }
    const message: ChannelMessage = {
      id: action.messageId,
      routeKey: card.target.routeKey,
      channelId: this.channelId,
      accountId: card.target.accountId ?? this.accountId,
      sender: {
        id: action.operatorId,
        ...(action.operatorName ? { displayName: action.operatorName } : {}),
      },
      conversation: card.target.conversation,
      timestamp: new Date(this.now()).toISOString(),
      raw: event,
    };
    try {
      const result = await this.handler({
        approvalKey: action.approvalKey,
        decision: action.decision,
        message,
      } satisfies ChannelApprovalAction);
      if (result.status === "resolved") this.cards.delete(action.messageId);
      return {
        type: "handled",
        message,
        response: feishuApprovalCardCallback(card.request, result),
      };
    } catch {
      // Do not turn a transient Bridge/Codex failure into a permanently ignored click.
      this.seenActions.delete(actionKey);
      return {
        type: "handled",
        message,
        response: approvalCardToast("error", "审批处理失败，请发送 /OK、/P 或 /NO 重试。"),
      };
    }
  }

  private recordAction(actionKey: string): boolean {
    const now = this.now();
    for (const [key, expiresAt] of this.seenActions) {
      if (expiresAt <= now) this.seenActions.delete(key);
    }
    if (this.seenActions.has(actionKey)) return false;
    this.seenActions.set(actionKey, now + this.dedupTtlMs);
    return true;
  }
}

function approvalCardToast(
  type: "success" | "warning" | "error" | "info",
  content: string,
): { toast: { type: "success" | "warning" | "error" | "info"; content: string } } {
  return { toast: { type, content } };
}
