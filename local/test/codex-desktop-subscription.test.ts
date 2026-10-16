import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSubscriptionCommand } from "../src/entrypoints/cli/subscription.js";
import { localId } from "../src/core/id.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { DeliveryHandler } from "../src/core/runtime/handlers.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { bootstrapLocalFoundation } from "../src/infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { SubscriptionStore } from "../src/capabilities/subscription/store.js";
import { ContinuousSubscriptionStore } from "../src/capabilities/subscription/continuous-store.js";
import { SubscriptionRuntime } from "../src/capabilities/subscription/runtime.js";
import { PollProbeExecutor } from "../src/capabilities/subscription/plugin-runner.js";
import { registerDesktopSubscription, desktopSubscriptionDeliveries } from "../src/application/subscription/desktop-control.js";
import { inspectSubscriptionView } from "../src/application/subscription/query.js";
import { DeterministicApplicationActionRegistry } from "../src/application/proactive/action-registry.js";
import { codexDesktopPushAction, codexDesktopActionSource } from "../src/application/proactive/codex-desktop-action.js";
import { CodexDesktopDestinationAdapter } from "../src/integrations/codex-desktop/push.js";

const THREAD = "01a08e63-109a-7452-9d23-f9fa9f236343";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "rs-desktop-subscription-"));
  const paths = runtimePaths(root, root);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths);
  writeFileSync(join(root, "probe.mjs"), `export default {
    kind: "subscription.probe", id: "fixture", schemaVersion: 1,
    plan() { return { kind: "http", url: "https://probe.example/status" }; },
    evaluate(config, result) { const status = JSON.parse(result.body).status;
      return { version: status, occurrenceKey: status, facts: { status }, terminal: status === "done" ? "success" : null }; }
  };`);
  writeFileSync(paths.subscriptionPlugins, JSON.stringify({ schemaVersion: "SubscriptionPluginRegistry@1", plugins: [{
    ref: "plugin:fixture@1", pluginPath: "project:probe.mjs", pluginId: "fixture", workspaceRef: "project:self",
    triggerKinds: ["until", "continuous"], allowedHttpOrigins: ["https://probe.example"], allowedExecutables: []
  }] }));
  const database = openRuntimeDatabase(paths.database);
  const actions = new DeterministicApplicationActionRegistry(database, [codexDesktopPushAction]);
  const oneShot = new SubscriptionStore(database, { migrate: false, applicationActions: actions });
  const continuous = new ContinuousSubscriptionStore(database, { migrate: false, applicationActions: actions });
  const runtime = new RuntimeStore(database, { migrate: false });
  const registration = (mode: "until" | "continuous" = "until") => ({
    schemaVersion: "CodexDesktopSubscriptionRegistration@1", subscriptionId: localId("sub"), mode,
    title: "Wait for fixture", threadId: THREAD, pluginRef: "plugin:fixture@1", pluginConfig: {},
    intervalMilliseconds: 100, ...(mode === "until" ? { maxWaitMilliseconds: 60_000, maxAttempts: 3 } : {})
  });
  return { root, paths, database, actions, oneShot, continuous, runtime, registration,
    close() { database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("Owner CLI registration waits without Agent work, then pushes one canonical observation and survives reopen", async () => {
  const f = setup();
  try {
    const input = f.registration();
    registerDesktopSubscription(f.root, input, f.root);
    registerDesktopSubscription(f.root, input, f.root);
    assert.throws(() => registerDesktopSubscription(f.root, { ...input, threadId: "01a08e00-2fd3-7e93-a88b-6720c7d76e56" }, f.root), /conflict|different|already|changed/i);
    let state = "waiting";
    const poller = new SubscriptionRuntime({ databasePath: f.paths.database, store: f.oneShot,
      probeExecutor: new PollProbeExecutor({ fetch: async () => Response.json({ status: state }) }) });
    const at = new Date().toISOString();
    await poller.runCycle(new AbortController().signal, at);
    assert.equal(f.oneShot.require(input.subscriptionId).status, "active");
    assert.deepEqual(desktopSubscriptionDeliveries(f.root, input.subscriptionId, f.root), []);
    state = "done";
    const later = new Date(Date.parse(at) + 200).toISOString();
    await poller.runCycle(new AbortController().signal, later);
    const view = inspectSubscriptionView(f.root, input.subscriptionId, f.root);
    assert.equal(view.kind, "free");
    assert.ok(view.kind === "free" && view.actionReceipt?.status === "succeeded");
    assert.equal((f.database.prepare("SELECT count(*) AS n FROM executions").get() as { n: number }).n, 0);
    const reopened = openRuntimeDatabase(f.paths.database);
    try {
      const runtime = new RuntimeStore(reopened, { migrate: false });
      const actions = new DeterministicApplicationActionRegistry(reopened, [codexDesktopPushAction]);
      const [delivery] = runtime.claimDueDeliveries(10, later);
      assert.ok(delivery);
      let calls = 0;
      const adapter = new CodexDesktopDestinationAdapter(codexDesktopActionSource(actions, {repoRoot: f.root, runtimeDirectory: f.root}), async (threadId, message) => {
        calls++;
        assert.match(message, /Wait for fixture.*success \/ done/);
        assert.ok(message.includes(delivery.origin.id));
        assert.ok(message.includes(f.root));
        assert.ok(!message.includes("bodySha256"));
        let readback = "";
        assert.equal(runSubscriptionCommand(f.root, ["receipt", delivery.origin.id], {write: text => {readback += text;}}, f.root), 0);
        const data = JSON.parse(readback);
        assert.equal(data.receipt.source.id, input.subscriptionId);
        assert.equal(data.evidence.observation.facts.status, "done");
        return JSON.stringify({ schema: "CodexPushReceipt@1", threadId, status: "accepted", turnId: "turn", ownerClientId: "owner", messageId: "msg" });
      });
      const destination = runtime.destination(delivery.destinationId)!;
      for (const forged of [
        { delivery, destination: { ...destination, address: { threadId: "other" } } },
        { delivery: { ...delivery, payload: { body: "forged" } }, destination },
        { delivery: { ...delivery, origin: { kind: "host" as const, id: "dar1_forged" } }, destination }
      ]) await assert.rejects(adapter.deliver(forged), /canonical/);
      assert.equal(calls, 0);
      const handler = new DeliveryHandler({ store: runtime, adapters: new Map([[adapter.kind, adapter]]) });
      const delivered = await handler.handle(delivery, later);
      assert.equal(delivered.status, "delivered", delivered.lastError);
      assert.equal(desktopSubscriptionDeliveries(f.root, input.subscriptionId, f.root)[0]?.status, "delivered");
      await poller.runCycle(new AbortController().signal, later);
      assert.deepEqual(runtime.claimDueDeliveries(10, later), []);
      assert.equal(calls, 1);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test("continuous checkpoints enqueue once per occurrence; stale observations and cancellation do not replay", () => {
  const f = setup();
  try {
    const input = f.registration("continuous");
    registerDesktopSubscription(f.root, input, f.root);
    const observation = (key: string) => ({ version: key, occurrenceKey: key, facts: { key }, terminal: null });
    for (const key of ["one", "one", "two"]) f.continuous.recordObservation(input.subscriptionId, observation(key));
    const view = inspectSubscriptionView(f.root, input.subscriptionId, f.root);
    assert.ok(view.kind === "continuous" && view.latestActionReceipt?.status === "succeeded");
    assert.equal(desktopSubscriptionDeliveries(f.root, input.subscriptionId, f.root).length, 2);
    f.continuous.setStatus(input.subscriptionId, "cancel");
    assert.throws(() => f.continuous.recordObservation(input.subscriptionId, observation("three")), /not active/);
    assert.equal(desktopSubscriptionDeliveries(f.root, input.subscriptionId, f.root).length, 2);
  } finally { f.close(); }
});

for (const path of ["deadline", "pending-budget", "probe-error"] as const) {
  test(`exhausted ${path} records unknown business result and delivers expiry once`, () => {
    const f = setup();
    try {
      const input = { ...f.registration(), maxAttempts: 1 };
      registerDesktopSubscription(f.root, input, f.root);
      const current = f.oneShot.require(input.subscriptionId);
      if (path === "deadline") f.oneShot.due(current.deadlineAt);
      else {
        f.oneShot.beginAttempt(input.subscriptionId, current.nextPollAt);
        if (path === "probe-error") f.oneShot.recordPollFailure(input.subscriptionId, "probe unavailable", current.nextPollAt);
        else f.oneShot.recordObservation(input.subscriptionId, { version: "pending", facts: {}, terminal: null }, current.nextPollAt);
      }
      const expired = f.oneShot.require(input.subscriptionId);
      assert.equal(expired.status, "expired");
      assert.equal(expired.actionReceipt?.status, "succeeded");
      const body = JSON.parse(String(desktopSubscriptionDeliveries(f.root, input.subscriptionId, f.root)[0]?.payload.body));
      assert.equal(body.observation.facts.status, "expired");
      assert.equal(body.observation.terminal, null);
      assert.equal(body.observation.facts.businessResult, "unknown");
      if (path === "probe-error") assert.equal(body.observation.facts.latestError, "probe unavailable");
      f.oneShot.due(current.deadlineAt);
      assert.equal(desktopSubscriptionDeliveries(f.root, input.subscriptionId, f.root).length, 1);
    } finally { f.close(); }
  });
}

test("registration rejects unregistered authority and ambiguous targets before admission", () => {
  const f = setup();
  try {
    for (const overrides of [{ threadId: "recent" }, { pluginRef: "plugin:absent@1" }, { executable: "/bin/sh" }]) {
      assert.throws(() => registerDesktopSubscription(f.root, { ...f.registration(), ...overrides }, f.root));
    }
    assert.equal(f.oneShot.list().length, 0);
  } finally { f.close(); }
});

test("large unknown outcome stays explicit in a short notice and exact old evidence remains queryable", () => {
  const f = setup();
  try {
    const input = f.registration("continuous");
    registerDesktopSubscription(f.root, input, f.root);
    f.continuous.recordObservation(input.subscriptionId, {version:"old", occurrenceKey:"old", terminal:"failure",
      facts:{status:"unknown", reason:"Outcome cannot be determined", log:"bulk-evidence-".repeat(500)}});
    f.continuous.recordObservation(input.subscriptionId, {version:"new", occurrenceKey:"new", terminal:"success", facts:{status:"done"}});
    const deliveries = desktopSubscriptionDeliveries(f.root, input.subscriptionId, f.root);
    const old = deliveries.find(item => JSON.parse(String(item.payload.body)).observation.version === "old")!;
    const notice = codexDesktopActionSource(f.actions, {repoRoot:f.root,runtimeDirectory:f.root})({delivery:old,destination:f.runtime.destination(old.destinationId)!})!;
    assert.match(notice.body, /failure \/ unknown/);
    assert.match(notice.body, /Outcome cannot be determined/);
    assert.ok(notice.body.length < 800);
    assert.ok(!notice.body.includes("bulk-evidence"));
    let readback = "";
    runSubscriptionCommand(f.root,["receipt",old.origin.id],{write:text=>{readback+=text;}},f.root);
    assert.equal(JSON.parse(readback).evidence.observation.version,"old");
    assert.ok(JSON.parse(readback).evidence.observation.facts.log.length > 5000);
    assert.throws(()=>runSubscriptionCommand(f.root,["receipt","dar1_missing"],{write:()=>{}},f.root),/not found/);
  } finally {f.close();}
});
