import test from "node:test";
import assert from "node:assert/strict";
import {
  FEISHU_APPROVAL_CARD_ACTION,
  buildFeishuApprovalCard,
  feishuApprovalCardCallback,
  parseFeishuApprovalCardAction,
} from "../../src/channels/feishu/feishu-approval-card.js";
import type { ChannelApprovalRequest } from "../../src/protocol/channel.js";
import { sampleFeishuCardActionEvent } from "../helpers/feishu-fakes.js";

function approvalRequest(): ChannelApprovalRequest {
  return {
    approvalKey: "a001",
    routeKey: "feishu:work:direct:oc_user",
    requestedBy: "ou_user",
    kind: "command",
    sessionId: "session-1234567890",
    turnId: "turn-1234567890",
    itemId: "item-1",
    command: "npm test",
    cwd: "/workspace/project",
    reason: "运行测试",
    risk: "low",
    availableDecisions: ["approve", "approve-session", "deny"],
  };
}

test("Feishu approval card presents only supported decisions with stable action values", () => {
  const card = buildFeishuApprovalCard(approvalRequest()) as {
    elements: Array<Record<string, unknown>>;
  };
  const actionElement = card.elements.find((element) => element.tag === "action") as {
    actions: Array<{ text: { content: string }; value: Record<string, unknown> }>;
  };

  assert.deepEqual(actionElement.actions.map((action) => action.text.content), ["通过一次", "本会话通过", "拒绝"]);
  assert.deepEqual(actionElement.actions.map((action) => action.value), [
    { action: FEISHU_APPROVAL_CARD_ACTION, approvalKey: "a001", decision: "approve" },
    { action: FEISHU_APPROVAL_CARD_ACTION, approvalKey: "a001", decision: "approve-session" },
    { action: FEISHU_APPROVAL_CARD_ACTION, approvalKey: "a001", decision: "deny" },
  ]);
});

test("Feishu approval action parser accepts context ids and user_id fallback", () => {
  const action = parseFeishuApprovalCardAction(sampleFeishuCardActionEvent({
    operator: { open_id: undefined, user_id: "user_123", name: "测试用户" },
    action: {
      value: JSON.stringify({
        action: FEISHU_APPROVAL_CARD_ACTION,
        approvalKey: "a002",
        decision: "approve-session",
      }),
    },
  }), "cli_1234567890abcdef");

  assert.deepEqual(action, {
    messageId: "om_reply",
    chatId: "oc_direct",
    operatorId: "user_123",
    operatorName: "测试用户",
    approvalKey: "a002",
    decision: "approve-session",
  });
});

test("Feishu approval action parser rejects foreign apps and malformed decisions", () => {
  assert.equal(parseFeishuApprovalCardAction(sampleFeishuCardActionEvent({
    app_id: "cli_other",
  }), "cli_1234567890abcdef"), undefined);
  assert.equal(parseFeishuApprovalCardAction(sampleFeishuCardActionEvent({
    action: {
      value: {
        action: FEISHU_APPROVAL_CARD_ACTION,
        approvalKey: "a001",
        decision: "cancel",
      },
    },
  })), undefined);
});

test("Feishu approval callback replaces a resolved card and keeps rejected cards actionable", () => {
  const resolved = feishuApprovalCardCallback(approvalRequest(), {
    status: "resolved",
    text: "审批已处理: 已通过",
    decision: "approve",
  });
  const rejected = feishuApprovalCardCallback(approvalRequest(), {
    status: "rejected",
    text: "该审批已处理或不可用。",
  });

  assert.equal(resolved.toast.type, "success");
  assert.equal(resolved.card?.type, "raw");
  assert.equal(rejected.toast.type, "warning");
  assert.equal(rejected.card, undefined);
});
