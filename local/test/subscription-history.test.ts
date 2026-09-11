import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { subscriptionHistory } from
  "../src/application/subscription/query.js";
import { SubscriptionStore } from
  "../src/capabilities/subscription/store.js";
import { ContinuousSubscriptionStore } from
  "../src/capabilities/subscription/continuous-store.js";
import { localId } from "../src/core/id.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { runtimeId } from "../src/core/runtime/model.js";
import { runLocalApp } from "../src/entrypoints/cli/main.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { openRuntimeDatabase } from
  "../src/infrastructure/sqlite/database.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";

test("Subscription history keeps fires, deliveries, and executions distinct", async () => {
  const fixture = createFixture("resolved");
  try {
    const runtime = new RuntimeStore(fixture.database);
    const firstDestination = runtime.putDestination({
      destinationId: "dst_019f0000-0000-7000-8000-000000000401",
      kind: "matrix",
      address: { roomId: "room-a", subscriptionId: fixture.subscriptionId },
      at: "2026-09-01T00:00:00.000Z"
    });
    const secondDestination = runtime.putDestination({
      destinationId: "dst_019f0000-0000-7000-8000-000000000402",
      kind: "macos-notification",
      address: { title: "Subscription complete", subscriptionId: fixture.subscriptionId },
      at: "2026-09-01T00:00:00.000Z"
    });
    const admitted = runtime.appendEvent({
      type: "subscription.fire",
      source: { kind: "subscription", externalId: "callback-occurrence-1" },
      agentId: fixture.agentId,
      prompt: "Handle the terminal observation",
      observation: {
        version: "fixture-v1",
        terminalKey: "terminal-1",
        facts: { changed: true },
        terminal: "success"
      },
      destinationIds: [secondDestination.destinationId, firstDestination.destinationId],
      maxAttempts: 3,
      createdAt: "2026-09-01T00:00:01.000Z"
    });
    const agentExecution = runtime.claimDueExecutions(
      1,
      "2026-09-01T00:00:01.000Z"
    )[0]!;
    const result = runtime.completeExecution(agentExecution.executionId, {
      adapterId: "fixture-agent-v1",
      workspace: fixture.repo,
      providerSessionId: "fixture-provider-session",
      output: "Subscription handled"
    }, "2026-09-01T00:00:02.000Z");
    assert.equal(result?.type, "agent.result");
    const resultExecution = runtime.claimDueExecutions(
      1,
      "2026-09-01T00:00:02.000Z"
    )[0]!;
    const deliveries = runtime.completeResultExecution(
      resultExecution.executionId,
      "2026-09-01T00:00:03.000Z"
    );
    const claimed = runtime.claimDueDeliveries(
      1,
      "2026-09-01T00:00:03.000Z"
    )[0]!;
    runtime.deliveryFailed(
      claimed.deliveryId,
      "destination unavailable",
      "2026-09-01T00:00:04.000Z"
    );
    const failedFire = runtime.appendEvent({
      type: "subscription.fire",
      source: { kind: "subscription", externalId: "callback-occurrence-2" },
      agentId: fixture.agentId,
      prompt: "Handle another terminal observation",
      observation: {
        version: "fixture-v1",
        terminalKey: "terminal-2",
        facts: { changed: true },
        terminal: "failure"
      },
      destinationIds: [firstDestination.destinationId],
      maxAttempts: 1,
      createdAt: "2026-09-01T00:00:05.000Z"
    });
    const failedExecution = runtime.claimDueExecutions(
      1,
      "2026-09-01T00:00:05.000Z"
    )[0]!;
    const failure = runtime.failExecution(
      failedExecution.executionId,
      "agent provider refused",
      "2026-09-01T00:00:06.000Z"
    );
    assert.equal(failure.resultEvent?.outcome, "failed");
    const failedResultExecution = runtime.claimDueExecutions(
      1,
      "2026-09-01T00:00:06.000Z"
    )[0]!;
    runtime.completeResultExecution(
      failedResultExecution.executionId,
      "2026-09-01T00:00:07.000Z"
    );
    runtime.close();

    const before = digest(fixture.database);
    const history = subscriptionHistory(
      fixture.repo,
      fixture.subscriptionId,
      fixture.runtimeDirectory
    );
    assert.equal(digest(fixture.database), before);
    assert.equal(history.schemaVersion, "SubscriptionHistory@1");
    assert.equal(history.queryStatus, "ok");
    assert.equal(history.linkStatus, "resolved");
    assert.equal(history.reasonCode, null);
    assert.deepEqual(history.fires.map(({ eventId }) => eventId), [
      admitted.event.eventId,
      failedFire.event.eventId
    ]);
    const fire = history.fires[0]!;
    assert.equal(fire.eventId, admitted.event.eventId);
    assert.equal(fire.status, "succeeded");
    assert.equal(fire.lastError, null);
    assert.equal(fire.resultEvent.eventId, result!.eventId);
    assert.equal(fire.resultEvent.outcome, "succeeded");
    assert.equal(fire.resultEvent.output, "Subscription handled");
    assert.deepEqual(
      fire.deliveries.map(({ deliveryId }) => deliveryId),
      deliveries.map(({ deliveryId }) => deliveryId).sort()
    );
    assert.equal(fire.deliveries.find(({ deliveryId }) =>
      deliveryId === claimed.deliveryId)?.attempt, 1);
    assert.equal(fire.deliveries.find(({ deliveryId }) =>
      deliveryId === claimed.deliveryId)?.lastError, "destination unavailable");
    for (const delivery of fire.deliveries) {
      assert.equal(delivery.executions.length, 1);
      assert.deepEqual(delivery.executions[0], {
        executionId: agentExecution.executionId,
        eventId: admitted.event.eventId,
        handler: "agent",
        attempt: 1,
        maxAttempts: 3,
        status: "succeeded",
        lastError: null,
        nextAttemptAt: "2026-09-01T00:00:01.000Z",
        createdAt: "2026-09-01T00:00:01.000Z",
        startedAt: "2026-09-01T00:00:01.000Z",
        completedAt: "2026-09-01T00:00:02.000Z",
        updatedAt: "2026-09-01T00:00:02.000Z"
      });
    }
    const failed = history.fires[1]!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.lastError, "agent provider refused");
    assert.equal(failed.resultEvent.outcome, "failed");
    assert.equal(failed.resultEvent.error, "agent provider refused");
    assert.equal(failed.deliveries[0]?.status, "pending");
    assert.equal(failed.deliveries[0]?.lastError, null);
    assert.equal(failed.deliveries[0]?.executions[0]?.attempt, 1);

    let cliOutput = "";
    assert.equal(await runLocalApp(fixture.repo, [
      "--runtime", fixture.runtimeDirectory,
      "subscription", "history", fixture.subscriptionId, "--json"
    ], {}, { write(text) { cliOutput += text; } }), 0);
    assert.deepEqual(JSON.parse(cliOutput), history);
  } finally {
    fixture.cleanup();
  }
});

