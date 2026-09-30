import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalManager } from "../../src/approvals/approval-manager.js";

test("ApprovalManager creates and resolves approvals", () => {
  const manager = new ApprovalManager();
  const pending = manager.create("mock:default:direct:user", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
    command: "echo ok",
  });

  assert.equal(pending.status, "pending");
  assert.equal(pending.expiresAt, undefined);
  assert.match(manager.formatForChannel(pending), /\/OK/);
  assert.match(manager.formatForChannel(pending), /\/P 本会话通过/);
  assert.match(manager.formatForChannel(pending), /\/NO 拒绝当前审批/);
  assert.doesNotMatch(manager.formatForChannel(pending), new RegExp(pending.approvalKey));
  assert.doesNotMatch(manager.formatForChannel(pending), /\/approve/);
  assert.equal(manager.latest(pending.routeKey)?.approvalKey, pending.approvalKey);

  const resolved = manager.decide(pending.approvalKey, pending.routeKey, "approve");
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.decision, "approve");
});

test("ApprovalManager keeps every character of a multiline command visible in the approval prompt", () => {
  const manager = new ApprovalManager();
  const pending = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
    command: "printf 'first\\nsecond'\nrm -rf /tmp/example",
    environmentId: "remote",
    reason: "需要运行两步检查",
  });

  const text = manager.formatForChannel(pending);
  assert.match(text, /执行环境: remote/);
  assert.match(text, /原因: 需要运行两步检查/);
  assert.match(text, /将执行的命令:/);
  assert.match(text, /printf 'first\\nsecond'\\nrm -rf \/tmp\/example/);
});

test("ApprovalManager only expires approvals when ttl is configured", () => {
  const manager = new ApprovalManager({ ttlMs: -1 });
  const pending = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });

  assert.equal(manager.latest("route-a"), undefined);
  assert.equal(manager.get(pending.approvalKey)?.status, "expired");
});

test("ApprovalManager latest returns the newest pending approval for a route", () => {
  const manager = new ApprovalManager({ ttlMs: 60_000 });
  const first = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });
  const second = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i2",
  });
  manager.create("route-b", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i3",
  });

  assert.notEqual(first.approvalKey, second.approvalKey);
  assert.equal(manager.latest("route-a")?.approvalKey, second.approvalKey);
});

test("ApprovalManager rejects wrong route decisions", () => {
  const manager = new ApprovalManager({ ttlMs: 60_000 });
  const pending = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });

  assert.throws(() => manager.decide(pending.approvalKey, "route-b", "deny"), /不属于当前会话/);
});

test("ApprovalManager cancels pending approvals for a route", () => {
  const manager = new ApprovalManager({ ttlMs: 60_000 });
  const first = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });
  manager.create("route-b", "user", {
    kind: "command",
    sessionId: "s2",
    turnId: "t2",
    itemId: "i2",
  });

  const cancelled = manager.cancelRoute("route-a", "任务已停止");

  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].approvalKey, first.approvalKey);
  assert.equal(cancelled[0].decision, "cancel");
  assert.equal(cancelled[0].decisionReason, "任务已停止");
  assert.equal(manager.list("route-a").length, 0);
  assert.equal(manager.list("route-b").length, 1);
});

test("ApprovalManager cancels only approvals from a failed turn", () => {
  const manager = new ApprovalManager();
  const failedTurn = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });
  const activeTurn = manager.create("route-a", "user", {
    kind: "command",
    sessionId: "s1",
    turnId: "t2",
    itemId: "i2",
  });

  const cancelled = manager.cancelTurn("route-a", "s1", "t1", "transport failed");

  assert.deepEqual(cancelled.map((pending) => pending.approvalKey), [failedTurn.approvalKey]);
  assert.equal(manager.get(failedTurn.approvalKey)?.status, "resolved");
  assert.equal(manager.get(failedTurn.approvalKey)?.decision, "cancel");
  assert.equal(manager.get(activeTurn.approvalKey)?.status, "pending");
});

test("ApprovalManager resolves pending approvals by adapter request id", () => {
  const manager = new ApprovalManager({ ttlMs: 60_000 });
  const pending = manager.create("route-a", "user", {
    kind: "command",
    adapterApprovalId: "server-request-1",
    sessionId: "s1",
    turnId: "t1",
    itemId: "i1",
  });
  manager.create("route-b", "user", {
    kind: "command",
    adapterApprovalId: "server-request-1",
    sessionId: "s2",
    turnId: "t2",
    itemId: "i2",
  });

  const resolved = manager.resolveAdapterApproval("route-a", "server-request-1", "already resolved by app-server");

  assert.equal(resolved?.approvalKey, pending.approvalKey);
  assert.equal(resolved?.status, "resolved");
  assert.equal(resolved?.decisionReason, "already resolved by app-server");
  assert.equal(manager.list("route-a").length, 0);
  assert.equal(manager.list("route-b").length, 1);
});

test("ApprovalManager renders terminal input approvals with the same terminal-and-input semantics as Codex", () => {
  const manager = new ApprovalManager();
  const pending = manager.create("route-a", "user", {
    kind: "terminal_input",
    sessionId: "s1",
    turnId: "t1",
    itemId: "command-item-1",
    command: "write_stdin --session-id 42 confirm\n",
    environmentId: "remote",
    reason: "程序正在等待确认",
    terminalId: "42",
    terminalInput: "confirm\n\t\u0000",
    availableDecisions: ["approve", "cancel"],
  });

  const text = manager.formatForChannel(pending);
  assert.match(text, /Codex 请求终端输入审批/);
  assert.match(text, /不会启动新命令/);
  assert.match(text, /执行环境: remote/);
  assert.match(text, /原因: 程序正在等待确认/);
  assert.match(text, /目标终端: 42/);
  assert.match(text, /输入: "confirm\\n\\t\\u0000"/);
  assert.doesNotMatch(text, /write_stdin/);
  assert.match(text, /\/OK 本次允许向终端输入/);
  assert.match(text, /\/NO 取消输入并中止当前任务/);
  assert.doesNotMatch(text, /\/P/);
  assert.throws(() => manager.decide(pending.approvalKey, pending.routeKey, "approve-session"), /不支持/);
  assert.equal(manager.get(pending.approvalKey)?.status, "pending");
});
