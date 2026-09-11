import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addLocalAgent } from "../src/application/agent/control.js";
import { postLocalChatMessage } from "../src/application/chat/control.js";
import { eventTrace } from "../src/application/event/query.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { DeliveryHandler } from "../src/core/runtime/handlers.js";
import { resolveCodexChatPush, resolveCodexChatReplyRoute } from "../src/integrations/codex-desktop/chat-destination.js";
import { CodexDesktopDestinationAdapter, type CodexPushRunner } from "../src/integrations/codex-desktop/push.js";

const THREAD = "01a08e63-109a-7452-9d23-f9fa9f236343";
const AT = "2026-09-11T04:00:00.000Z";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rs-desktop-delivery-"));
  const options = { runtimeDirectory: root, now: () => new Date(AT) };
  const agent = addLocalAgent(root, "alice", "codex", options);
  addLocalAgent(root, "bob", "codex", options);
  const source = postLocalChatMessage(root, "@alice desktop reply", options, { codexThreadId: THREAD }).message;
  const store = new RuntimeStore(join(root, "runtime.db"));
  const execution = store.claimDueExecutions(1, AT)[0]!;
  const [dispatch] = store.admitChatAttention(execution.executionId, [{
    plan: { agentId: agent.principalId, handle: agent.handle, outcome: "dispatch", reason: "available",
      presenceSnapshot: { global: { scope: "global", mode: "available", wakeKeywords: [] },
        topic: { scope: "topic", mode: "available", wakeKeywords: [] } } },
    prompt: "reply with a marker"
  }], AT);
  const route = resolveCodexChatReplyRoute(store, dispatch!);
  assert.ok(route?.delivery);
  function complete(action: "reply" | "silent" = "reply") {
    const work = store.claimDueExecutions(1, AT)[0]!;
    return store.completeExecution(work.executionId, {
      adapterId: "fake", workspace: join(root, "workspace"), providerSessionId: "desktop-fixture",
      chatDecision: { schema: "ChatDecision@1",
        speech: action === "reply" ? { action, body: "RS_NATIVE_FIXTURE" } : { action, reason: "not needed" },
        presence: { scope: "global", mode: "available", wakeKeywords: [] } },
      chatReplyRoute: route!
    }, AT);
  }
  return { root, options, agent, source, store, dispatch: dispatch!, route, complete,
    close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("Owner-bound Chat reply atomically creates one Delivery and preserves exact Desktop receipt", async () => {
  const f = fixture();
  try {
    assert.equal(f.source.destinationIds.length, 1);
    const reply = f.complete();
    assert.equal(reply?.type, "chat.message");
    const [delivery] = f.store.claimDueDeliveries(10, AT);
    assert.ok(delivery);
    assert.equal(delivery.maxAttempts, 1);
    const calls: Array<{ thread: string; message: string }> = [];
    const adapter = new CodexDesktopDestinationAdapter(input => resolveCodexChatPush(f.store, input), async (thread, message) => {
      calls.push({ thread, message });
      return JSON.stringify({ schema: "CodexPushReceipt@1", threadId: thread, status: "accepted",
        messageId: "message-1", ownerClientId: "desktop-owner", turnId: "turn-1" });
    });
    const handler = new DeliveryHandler({ store: f.store, adapters: new Map([[adapter.kind, adapter]]) });
    const destination = f.store.destination(delivery.destinationId)!;
    await assert.rejects(adapter.deliver({ delivery, destination: {
      ...destination, address: { ...destination.address, threadId: "01a08e00-2fd3-7e93-a88b-6720c7d76e56" }
    } }), /immutable Owner binding/);
    await assert.rejects(adapter.deliver({ delivery: { ...delivery, payload: { body: "forged reply" } }, destination }), /identity mismatch/);
    assert.equal(calls.length, 0);
    const result = await handler.handle(delivery, AT);
    assert.equal(result.status, "delivered");
    const trace = eventTrace(f.root, reply!.eventId, f.root);
    assert.equal(trace.deliveries[0]?.delivery.source, "chat.message");
    assert.equal(trace.deliveries[0]?.delivery.receipt, result.receipt);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.thread, THREAD);
    const source = JSON.parse(result.receipt!).source;
    assert.equal(source.eventId, reply?.eventId);
    assert.equal(source.requestEventId, f.source.eventId);
    assert.equal(source.agentId, f.agent.principalId);
    assert.ok(calls[0]?.message.includes("RS_NATIVE_FIXTURE"));
    assert.deepEqual(f.store.claimDueDeliveries(10, AT), []);
  } finally { f.close(); }
});

