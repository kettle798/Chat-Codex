import type {
  ChannelApprovalActionResult,
  ChannelApprovalDecision,
  ChannelApprovalRequest,
} from "../../protocol/channel.js";
import { isChannelApprovalDecision } from "../../protocol/channel.js";
import type { FeishuCardActionTriggerEvent } from "./feishu-types.js";

export const FEISHU_APPROVAL_CARD_ACTION = "chat_codex_approval";

export interface FeishuApprovalCardAction {
  messageId: string;
  chatId: string;
  operatorId: string;
  operatorName?: string;
  approvalKey: string;
  decision: ChannelApprovalDecision;
}

export interface FeishuApprovalCardCallback {
  toast: {
    type: "success" | "warning" | "error" | "info";
    content: string;
  };
  card?: {
    type: "raw";
    data: Record<string, unknown>;
  };
}

export function buildFeishuApprovalCard(request: ChannelApprovalRequest): Record<string, unknown> {
  const actions = request.availableDecisions.map((decision) => approvalButton(request.approvalKey, decision));
  if (actions.length === 0) {
    throw new Error("飞书审批卡片没有可用处理方式");
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "Codex 请求审批" },
      template: approvalRiskTemplate(request.risk),
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: approvalCardBody(request),
        },
      },
      {
        tag: "action",
        actions,
      },
      {
        tag: "note",
        elements: [{
          tag: "plain_text",
          content: "也可直接发送 /OK、/P 或 /NO。",
        }],
      },
    ],
  };
}

export function parseFeishuApprovalCardAction(
  event: FeishuCardActionTriggerEvent,
  expectedAppId?: string,
): FeishuApprovalCardAction | undefined {
  if (expectedAppId && event.app_id && event.app_id !== expectedAppId) return undefined;
  const action = objectValue(event.action);
  const value = actionValue(action?.value);
  if (!value || stringValue(value.action) !== FEISHU_APPROVAL_CARD_ACTION) return undefined;
  const approvalKey = stringValue(value.approvalKey);
  const decision = stringValue(value.decision);
  const messageId = firstString(event.context?.open_message_id, event.open_message_id);
  const chatId = firstString(event.context?.open_chat_id, event.open_chat_id);
  const operatorId = firstString(event.operator?.open_id, event.operator?.user_id);
  if (!approvalKey || !isChannelApprovalDecision(decision) || !messageId || !chatId || !operatorId) return undefined;
  return {
    messageId,
    chatId,
    operatorId,
    operatorName: stringValue(event.operator?.name),
    approvalKey,
    decision,
  };
}

export function feishuApprovalCardCallback(
  request: ChannelApprovalRequest,
  result: ChannelApprovalActionResult,
): FeishuApprovalCardCallback {
  if (result.status === "rejected") {
    return {
      toast: {
        type: "warning",
        content: truncateForToast(result.text),
      },
    };
  }
  return {
    toast: {
      type: "success",
      content: truncateForToast(result.text),
    },
    card: {
      type: "raw",
      data: buildFeishuApprovalResultCard(request, result),
    },
  };
}

export function buildFeishuApprovalResultCard(
  request: ChannelApprovalRequest,
  result: Extract<ChannelApprovalActionResult, { status: "resolved" }>,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: approvalResultTitle(result.decision) },
      template: approvalDecisionTemplate(result.decision),
    },
    elements: [{
      tag: "div",
      text: {
        tag: "plain_text",
        content: approvalResultBody(request, result),
      },
    }],
  };
}

function approvalButton(approvalKey: string, decision: ChannelApprovalDecision): Record<string, unknown> {
  const presentation = approvalDecisionPresentation(decision);
  return {
    tag: "button",
    text: { tag: "plain_text", content: presentation.label },
    type: presentation.type,
    name: FEISHU_APPROVAL_CARD_ACTION,
    value: {
      action: FEISHU_APPROVAL_CARD_ACTION,
      approvalKey,
      decision,
    },
  };
}

function approvalCardBody(request: ChannelApprovalRequest): string {
  const lines = [
    requiredApprovalLine("类型", request.kind),
    requiredApprovalLine("会话", shortId(request.sessionId)),
    requiredApprovalLine("Turn", shortId(request.turnId)),
    optionalApprovalLine("CWD", request.cwd),
    optionalApprovalLine("命令", request.command),
    optionalApprovalLine("原因", request.reason),
    optionalApprovalLine("风险", request.risk),
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function approvalResultBody(
  request: ChannelApprovalRequest,
  result: Extract<ChannelApprovalActionResult, { status: "resolved" }>,
): string {
  return [
    normalizedPlainText(result.text) ?? "审批已处理。",
    requiredApprovalLine("类型", request.kind),
    requiredApprovalLine("会话", shortId(request.sessionId)),
  ].join("\n");
}

function approvalDecisionPresentation(decision: ChannelApprovalDecision): {
  label: string;
  type: "primary" | "default" | "danger";
} {
  if (decision === "approve") return { label: "通过一次", type: "primary" };
  if (decision === "approve-session") return { label: "本会话通过", type: "default" };
  return { label: "拒绝", type: "danger" };
}

function approvalResultTitle(decision: ChannelApprovalDecision): string {
  if (decision === "approve") return "Codex 审批已通过";
  if (decision === "approve-session") return "Codex 审批已本会话通过";
  return "Codex 审批已拒绝";
}

function approvalRiskTemplate(risk: ChannelApprovalRequest["risk"]): string {
  if (risk === "high") return "red";
  if (risk === "medium") return "orange";
  return "blue";
}

function approvalDecisionTemplate(decision: ChannelApprovalDecision): string {
  return decision === "deny" ? "red" : "green";
}

function actionValue(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim().startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => Boolean(value?.trim()));
}

function requiredApprovalLine(label: string, value: string): string {
  return `${label}：${normalizedPlainText(value) ?? "未提供"}`;
}

function optionalApprovalLine(label: string, value: string | undefined): string | undefined {
  const text = normalizedPlainText(value);
  return text ? `${label}：${text}` : undefined;
}

function normalizedPlainText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\r?\n/g, " ").trim();
  return normalized || undefined;
}

function shortId(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12);
}

function truncateForToast(value: string): string {
  return value.length <= 100 ? value : `${value.slice(0, 97)}...`;
}
