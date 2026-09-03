import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  validateProactiveCallback,
  type ProactiveCallbackDefinition
} from "../src/modules/callback/proactive-model.js";
import { ProactiveCallbackRuntime } from "../src/application/callback/proactive-runtime.js";
import { proactiveCallbackOwnerAdapters } from "../src/application/callback/proactive.js";
import { scheduledRunView } from "../src/application/schedule/query.js";
import { CallbackStore } from "../src/infrastructure/callback/store.js";
import { SubscriptionStore } from "../src/capabilities/subscription/store.js";
import { ContinuousSubscriptionRuntime } from "../src/capabilities/subscription/continuous-runtime.js";
import { ContinuousSubscriptionStore } from "../src/capabilities/subscription/continuous-store.js";
import { ScheduledTaskRuntime } from "../src/capabilities/scheduled-task/runtime.js";
import { ScheduledTaskStore } from "../src/capabilities/scheduled-task/store.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { DeliveryHandler } from "../src/core/runtime/handlers.js";
import { LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { createLegacySubscriptionCallbacks } from "./support/legacy-schema.js";

test("shared callback contract is strict and exact-grant", () => {
  const callback = agentCallback("agent-1", "/workspace");
  assert.equal(validateProactiveCallback(callback).kind, "agent.invoke");
  assert.throws(() => validateProactiveCallback({
    ...callback,
    definition: { ...callback.definition, extra: true }
  }), /unsupported field: extra/);
  assert.throws(() => validateProactiveCallback({
    ...callback,
    grant: { ...callback.grant, workspace: "/other" }
  }), /target exceeds grant/);
  assert.throws(() => validateProactiveCallback({
    callbackId: "destination-1",
    kind: "destination.deliver",
    definition: {
      schemaVersion: "ProactiveCallbackDefinition@1",
      callbackId: "destination-1",
      kind: "destination.deliver",
      destinationId: "dst_019fa649-637b-7bf2-ad2b-a9b7be044fcd",
      destinationKind: "macos-notification",
      address: { channel: "owner" },
      payload: { title: "Done", body: "Inspect" }
    },
    grant: {
      schemaVersion: "ProactiveCallbackGrant@1",
      kind: "destination.deliver",
      destinationId: "dst_019fa649-637b-7bf2-ad2b-a9b7be044fcd",
      destinationKind: "macos-notification",
      address: { channel: "someone-else" }
    }
  }), /target exceeds grant/);
});

test("legacy Node command callbacks remain readable but cannot be registered or executed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-proactive-legacy-node-"));
  const databasePath = join(directory, "runtime.db");
  const store = new CallbackStore(databasePath);
  const owner = { kind: "schedule" as const, id: "legacy-node", revision: 1 };
  const callback = commandCallback(directory);
  try {
    store.registerDefinitions(owner, [callback]);
    store.materialize(owner, "manual:legacy-node");
    const database = new DatabaseSync(databasePath);
    try {
      for (const table of [
        "proactive_callback_definitions",
        "proactive_callback_occurrences"
      ]) {
        database.exec(`
          UPDATE ${table}
          SET definition_json = json_set(definition_json, '$.runtime', 'node'),
              grant_json = json_set(grant_json, '$.runtime', 'node')
        `);
      }
    } finally {
      database.close();
    }
    assert.equal(store.definitions(owner)[0]!.definition.runtime, "node");
    assert.equal(store.list({
      ownerKind: owner.kind,
      ownerId: owner.id,
      triggerOccurrenceKey: "manual:legacy-node"
    })[0]!.definition.runtime, "node");
    assert.throws(() => validateProactiveCallback({
      ...callback,
      definition: { ...callback.definition, runtime: "node" },
      grant: { ...callback.grant, runtime: "node" }
    }), /runtime must be host/);
    const result = await callbackRuntime(databasePath).tick(new AbortController().signal);
    assert.equal(result.failed.length, 1);
    const occurrence = store.list({
      ownerKind: owner.kind,
      ownerId: owner.id,
      triggerOccurrenceKey: "manual:legacy-node"
    })[0]!;
    assert.equal(occurrence.status, "failed");
    assert.match(occurrence.lastError ?? "", /runtime must be host/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared callback runtime executes immediate work then admits and reconciles Agent Event", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-proactive-callback-"));
  const database = join(directory, "runtime.db");
  const foundation = new LocalFoundationStore(database);
  const agent = foundation.addAgent("callback-agent", "codex", "2026-07-28T00:00:00.000Z");
  foundation.close();
  const store = new CallbackStore(database);
  const owner = { kind: "schedule" as const, id: "schedule-1", revision: 1 };
  const delivered: unknown[] = [];
  try {
    store.registerDefinitions(owner, [
      commandCallback(directory),
      destinationCallback(),
      agentCallback(agent.principalId, directory)
    ], "2026-07-28T00:00:01.000Z");
    const firstMaterialization = store.materialize(
      owner,
      "scheduled:2026-07-28T01:00:00.000Z",
      "2026-07-28T00:00:02.000Z"
    );
    const duplicate = store.materialize(
      owner,
      "scheduled:2026-07-28T01:00:00.000Z",
      "2026-07-28T00:00:03.000Z"
    );
    assert.deepEqual(
      duplicate.map(({ occurrenceId }) => occurrenceId),
      firstMaterialization.map(({ occurrenceId }) => occurrenceId)
    );

    const callbacks = callbackRuntime(database);
    const first = await callbacks.tick(
      new AbortController().signal,
      "2026-07-28T00:00:04.000Z"
    );
    assert.equal(first.succeeded.length, 1);
    assert.equal(first.admitted.length, 1);
    assert.deepEqual(first.failed, []);

    const runtime = new RuntimeStore(database);
    const deliveryHandler = new DeliveryHandler({
      store: runtime,
      adapters: new Map([["macos-notification", {
        kind: "macos-notification" as const,
        async deliver(input) {
          delivered.push(input.delivery.payload);
          return { receipt: `test:${input.delivery.deliveryId}` };
        }
      }]])
    });
    const delivery = runtime.claimDueDeliveries(1, "2026-07-28T00:00:05.000Z")[0]!;
    await deliveryHandler.handle(delivery, "2026-07-28T00:00:05.000Z");
    assert.equal(delivered.length, 1);
    const intermediate = await callbacks.tick(
      new AbortController().signal,
      "2026-07-28T00:00:05.500Z"
    );
    assert.equal(intermediate.reconciled, 1);
    assert.equal(intermediate.admitted.length, 1);
    const execution = runtime.claimDueExecutions(1, "2026-07-28T00:00:06.000Z")[0]!;
    assert.equal(execution.maxAttempts, 1);
    runtime.completeExecution(execution.executionId, {
      adapterId: "fake-agent-v1",
      workspace: directory,
      providerSessionId: "provider-callback-1",
      output: "done"
    }, "2026-07-28T00:00:07.000Z");
    const second = await callbacks.tick(
      new AbortController().signal,
      "2026-07-28T00:00:08.000Z"
    );
    assert.equal(second.reconciled, 1);
    assert.deepEqual(store.list({
      ownerKind: "schedule",
      ownerId: "schedule-1",
      triggerOccurrenceKey: "scheduled:2026-07-28T01:00:00.000Z"
    }).map(({ kind, status }) => ({ kind, status })), [
      { kind: "command.exec", status: "succeeded" },
      { kind: "destination.deliver", status: "succeeded" },
      { kind: "agent.invoke", status: "succeeded" }
    ]);
    runtime.close();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("started callback crash marks its remaining occurrence group unknown without replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-proactive-recovery-"));
  const database = join(directory, "runtime.db");
  const store = new CallbackStore(database);
  const owner = {
    kind: "continuous_subscription" as const,
    id: "subscription-1",
    revision: 1
  };
  const ref = {
    ownerKind: owner.kind,
    ownerId: owner.id,
    triggerOccurrenceKey: "observation:1"
  };
  try {
    store.registerDefinitions(owner, [commandCallback(directory), destinationCallback()]);
    store.materialize(owner, ref.triggerOccurrenceKey);
    assert.equal(store.beginNext(ref)?.status, "started");
    const runtime = callbackRuntime(database);
    assert.equal(runtime.recover("2026-07-28T01:00:00.000Z"), 2);
    assert.deepEqual(store.list(ref).map(({ status }) => status), ["unknown", "unknown"]);
    assert.deepEqual(store.ready(), []);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("command callback receives its generic occurrence context on stdin", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-proactive-command-input-"));
  const database = join(directory, "runtime.db");
  const foundation = new LocalFoundationStore(database);
  const agent = foundation.addAgent("command-input", "codex", "2026-07-28T00:00:00.000Z");
  foundation.close();
  const subscriptions = new ContinuousSubscriptionStore(database);
  try {
    const callback = commandCallback(directory);
    writeFileSync(
      (callback.definition.argv as string[])[0]!,
      "let value = ''; for await (const chunk of process.stdin) value += chunk; process.stdout.write(value);\n"
    );
    const subscription = subscriptions.create({
      schemaVersion: "ContinuousSubscriptionDefinition@1",
      revision: 1,
      title: "Pass observation to callback",
      ownerAgentId: agent.principalId,
      probe: {
        plugin: { path: join(directory, "probe.mjs"), id: "input-probe", config: {} },
        policy: {
          workspaceRoot: directory,
          allowedHttpOrigins: [],
          allowedExecutables: [],
          allowedEnvironment: [],
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096
        }
      },
      intervalMilliseconds: 100,
      callbacks: [callback]
    }, "2026-07-28T00:00:00.000Z");
    subscriptions.beginPoll(subscription.subscriptionId, "2026-07-28T00:00:00.100Z");
    subscriptions.recordObservation(subscription.subscriptionId, {
      version: "v1",
      occurrenceKey: "message:om_1",
      facts: { messageId: "om_1", text: "ship it" },
      terminal: null
    }, "2026-07-28T00:00:00.100Z");

    const result = await callbackRuntime(database).tick(
      new AbortController().signal,
      "2026-07-28T00:00:00.200Z"
    );
    assert.equal(result.succeeded.length, 1);
    const occurrence = new CallbackStore(database).list({
      ownerKind: "continuous_subscription",
      ownerId: subscription.subscriptionId,
      triggerOccurrenceKey: "message:om_1"
    })[0]!;
    const receipt = occurrence.receipt as { stdout: string };
    const input = JSON.parse(receipt.stdout) as {
      schemaVersion: string;
      occurrence: { triggerOccurrenceKey: string };
      context: { observation: { facts: { messageId: string } } };
    };
    assert.equal(input.schemaVersion, "ProactiveCallbackInput@1");
    assert.equal(input.occurrence.triggerOccurrenceKey, "message:om_1");
    assert.equal(input.context.observation.facts.messageId, "om_1");
  } finally {
    subscriptions.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("host command callback executes the exact granted executable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-proactive-host-command-"));
  const database = join(directory, "runtime.db");
  const executable = realpathSync("/bin/echo");
  const callback: ProactiveCallbackDefinition = {
    callbackId: "host-command",
    kind: "command.exec",
    definition: {
      schemaVersion: "ProactiveCallbackDefinition@1",
      callbackId: "host-command",
      kind: "command.exec",
      runtime: "host",
      executable,
      argv: ["host-callback"],
      cwd: directory,
      environment: {},
      timeoutMilliseconds: 1_000,
      maxOutputBytes: 4_096
    },
    grant: {
      schemaVersion: "ProactiveCallbackGrant@1",
      kind: "command.exec",
      runtime: "host",
      executable,
      argv: ["host-callback"],
      cwd: directory,
      environment: {},
      filesystemRoots: [realpathSync("/bin"), directory],
      networkAccess: true,
      timeoutMilliseconds: 1_000,
      maxOutputBytes: 4_096,
      secretReferences: []
    }
  };
  const store = new CallbackStore(database);
  const owner = { kind: "schedule" as const, id: "host-command", revision: 1 };
  try {
    store.registerDefinitions(owner, [callback]);
    store.materialize(owner, "manual:host");
    assert.equal((await callbackRuntime(database).tick(
      new AbortController().signal
    )).succeeded.length, 1);
    const receipt = store.list({
      ownerKind: owner.kind,
      ownerId: owner.id,
      triggerOccurrenceKey: "manual:host"
    })[0]!.receipt as { stdout: string };
    assert.equal(receipt.stdout, "host-callback\n");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v72 upgrades v46 in place and preserves Schedule and SubscriptionDefinition@3", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v48-from-v46-"));
  const database = join(directory, "runtime.db");
  try {
    const foundation = new LocalFoundationStore(database);
    const agent = foundation.addAgent("migration-agent", "codex", "2026-07-28T00:00:00.000Z");
    foundation.close();
    const schedules = new ScheduledTaskStore(database);
    const schedule = schedules.create({
      ownerPrincipalId: agent.principalId,
      agentId: agent.principalId,
      kind: "once",
      expression: "2026-07-29T00:00:00.000Z",
      misfirePolicy: "run_once",
      overlapPolicy: "queue",
      misfireGraceMilliseconds: 60_000,
      sessionPolicy: "new_each_run",
      prompt: "Preserve schedule",
      workspace: directory
    }, "2026-07-28T00:00:01.000Z");
    schedules.close();
    const subscriptions = new SubscriptionStore(database);
    const subscription = subscriptions.create({
      schemaVersion: 3,
      revision: "migration-v1",
      title: "Preserve subscription",
      ownerAgentId: agent.principalId,
      probe: {
        plugin: { path: join(directory, "probe.mjs"), id: "migration-probe", schemaVersion: 1, config: {} },
        artifactRevision: "migration-source-v1",
        artifactDigest: `sha256:${"0".repeat(64)}`,
        policy: {
          workspaceRoot: directory,
          allowedHttpOrigins: [],
          allowedExecutables: [],
          allowedEnvironment: [],
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096
        }
      },
      intervalMilliseconds: 1_000,
      maxWaitMilliseconds: 60_000,
      maxAttempts: 10,
      callbacks: [],
      approvedGrantDigest: createHash("sha256").update("[]").digest("base64url")
    }, "2026-07-28T00:00:02.000Z");
    subscriptions.close();

    const v46 = new DatabaseSync(database);
    createLegacySubscriptionCallbacks(v46);
    v46.exec(`
      DROP TABLE proactive_callback_occurrences;
      DROP TABLE proactive_callback_definitions;
      DROP TABLE continuous_subscriptions;
      UPDATE schema_meta SET value = '46' WHERE key = 'schema_version';
    `);
    v46.close();

    const diagnostics = initializeRuntimeSchema(database);
    assert.equal(diagnostics.schemaVersion, 72);
    assert.equal(diagnostics.tables.length, 32);
    const migratedSchedules = new ScheduledTaskStore(database);
    const migratedSubscriptions = new SubscriptionStore(database);
    try {
      assert.equal(
        migratedSchedules.require(schedule.definition.scheduleId).revision.prompt,
        "Preserve schedule"
      );
      assert.equal(
        migratedSubscriptions.require(subscription.subscriptionId).definitionRevision,
        "migration-v1"
      );
    } finally {
      migratedSchedules.close();
      migratedSubscriptions.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v72 drops v51 one-shot callback rows and settles their parent as unknown", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v52-from-v51-callback-"));
  const databasePath = join(directory, "runtime.db");
  try {
    const foundation = new LocalFoundationStore(databasePath);
    const agent = foundation.addAgent("legacy-callback-agent", "codex");
    foundation.close();
    const subscriptions = new SubscriptionStore(databasePath);
    const subscription = subscriptions.create({
      schemaVersion: 3,
      revision: "legacy-v51",
      title: "Legacy callback parent",
      ownerAgentId: agent.principalId,
      probe: {
        plugin: { path: join(directory, "probe.mjs"), id: "legacy-probe", schemaVersion: 1, config: {} },
        artifactRevision: "legacy-source",
        artifactDigest: `sha256:${"0".repeat(64)}`,
        policy: {
          workspaceRoot: directory,
          allowedHttpOrigins: [],
          allowedExecutables: [],
          allowedEnvironment: [],
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096
        }
      },
      intervalMilliseconds: 1_000,
      maxWaitMilliseconds: 60_000,
      maxAttempts: 10,
      callbacks: [],
      approvedGrantDigest: createHash("sha256").update("[]").digest("base64url")
    });
    subscriptions.close();

    const legacy = new DatabaseSync(databasePath);
    createLegacySubscriptionCallbacks(legacy);
    legacy.prepare(`
      UPDATE subscriptions SET status = 'completed', callback_phase_status = 'pending',
        terminal_key = 'legacy-terminal', terminal_observation_json = ?
      WHERE subscription_id = ?
    `).run(JSON.stringify({
      version: "legacy-v51",
      terminalKey: "legacy-terminal",
      facts: {},
      terminal: "success"
    }), subscription.subscriptionId);
    legacy.prepare(`
      INSERT INTO subscription_callbacks (
        callback_id, subscription_id, ordinal, kind, definition_schema,
        definition_json, grant_json, status, created_at, updated_at
      ) VALUES (?, ?, 0, 'command.exec', 'SubscriptionCallbackDefinition@1',
        '{}', '{}', 'pending', ?, ?)
    `).run(
      "scb_019f0000-0000-7000-8000-000000000301",
      subscription.subscriptionId,
      "2026-07-30T00:00:00.000Z",
      "2026-07-30T00:00:00.000Z"
    );
    legacy.prepare("UPDATE schema_meta SET value = '51' WHERE key = 'schema_version'").run();
    legacy.close();

    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 72);
    const migrated = new SubscriptionStore(databasePath);
    try {
      assert.equal(
        migrated.require(subscription.subscriptionId).callbackPhaseStatus,
        "completed_with_unknown"
      );
    } finally {
      migrated.close();
    }
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.throws(
        () => inspection.prepare("SELECT COUNT(*) FROM subscription_callbacks").get(),
        /no such table/
      );
    } finally {
      inspection.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Schedule callback revision executes command and destination without an Agent turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schedule-free-callback-"));
  const database = join(directory, "runtime.db");
  const foundation = new LocalFoundationStore(database);
  const agent = foundation.addAgent("schedule-owner", "codex", "2026-07-28T00:00:00.000Z");
  foundation.close();
  const schedules = new ScheduledTaskStore(database);
  const runtime = new RuntimeStore(database);
  try {
    const schedule = schedules.create({
      ownerPrincipalId: agent.principalId,
      agentId: agent.principalId,
      kind: "once",
      expression: "2026-07-28T01:00:00.000Z",
      misfirePolicy: "run_once",
      overlapPolicy: "queue",
      misfireGraceMilliseconds: 60_000,
      sessionPolicy: "new_each_run",
      prompt: "Compatibility metadata",
      workspace: directory,
      callbacks: [commandCallback(directory), destinationCallback()]
    }, "2026-07-28T00:00:00.000Z");
    const scheduler = new ScheduledTaskRuntime({
      store: schedules,
      runtime,
      validateTarget: () => undefined
    });
    assert.equal((await scheduler.runCycle("2026-07-28T01:00:00.000Z")).admitted.length, 1);
    const run = schedules.runs(schedule.definition.scheduleId)[0]!;
    assert.equal(run.status, "running");
    assert.equal(run.eventId, undefined);
    const callbacks = callbackRuntime(database);
    const callbackResult = await callbacks.tick(
      new AbortController().signal,
      "2026-07-28T01:00:01.000Z"
    );
    assert.equal(callbackResult.succeeded.length, 1);
    assert.equal(callbackResult.admitted.length, 1);
    const occurrence = schedules.callbackOccurrences(run)
      .find(({ kind }) => kind === "destination.deliver")!;
    const deliveryId = (occurrence.receipt as { deliveryId: string }).deliveryId;
    const pendingDelivery = runtime.delivery(deliveryId)!;
    const view = scheduledRunView({
      run: schedules.requireRun(run.runId),
      callbacks: schedules.callbackOccurrences(run).map((item) => ({
        occurrence: item,
        ...(item.occurrenceId === occurrence.occurrenceId
          ? { delivery: pendingDelivery }
          : {})
      }))
    });
    assert.equal(view.callbacks[1]!.phase, "admitted");
    assert.equal(view.callbacks[1]!.deliveryId, deliveryId);
    assert.equal(view.callbacks[1]!.delivery?.status, "pending");
    const handler = new DeliveryHandler({
      store: runtime,
      adapters: new Map([["macos-notification", {
        kind: "macos-notification" as const,
        async deliver() { return { receipt: "delivered" }; }
      }]])
    });
    await handler.handle(
      runtime.claimDueDeliveries(1, "2026-07-28T01:00:01.500Z")[0]!,
      "2026-07-28T01:00:01.500Z"
    );
    assert.equal((await callbacks.tick(
      new AbortController().signal,
      "2026-07-28T01:00:01.750Z"
    )).reconciled, 1);
    assert.deepEqual(runtime.events(), []);
    assert.deepEqual(
      (await scheduler.runCycle("2026-07-28T01:00:02.000Z")).projected,
      [run.runId]
    );
    assert.equal(schedules.requireRun(run.runId).status, "succeeded");
  } finally {
    runtime.close();
    schedules.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Continuous Subscription checkpoints callback receipts and dedupes a stable observation key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-continuous-subscription-"));
  const database = join(directory, "runtime.db");
  const foundation = new LocalFoundationStore(database);
  const agent = foundation.addAgent("continuous-owner", "codex", "2026-07-28T00:00:00.000Z");
  foundation.close();
  const subscriptions = new ContinuousSubscriptionStore(database);
  try {
    const subscription = subscriptions.create({
      schemaVersion: "ContinuousSubscriptionDefinition@1",
      revision: 1,
      title: "Watch changing data",
      ownerAgentId: agent.principalId,
      probe: {
        plugin: { path: join(directory, "probe.mjs"), id: "continuous-probe", config: {} },
        policy: {
          workspaceRoot: directory,
          allowedHttpOrigins: [],
          allowedExecutables: [],
          allowedEnvironment: [],
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096
        }
      },
      intervalMilliseconds: 100,
      callbacks: [commandCallback(directory)]
    }, "2026-07-28T00:00:00.000Z");
    subscriptions.beginPoll(subscription.subscriptionId, "2026-07-28T00:00:00.100Z");
    const first = subscriptions.recordObservation(subscription.subscriptionId, {
      version: "v1",
      occurrenceKey: "revision:1",
      facts: { value: 1 },
      terminal: null
    }, "2026-07-28T00:00:00.100Z");
    assert.equal(first.delta, true);
    const callbacks = callbackRuntime(database);
    assert.equal((await callbacks.tick(
      new AbortController().signal,
      "2026-07-28T00:00:00.200Z"
    )).succeeded.length, 1);
    assert.deepEqual(
      subscriptions.finalizeCallbacks("2026-07-28T00:00:00.300Z"),
      [subscription.subscriptionId]
    );
    assert.equal(
      subscriptions.require(subscription.subscriptionId).checkpointOccurrenceKey,
      "revision:1"
    );
    subscriptions.beginPoll(subscription.subscriptionId, "2026-07-28T00:00:00.400Z");
    const duplicate = subscriptions.recordObservation(subscription.subscriptionId, {
      version: "v1",
      occurrenceKey: "revision:1",
      facts: { value: 1 },
      terminal: null
    }, "2026-07-28T00:00:00.400Z");
    assert.equal(duplicate.delta, false);
    const callbackStore = new CallbackStore(database);
    try {
      assert.equal(callbackStore.list({
        ownerKind: "continuous_subscription",
        ownerId: subscription.subscriptionId,
        triggerOccurrenceKey: "revision:1"
      }).length, 1);
    } finally {
      callbackStore.close();
    }
  } finally {
    subscriptions.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Continuous Subscription runtime polls a real plugin and checkpoints its callback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-continuous-runtime-"));
  const database = join(directory, "runtime.db");
  const plugin = join(directory, "probe.mjs");
  writeFileSync(plugin, `export default {
    kind: "subscription.probe",
    id: "continuous-probe",
    schemaVersion: 1,
    plan() {
      return { kind: "command", executable: "/bin/echo", args: ["observed"] };
    },
    evaluate() {
      return {
        version: "v1",
        occurrenceKey: "revision:1",
        facts: { value: 1 },
        terminal: null
      };
    }
  };\n`);
  const foundation = new LocalFoundationStore(database);
  const agent = foundation.addAgent("continuous-runtime-owner", "codex", "2026-07-28T00:00:00.000Z");
  foundation.close();
  const subscriptions = new ContinuousSubscriptionStore(database);
  try {
    const subscription = subscriptions.create({
      schemaVersion: "ContinuousSubscriptionDefinition@1",
      revision: 1,
      title: "Watch a real probe",
      ownerAgentId: agent.principalId,
      probe: {
        plugin: { path: plugin, id: "continuous-probe", config: {} },
        policy: {
          workspaceRoot: directory,
          allowedHttpOrigins: [],
          allowedExecutables: [realpathSync("/bin/echo")],
          allowedEnvironment: [],
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096
        }
      },
      intervalMilliseconds: 100,
      callbacks: [commandCallback(directory)]
    }, "2026-07-28T00:00:00.000Z");
    const runtime = new ContinuousSubscriptionRuntime({ databasePath: database });
    const first = await runtime.runCycle(
      new AbortController().signal,
      "2026-07-28T00:00:00.100Z"
    );
    assert.deepEqual(first.polled, [subscription.subscriptionId]);
    assert.deepEqual(first.deltas, [subscription.subscriptionId]);

    const callbacks = callbackRuntime(database);
    assert.equal((await callbacks.tick(
      new AbortController().signal,
      "2026-07-28T00:00:00.200Z"
    )).succeeded.length, 1);
    const finalized = await runtime.runCycle(
      new AbortController().signal,
      "2026-07-28T00:00:00.300Z"
    );
    assert.deepEqual(finalized.checkpointed, [subscription.subscriptionId]);
    assert.equal(
      subscriptions.require(subscription.subscriptionId).checkpointOccurrenceKey,
      "revision:1"
    );

    const duplicate = await runtime.runCycle(
      new AbortController().signal,
      "2026-07-28T00:00:00.400Z"
    );
    assert.deepEqual(duplicate.polled, [subscription.subscriptionId]);
    assert.deepEqual(duplicate.deltas, []);
  } finally {
    subscriptions.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Continuous callback finalization is bounded and visible callbacks load in one batch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-continuous-bounded-finalize-"));
  const database = join(directory, "runtime.db");
  const foundation = new LocalFoundationStore(database);
  const agent = foundation.addAgent("bounded-owner", "codex", "2026-07-28T00:00:00.000Z");
  foundation.close();
  const subscriptions = new ContinuousSubscriptionStore(database);
  try {
    const ids = ["one", "two"].map((title) => subscriptions.create({
      schemaVersion: "ContinuousSubscriptionDefinition@1",
      revision: 1,
      title,
      ownerAgentId: agent.principalId,
      probe: {
        plugin: { path: join(directory, "probe.mjs"), id: "bounded-probe", config: {} },
        policy: {
          workspaceRoot: directory,
          allowedHttpOrigins: [],
          allowedExecutables: [],
          allowedEnvironment: [],
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096
        }
      },
      intervalMilliseconds: 100,
      callbacks: [commandCallback(directory)]
    }, "2026-07-28T00:00:00.000Z").subscriptionId);
    for (const [index, subscriptionId] of ids.entries()) {
      subscriptions.beginPoll(subscriptionId, "2026-07-28T00:00:00.100Z");
      subscriptions.recordObservation(subscriptionId, {
        version: "v1",
        occurrenceKey: `revision:${index + 1}`,
        facts: { index },
        terminal: null
      }, "2026-07-28T00:00:00.100Z");
    }
    assert.equal((await callbackRuntime(database).tick(
      new AbortController().signal,
      "2026-07-28T00:00:00.200Z"
    )).succeeded.length, 2);
    assert.equal(subscriptions.finalizeCallbacks("2026-07-28T00:00:00.300Z", 1).length, 1);
    assert.equal(subscriptions.list().filter(
      ({ pendingOccurrenceKey }) => pendingOccurrenceKey !== undefined
    ).length, 1);
    assert.equal(subscriptions.finalizeCallbacks("2026-07-28T00:00:00.400Z", 1).length, 1);
    const visible = subscriptions.visibleCallbacks(ids);
    assert.deepEqual(ids.map((id) => visible.get(id)?.length), [1, 1]);
    assert.throws(() => subscriptions.list(101), /limit must be an integer between 1 and 100/);
  } finally {
    subscriptions.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v72 rejects an incomplete database declared as v46", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v48-incomplete-v46-"));
  const databasePath = join(directory, "runtime.db");
  try {
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES ('schema_version', '46');
    `);
    database.close();
    assert.throws(() => initializeRuntimeSchema(databasePath), /schema 46 is incomplete/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v72 migrates v47 and repairs self-declared v48 Delivery state", () => {
  const eventId = "evt_019fa649-637b-7bf2-ad2b-a9b7be044fcd";
  const deliveryId = "del_019fa649-637b-7bf2-ad2b-a9b7be044fcd";
  for (const declaredVersion of [47, 48]) {
    const directory = mkdtempSync(join(
      tmpdir(),
      `rollerskate-schema-v48-from-${declaredVersion}-`
    ));
    const databasePath = join(directory, "runtime.db");
    try {
      initializeRuntimeSchema(databasePath);
      const database = new DatabaseSync(databasePath);
      createLegacySubscriptionCallbacks(database);
      database.exec(`
      INSERT INTO events (
        event_id, type, source_kind, agent_id, outcome, output,
        destination_ids_json, destination_snapshots_json,
        root_event_id, causal_hop, created_at
      ) VALUES (
        '${eventId}', 'agent.result', 'handler', 'agent-migration',
        'succeeded', 'done', '[]', '[]', '${eventId}', 0,
        '2026-07-28T00:00:00.000Z'
      );
      INSERT INTO deliveries (
        delivery_id, result_event_id, origin_kind, origin_id, destination_id,
        destination_kind, destination_address_json, payload_json, status,
        attempt_count, max_attempts, next_attempt_at, receipt, last_error,
        created_at, updated_at
      ) VALUES (
        '${deliveryId}', '${eventId}', 'event', '${eventId}',
        'dst_019fa649-637b-7bf2-ad2b-a9b7be044fcd', 'matrix',
        '{"roomId":"!room:example"}', '{}', 'retry_wait', 2, 5,
        '2026-07-28T00:01:00.000Z', '$receipt', 'temporary',
        '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:30.000Z'
      );
      DROP TRIGGER IF EXISTS notice_project_delivery_insert;
      DROP TRIGGER IF EXISTS notice_project_delivery_update;
      DROP TRIGGER IF EXISTS notice_project_destination_update;
      ALTER TABLE deliveries RENAME TO _v48_deliveries;
      DROP INDEX IF EXISTS deliveries_due;
      CREATE TABLE deliveries (
        delivery_id TEXT PRIMARY KEY,
        result_event_id TEXT NOT NULL REFERENCES events(event_id),
        destination_id TEXT NOT NULL,
        destination_kind TEXT NOT NULL CHECK(destination_kind IN ('matrix', 'macos-notification')),
        destination_address_json TEXT NOT NULL CHECK(json_valid(destination_address_json)),
        status TEXT NOT NULL CHECK(status IN ('pending', 'delivering', 'retry_wait', 'delivered', 'failed')),
        attempt_count INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL,
        receipt TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(result_event_id, destination_id)
      );
      INSERT INTO deliveries
      SELECT delivery_id, result_event_id, destination_id, destination_kind,
        destination_address_json, status, attempt_count, max_attempts,
        next_attempt_at, receipt, last_error, created_at, updated_at
      FROM _v48_deliveries;
      DROP TABLE _v48_deliveries;
      UPDATE schema_meta SET value = '${declaredVersion}' WHERE key = 'schema_version';
      `);
      database.close();

      assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 72);
      const runtime = new RuntimeStore(databasePath);
      try {
        const delivery = runtime.delivery(deliveryId)!;
        assert.deepEqual(delivery.origin, { kind: "event", id: eventId });
        assert.equal(delivery.resultEventId, eventId);
        assert.deepEqual(delivery.payload, {});
        assert.equal(delivery.status, "retry_wait");
        assert.equal(delivery.attemptCount, 2);
        assert.equal(delivery.maxAttempts, 5);
        assert.equal(delivery.receipt, "$receipt");
        assert.equal(delivery.lastError, "temporary");
      } finally {
        runtime.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function commandCallback(workspace: string): ProactiveCallbackDefinition {
  const script = join(workspace, "callback.mjs");
  const executable = realpathSync(process.execPath);
  writeFileSync(script, "process.stdout.write('callback');\n");
  return {
    callbackId: "command-1",
    kind: "command.exec",
    definition: {
      schemaVersion: "ProactiveCallbackDefinition@1",
      callbackId: "command-1",
      kind: "command.exec",
      runtime: "host",
      executable,
      argv: [script],
      cwd: workspace,
      environment: {},
      timeoutMilliseconds: 1_000,
      maxOutputBytes: 4_096
    },
    grant: {
      schemaVersion: "ProactiveCallbackGrant@1",
      kind: "command.exec",
      runtime: "host",
      executable,
      argv: [script],
      cwd: workspace,
      environment: {},
      filesystemRoots: [dirname(executable), workspace],
      networkAccess: true,
      timeoutMilliseconds: 1_000,
      maxOutputBytes: 4_096,
      secretReferences: []
    }
  };
}

function callbackRuntime(databasePath: string): ProactiveCallbackRuntime {
  return new ProactiveCallbackRuntime(databasePath, {
    ownerAdapters: proactiveCallbackOwnerAdapters(databasePath)
  });
}

function destinationCallback(): ProactiveCallbackDefinition {
  return {
    callbackId: "destination-1",
    kind: "destination.deliver",
    definition: {
      schemaVersion: "ProactiveCallbackDefinition@1",
      callbackId: "destination-1",
      kind: "destination.deliver",
      destinationId: "dst_019fa649-637b-7bf2-ad2b-a9b7be044fcd",
      destinationKind: "macos-notification",
      address: { channel: "owner" },
      payload: { title: "Done", body: "Inspect result" }
    },
    grant: {
      schemaVersion: "ProactiveCallbackGrant@1",
      kind: "destination.deliver",
      destinationId: "dst_019fa649-637b-7bf2-ad2b-a9b7be044fcd",
      destinationKind: "macos-notification",
      address: { channel: "owner" }
    }
  };
}

function agentCallback(agentId: string, workspace: string): ProactiveCallbackDefinition {
  return {
    callbackId: "agent-1",
    kind: "agent.invoke",
    definition: {
      schemaVersion: "ProactiveCallbackDefinition@1",
      callbackId: "agent-1",
      kind: "agent.invoke",
      agentId,
      workspace,
      prompt: "Inspect the observation"
    },
    grant: {
      schemaVersion: "ProactiveCallbackGrant@1",
      kind: "agent.invoke",
      agentId,
      workspace,
      workspaceAccess: "read",
      networkAccess: false
    }
  };
}
