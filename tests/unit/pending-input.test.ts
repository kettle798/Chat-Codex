import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";
import { BridgeDelivery } from "../../src/bridge/delivery.js";
import { BridgePendingInputManager } from "../../src/bridge/pending-input.js";
import { MockCodexAdapter } from "../../src/codex/mock-codex-adapter.js";
import type { CodexUserInputRequest, CodexUserInputResponse } from "../../src/codex/types.js";
import { SilentLogger } from "../../src/logging/logger.js";
import type { ChannelRegistry } from "../../src/channels/registry.js";
import type { ChannelMessage, ChannelTarget } from "../../src/protocol/channel.js";

test("BridgePendingInputManager clears only requests from the failed turn", async () => {
  const codex = new InputCapableCodexAdapter();
  const manager = new BridgePendingInputManager({
    codex,
    delivery: delivery(),
  });

  await manager.start(startInput("route-a", "session-a", "turn-a", "input-a-1"));
  await manager.start(startInput("route-a", "session-a", "turn-a", "input-a-2"));
  await manager.start(startInput("route-b", "session-b", "turn-b", "input-b-1"));

  assert.equal(manager.clearTurn("route-a", "session-a", "other-turn"), 0);
  assert.equal(manager.has("route-a"), true);
  assert.equal(manager.clearTurn("route-a", "session-a", "turn-a"), 2);
  assert.equal(manager.has("route-a"), false);
  assert.equal(manager.has("route-b"), true);

  assert.equal(manager.clearTurn("route-b", "session-b", "turn-b"), 1);
  assert.equal(manager.has("route-b"), false);
  manager.clearAll();
});

class InputCapableCodexAdapter extends MockCodexAdapter {
  async resolveUserInput(_requestId: string, _response: CodexUserInputResponse): Promise<void> {}
}

function delivery(): BridgeDelivery {
  const approvals = new ApprovalManager();
  return new BridgeDelivery({
    channels: {
      sendText: async () => ({ channelId: "mock", messageId: "mock-message", deliveredAt: new Date().toISOString() }),
    } as unknown as ChannelRegistry,
    approvals,
    logger: new SilentLogger(),
    approvalSendRetryDelayMs: 1,
  });
}

function startInput(routeKey: string, sessionId: string, turnId: string, adapterRequestId: string) {
  const target: ChannelTarget = {
    channelId: "mock",
    routeKey,
    conversation: { id: routeKey, kind: "direct" },
    recipient: { id: "user" },
  };
  const message: ChannelMessage = {
    id: `message-${adapterRequestId}`,
    routeKey,
    channelId: "mock",
    sender: { id: "user" },
    conversation: target.conversation,
    timestamp: new Date().toISOString(),
  };
  const request: CodexUserInputRequest = {
    adapterRequestId,
    sessionId,
    turnId,
    itemId: `item-${adapterRequestId}`,
    questions: [{
      id: "choice",
      question: "Continue?",
      isOther: false,
      isSecret: false,
      options: [{ label: "Yes" }],
    }],
  };
  return { routeKey, target, message, request };
}