test("Subscription history distinguishes zero, legacy, and incomplete links", async () => {
  const fixture = createFixture("link-status");
  try {
    const emptyHistory = subscriptionHistory(
      fixture.repo,
      fixture.subscriptionId,
      fixture.runtimeDirectory
    );
    const expectedEmptyHistory = {
      schemaVersion: "SubscriptionHistory@1",
      queryStatus: "ok",
      subscriptionId: fixture.subscriptionId,
      linkStatus: "resolved",
      reasonCode: null,
      fires: []
    } as const;
    assert.deepEqual(emptyHistory, expectedEmptyHistory);
    let emptyCliOutput = "";
    assert.equal(await runLocalApp(fixture.repo, [
      "--runtime", fixture.runtimeDirectory,
      "subscription", "history", fixture.subscriptionId, "--json"
    ], {}, { write(text) { emptyCliOutput += text; } }), 0);
    assert.deepEqual(JSON.parse(emptyCliOutput), expectedEmptyHistory);

    const legacy = createSubscription(fixture, "legacy");
    const database = openRuntimeDatabase(fixture.database);
    database.prepare(`
      UPDATE subscriptions
      SET status = 'completed', callback_phase_status = 'completed_with_unknown',
        terminal_key = 'legacy-terminal', terminal_observation_json = ?
      WHERE subscription_id = ?
    `).run(JSON.stringify({
      version: "legacy-v1",
      terminalKey: "legacy-terminal",
      facts: {},
      terminal: "success"
    }), legacy);
    database.close();
    const legacyHistory = subscriptionHistory(
      fixture.repo,
      legacy,
      fixture.runtimeDirectory
    );
    assert.equal(legacyHistory.linkStatus, "unresolved");
    assert.equal(legacyHistory.reasonCode, "legacy_link_not_recorded");
    assert.deepEqual(legacyHistory.fires, []);
    let legacyCliOutput = "";
    assert.equal(await runLocalApp(fixture.repo, [
      "--runtime", fixture.runtimeDirectory,
      "subscription", "history", legacy, "--json"
    ], {}, { write(text) { legacyCliOutput += text; } }), 0);
    assert.equal(JSON.parse(legacyCliOutput).reasonCode, "legacy_link_not_recorded");

    const continuousStore = new ContinuousSubscriptionStore(fixture.database);
    const callbackId = localId("scb");
    const continuous = continuousStore.create({
      schemaVersion: "ContinuousSubscriptionDefinition@1",
      revision: 1,
      title: "History continuous",
      ownerAgentId: fixture.agentId,
      probe: {
        plugin: { path: join(fixture.repo, "probe.mjs"), id: "history-probe", config: {} },
        policy: subscriptionPolicy(fixture.repo)
      },
      intervalMilliseconds: 1_000,
      callbacks: [{
        callbackId,
        kind: "destination.deliver",
        definition: {
          schemaVersion: "ProactiveCallbackDefinition@1",
          callbackId,
          kind: "destination.deliver",
          destinationId: "dst_019f0000-0000-7000-8000-000000000403",
          destinationKind: "macos-notification",
          address: { title: "Continuous history" },
          payload: { body: "Continuous history" }
        },
        grant: {
          schemaVersion: "ProactiveCallbackGrant@1",
          kind: "destination.deliver",
          destinationId: "dst_019f0000-0000-7000-8000-000000000403",
          destinationKind: "macos-notification",
          address: { title: "Continuous history" }
        }
      }]
    }, "2026-09-01T00:00:00.000Z");
    continuousStore.close();
    assert.equal(subscriptionHistory(
      fixture.repo,
      continuous.subscriptionId,
      fixture.runtimeDirectory
    ).linkStatus, "resolved");
    const continuousDatabase = openRuntimeDatabase(fixture.database);
    continuousDatabase.prepare(`
      UPDATE continuous_subscriptions
      SET poll_count = 1, checkpoint_occurrence_key = 'legacy-continuous-occurrence'
      WHERE subscription_id = ?
    `).run(continuous.subscriptionId);
    continuousDatabase.close();
    assert.equal(subscriptionHistory(
      fixture.repo,
      continuous.subscriptionId,
      fixture.runtimeDirectory
    ).reasonCode, "legacy_link_not_recorded");

    const incomplete = createSubscription(fixture, "incomplete");
    const runtime = new RuntimeStore(fixture.database);
    runtime.enqueueHostDelivery({
      originId: "subscription-history-incomplete",
      destinationId: runtimeId("dst"),
      kind: "macos-notification",
      address: { title: "Incomplete", subscriptionId: incomplete },
      payload: { body: "Missing result chain" },
      at: "2026-09-01T01:00:00.000Z"
    });
    runtime.close();
    const incompleteHistory = subscriptionHistory(
      fixture.repo,
      incomplete,
      fixture.runtimeDirectory
    );
    assert.equal(incompleteHistory.linkStatus, "unresolved");
    assert.equal(incompleteHistory.reasonCode, "delivery_result_chain_incomplete");
    assert.deepEqual(incompleteHistory.fires, []);
  } finally {
    fixture.cleanup();
  }
});

