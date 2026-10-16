import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunMonitorStore, runSubscriptionId } from
  "../src/capabilities/subscription/run-monitor-store.js";
import { listRunMonitors, inspectRunMonitor, runMonitorDeliveries } from
  "../src/application/subscription/run-monitor-query.js";
import { readStewardRunWaitOutcome } from "../src/application/steward/wait-query.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { runtimeId } from "../src/core/runtime/model.js";
import { localId } from "../src/core/id.js";
import { AgentRunStore } from "../src/infrastructure/sqlite/agent-run-store.js";
import { LocalFoundationStore, bootstrapLocalFoundation } from
  "../src/infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { withImmediateTransaction } from "../src/infrastructure/sqlite/transaction.js";

test("Run monitor queries read Run state, host deliveries, and canonical Chat receipts", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rs-run-monitor-query-"));
  const paths = runtimePaths(root, root);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths);
  const database = openRuntimeDatabase(paths.database);
  database.exec("PRAGMA foreign_keys = ON");
  const runtime = new RuntimeStore(database, { migrate: false });
  const foundation = new LocalFoundationStore(database, { migrate: false });
  const runs = new AgentRunStore(database, { migrate: false });
  t.after(() => {
    runs.close();
    foundation.close();
    runtime.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const agent = foundation.addAgent("monitor-query-agent", "codex");
  const rootEvent = runtime.appendEvent({
    type: "agent.request", source: { kind: "cli" }, agentId: agent.principalId,
    prompt: "fixture"
  });
  const runId = localId("run");
  runs.createInTransaction({
    runId, rootEventId: rootEvent.event.eventId,
    rootExecutionId: runtime.executionForEvent(rootEvent.event.eventId)!.executionId,
    ownerRequestId: `owner-${runId}`, ownerPrincipalId: "test-owner",
    stewardAgentId: agent.principalId,
    mandate: { schemaVersion: "RunMandateSnapshot@1", kind: "objective",
      objective: "fixture", renderedInstruction: "fixture" },
    rootStepId: "step-root", maxSteps: 2, maxDepth: 0,
    createdAt: "2026-10-16T01:00:00.000Z"
  });
  const subscription = withImmediateTransaction(database, () =>
    new RunMonitorStore(database).createInTransaction(runId, "2026-10-16T01:00:00.000Z"));
  const threadId = "123e4567-e89b-42d3-a456-426614174000";
  const destinationId = runtimeId("dst");
  runtime.putDestination({ destinationId, kind: "codex-desktop", address: { threadId } });
  runtime.enqueueHostDelivery({
    originId: `run-subscription:${subscription.subscriptionId}:terminal:failed`,
    destinationId, kind: "codex-desktop", address: { threadId },
    payload: { body: "failed" }
  });
  runtime.enqueueHostDelivery({
    originId: `steward-run:${runId}:run:terminal`,
    destinationId, kind: "codex-desktop", address: { threadId },
    payload: { body: "terminal" }
  });
  const activation = runtime.createChatActivation({
    topicId: "top_run_monitor", reason: "manual", strategyId: "manual",
    conversationIntent: { schema: "ConversationIntentSnapshot@1",
      mode: "continue_recent", governanceRevision: 1 },
    candidateAgentIds: [agent.principalId], idempotencyKey:
      `run-subscription:${subscription.subscriptionId}:terminal:failed`,
    expiresAt: "2026-10-17T01:00:00.000Z"
  });
  assert.equal(activation.status, "accepted");

  const listed = listRunMonitors(root, root);
  assert.equal(listed.subscriptions.length, 1);
  assert.equal(listed.subscriptions[0]!.subscription.runId, runId);
  assert.equal(listed.subscriptions[0]!.run.status, "active");
  assert.equal(inspectRunMonitor(root, runSubscriptionId(runId), root).subscription.runId, runId);
  withImmediateTransaction(database, () =>
    new RunMonitorStore(database).setStatusInTransaction(
      subscription.subscriptionId, "blocked", "delivery unavailable", "2026-10-16T01:01:00.000Z"));
  const waiting = readStewardRunWaitOutcome(root, runId, root);
  assert.equal(waiting.run.status, "active");
  assert.equal(waiting.run.terminal, false);
  assert.equal(waiting.monitoring?.status, "blocked");
  assert.equal(waiting.monitoring?.latestError, "delivery unavailable");

  const result = runMonitorDeliveries(root, subscription.subscriptionId, root);
  assert.deepEqual(result.deliveries.map((delivery) => delivery.origin.id).sort(), [
    `run-subscription:${subscription.subscriptionId}:terminal:failed`,
    `steward-run:${runId}:run:terminal`
  ].sort());
  assert.equal(result.chatActivations.length, 1);
  assert.equal(result.chatActivations[0]!.event.source.externalId,
    `chat-activation:run-subscription:${subscription.subscriptionId}:terminal:failed`);
  assert.equal(result.chatActivations[0]!.execution?.status, "queued");

});