test("unbound/multi-Agent requests and nonmatching dispatches cannot select a Desktop task", () => {
  const f = fixture();
  try {
    for (const body of ["no mention", "@alice @bob both"]) {
      assert.throws(() => postLocalChatMessage(f.root, body, f.options, { codexThreadId: THREAD }), /exactly one/);
    }
    assert.throws(() => postLocalChatMessage(f.root, "@alice hi", f.options, { codexThreadId: "recent" }), /UUID/);
    assert.throws(() => resolveCodexChatReplyRoute(f.store, { ...f.dispatch, agentId: "different-agent" }), /binding/);
    const unbound = postLocalChatMessage(f.root, "@alice normal", f.options).message;
    assert.deepEqual(unbound.destinationIds, []);
    assert.equal(resolveCodexChatReplyRoute(f.store, { ...f.dispatch, sourceMessageEventId: unbound.eventId }), undefined);
    f.complete("silent");
    assert.deepEqual(f.store.claimDueDeliveries(10, AT), []);
  } finally { f.close(); }
});

for (const status of ["not_sent", "rejected", "unknown", "malformed", "wrong-thread", "interrupted"] as const) {
  test(`Desktop ${status} has no automatic retry or hidden resend`, async () => {
    const f = fixture();
    try {
      f.complete();
      const delivery = f.store.claimDueDeliveries(1, AT)[0]!;
      let calls = 0;
      const push: CodexPushRunner = async thread => {
        calls++;
        if (status === "interrupted") throw new Error("connection lost");
        if (status === "malformed") return "{}";
        return JSON.stringify({ schema: "CodexPushReceipt@1", threadId: status === "wrong-thread" ? "another" : thread, status });
      };
      const adapter = new CodexDesktopDestinationAdapter(input => resolveCodexChatPush(f.store, input), push);
      const handler = new DeliveryHandler({ store: f.store, adapters: new Map([[adapter.kind, adapter]]) });
      const result = await handler.handle(delivery, AT);
      assert.equal(result.status, "failed");
      assert.match(result.lastError!, status === "malformed" || status === "wrong-thread" || status === "interrupted" ? /unknown/ : new RegExp(status));
      assert.deepEqual(f.store.claimDueDeliveries(1, AT), []);
      assert.throws(() => f.store.retryFailedDelivery(delivery.deliveryId, AT), /cannot be retried/);
      assert.equal(f.store.delivery(delivery.deliveryId)?.lastError, result.lastError);
      assert.deepEqual(f.store.claimDueDeliveries(1, AT), []);
      assert.equal(calls, 1);
    } finally { f.close(); }
  });
}

test("Desktop route survives reopen; interrupted Delivery is terminal unknown and not replayed", () => {
  const f = fixture();
  try {
    f.complete();
    const delivery = f.store.claimDueDeliveries(1, AT)[0]!;
    const reopened = new RuntimeStore(join(f.root, "runtime.db"));
    try {
      assert.deepEqual(resolveCodexChatReplyRoute(reopened, f.dispatch), f.route);
      reopened.reconcileInterrupted(AT);
      assert.equal(reopened.delivery(delivery.deliveryId)?.status, "failed");
      assert.equal(reopened.delivery(delivery.deliveryId)?.lastError, "runtime_interrupted_unknown");
      assert.deepEqual(reopened.claimDueDeliveries(1, AT), []);
    } finally { reopened.close(); }
  } finally { f.close(); }
});