test("Subscription history preserves invalid, not-found, and query failures", async () => {
  assert.throws(
    () => subscriptionHistory("/missing", "invalid", "/missing/runtime"),
    /subscriptionId must be a sub_ UUIDv7/
  );

  const fixture = createFixture("failures");
  try {
    for (const arguments_ of [
      ["history", fixture.subscriptionId],
      ["history", "--json", fixture.subscriptionId],
      ["history", fixture.subscriptionId, "--json", "extra"]
    ]) {
      await assert.rejects(() => runLocalApp(fixture.repo, [
        "--runtime", fixture.runtimeDirectory, "subscription", ...arguments_
      ]), /subscription history requires <subscription-id> --json/);
    }
    await assert.rejects(() => runLocalApp(fixture.repo, [
      "--runtime", fixture.runtimeDirectory,
      "subscription", "history", "invalid", "--json"
    ]), /subscriptionId must be a sub_ UUIDv7/);
    const missing = localId("sub");
    await assert.rejects(
      () => runLocalApp(fixture.repo, [
        "--runtime", fixture.runtimeDirectory,
        "subscription", "history", missing, "--json"
      ]),
      new RegExp(`Subscription not found: ${missing}`)
    );
    const database = openRuntimeDatabase(fixture.database);
    database.prepare(
      "UPDATE schema_meta SET value = '69' WHERE key = 'schema_version'"
    ).run();
    database.close();
    let failureOutput = "";
    await assert.rejects(
      () => runLocalApp(fixture.repo, [
        "--runtime", fixture.runtimeDirectory,
        "subscription", "history", fixture.subscriptionId, "--json"
      ], {}, { write(text) { failureOutput += text; } }),
      /schema 69 is not current 75; read-only queries do not migrate schema/
    );
    assert.equal(failureOutput, "");
  } finally {
    fixture.cleanup();
  }
});

interface Fixture {
  readonly repo: string;
  readonly runtimeDirectory: string;
  readonly database: string;
  readonly agentId: string;
  readonly subscriptionId: string;
  cleanup(): void;
}

function createFixture(label: string): Fixture {
  const repo = mkdtempSync(join(tmpdir(), `rollerskate-subscription-history-${label}-repo-`));
  const runtimeDirectory = mkdtempSync(
    join(tmpdir(), `rollerskate-subscription-history-${label}-runtime-`)
  );
  const paths = runtimePaths(repo, runtimeDirectory);
  bootstrapLocalFoundation(paths, "2026-09-01T00:00:00.000Z");
  const foundation = new LocalFoundationStore(paths.database);
  const agentId = foundation.addAgent(
    `history-${label}`,
    "codex",
    "2026-09-01T00:00:00.000Z"
  ).principalId;
  foundation.close();
  const base = {
    repo,
    runtimeDirectory,
    database: paths.database,
    agentId
  };
  return {
    ...base,
    subscriptionId: createSubscription(base, "empty"),
    cleanup() {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  };
}

function createSubscription(
  fixture: Pick<Fixture, "repo" | "database" | "agentId">,
  label: string
): string {
  const subscriptions = new SubscriptionStore(fixture.database);
  try {
    return subscriptions.create({
      schemaVersion: 3,
      revision: `${label}-v1`,
      title: `History ${label}`,
      ownerAgentId: fixture.agentId,
      probe: {
        plugin: {
          path: join(fixture.repo, "probe.mjs"),
          id: "history-probe",
          schemaVersion: 1,
          config: {}
        },
        artifactRevision: "fixture-v1",
        artifactDigest: `sha256:${"0".repeat(64)}`,
        policy: subscriptionPolicy(fixture.repo)
      },
      intervalMilliseconds: 1_000,
      maxWaitMilliseconds: 60_000,
      maxAttempts: 3,
      callbacks: [],
      approvedGrantDigest: createHash("sha256").update("[]").digest("base64url")
    }, "2026-09-01T00:00:00.000Z").subscriptionId;
  } finally {
    subscriptions.close();
  }
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function subscriptionPolicy(workspaceRoot: string) {
  return {
    workspaceRoot,
    allowedHttpOrigins: [] as string[],
    allowedExecutables: [] as string[],
    allowedEnvironment: [] as string[],
    timeoutMilliseconds: 1_000,
    maxOutputBytes: 4_096
  };
}
