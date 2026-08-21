import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ConnectorReadResult } from "@rollerskate/protocol";

import { recheckExternalRefTrigger } from
  "../src/application/external-resource/trigger-guard.js";
import { ScheduledTaskRuntime } from "../src/capabilities/scheduled-task/runtime.js";
import { ScheduledTaskStore } from "../src/capabilities/scheduled-task/store.js";
import { PollProbeExecutor } from "../src/capabilities/subscription/plugin-runner.js";
import { ContinuousSubscriptionRuntime } from
  "../src/capabilities/subscription/continuous-runtime.js";
import { ContinuousSubscriptionStore } from
  "../src/capabilities/subscription/continuous-store.js";
import { SubscriptionRuntime } from "../src/capabilities/subscription/runtime.js";
import { SubscriptionStore } from "../src/capabilities/subscription/store.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";
import type { ExternalRefTriggerBinding } from
  "../src/modules/external-resource/trigger-binding.js";

const AT = "2026-08-13T03:00:00.000Z";

test("ExternalRef guard fixes active Integration and provider revision", async () => {
  const binding = triggerBinding();
  const exact = await recheckExternalRefTrigger(binding, {
    client: authorityClient(),
    connectorRead: async () => readResult()
  });
  assert.equal(exact.status, "matched");

  const stale = await recheckExternalRefTrigger(binding, {
    client: authorityClient({ integrationRevision: 2 }),
    connectorRead: async () => readResult()
  });
  assert.deepEqual(stale, { status: "rejected", reason: "integration-binding-revision-stale" });

  const moved = await recheckExternalRefTrigger(binding, {
    client: authorityClient(),
    connectorRead: async () => ({
      ...readResult(),
      ref: { ...readResult().ref, revision: "vk1:changed" }
    })
  });
  assert.deepEqual(moved, { status: "rejected", reason: "external-ref-revision-stale" });
});

test("bound Schedule gates one occurrence and restart cannot duplicate its callback", async () => {
  const fixture = setup("schedule-exact");
  try {
    const schedule = fixture.schedules.create({
      ownerPrincipalId: fixture.agentId,
      agentId: fixture.agentId,
      kind: "once",
      expression: "2026-08-13T03:01:00.000Z",
      misfirePolicy: "run_once",
      overlapPolicy: "queue",
      misfireGraceMilliseconds: 60_000,
      sessionPolicy: "new_each_run",
      prompt: "Bound trigger",
      workspace: "/workspace",
      externalRefBinding: triggerBinding()
    }, AT);
    let reads = 0;
    const guard = async () => {
      reads += 1;
      return { status: "matched" as const, read: readResult() };
    };
    const firstRuntime = new ScheduledTaskRuntime({
      store: fixture.schedules,
      runtime: fixture.runtime,
      validateTarget: () => undefined,
      externalRefGuard: guard
    });
    const first = await firstRuntime.runCycle("2026-08-13T03:01:00.000Z");
    assert.equal(first.admitted.length, 1);
    assert.equal(reads, 1);
    const run = fixture.schedules.runs(schedule.definition.scheduleId)[0]!;
    assert.equal(fixture.schedules.callbackOccurrences(run).length, 1);

    fixture.schedules.close();
    fixture.runtime.close();
    const restoredStore = new ScheduledTaskStore(fixture.database);
    const restoredRuntimeStore = new RuntimeStore(fixture.database);
    const restored = new ScheduledTaskRuntime({
      store: restoredStore,
      runtime: restoredRuntimeStore,
      validateTarget: () => undefined,
      externalRefGuard: guard
    });
    const duplicate = await restored.runCycle("2026-08-13T03:01:01.000Z");
    assert.deepEqual(duplicate.admitted, []);
    assert.equal(reads, 1);
    assert.equal(restoredStore.callbackOccurrences(restoredStore.requireRun(run.runId)).length, 1);
    restoredStore.close();
    restoredRuntimeStore.close();
    fixture.closed = true;
  } finally {
    fixture.close();
  }
});

test("stale Schedule revision is durably skipped without callback admission", async () => {
  const fixture = setup("schedule-stale");
  try {
    const schedule = fixture.schedules.create({
      ownerPrincipalId: fixture.agentId,
      agentId: fixture.agentId,
      kind: "once",
      expression: "2026-08-13T03:01:00.000Z",
      misfirePolicy: "run_once",
      overlapPolicy: "queue",
      misfireGraceMilliseconds: 60_000,
      sessionPolicy: "new_each_run",
      prompt: "Bound trigger",
      workspace: "/workspace",
      externalRefBinding: triggerBinding()
    }, AT);
    const runtime = new ScheduledTaskRuntime({
      store: fixture.schedules,
      runtime: fixture.runtime,
      validateTarget: () => undefined,
      externalRefGuard: async () => ({
        status: "rejected",
        reason: "external-ref-revision-stale"
      })
    });
    const result = await runtime.runCycle("2026-08-13T03:01:00.000Z");
    assert.equal(result.skipped.length, 1);
    const run = fixture.schedules.runs(schedule.definition.scheduleId)[0]!;
    assert.equal(run.status, "skipped");
    assert.equal(run.decisionReason, "external-ref-trigger:external-ref-revision-stale");
    assert.deepEqual(fixture.schedules.callbackOccurrences(run), []);
  } finally {
    fixture.close();
  }
});

test("unbound Schedule preserves the legacy path without consulting the guard", async () => {
  const fixture = setup("schedule-unbound");
  try {
    fixture.schedules.create({
      ownerPrincipalId: fixture.agentId,
      agentId: fixture.agentId,
      kind: "once",
      expression: "2026-08-13T03:01:00.000Z",
      misfirePolicy: "run_once",
      overlapPolicy: "queue",
      misfireGraceMilliseconds: 60_000,
      sessionPolicy: "new_each_run",
      prompt: "Unbound trigger",
      workspace: "/workspace"
    }, AT);
    const runtime = new ScheduledTaskRuntime({
      store: fixture.schedules,
      runtime: fixture.runtime,
      validateTarget: () => undefined,
      externalRefGuard: async () => {
        throw new Error("unbound Schedule must not call the guard");
      }
    });
    assert.equal((await runtime.runCycle("2026-08-13T03:01:00.000Z")).admitted.length, 1);
  } finally {
    fixture.close();
  }
});

test("bound Subscription rechecks before probe and stale authority blocks durably", async () => {
  const fixture = setup("subscription");
  const pluginPath = join(fixture.directory, "probe.mjs");
  writeFileSync(pluginPath, `export default {
    kind: "subscription.probe", id: "bound", schemaVersion: 1,
    plan() { return { kind: "http", url: "https://probe.example/status" }; },
    evaluate() { return { version: "v1", facts: {}, terminal: "success" }; }
  };`);
  try {
    const store = new SubscriptionStore(fixture.database);
    const exact = store.create(subscriptionDefinition(fixture.agentId, pluginPath, "exact"), AT);
    const stale = store.create(subscriptionDefinition(fixture.agentId, pluginPath, "stale"), AT);
    store.close();
    let checks = 0;
    const runtime = new SubscriptionRuntime({
      databasePath: fixture.database,
      externalRefGuard: async (binding) => {
        checks += 1;
        return binding.ref.externalId === "42"
          ? { status: "matched", read: readResult() }
          : { status: "rejected", reason: "integration-binding-inactive" };
      },
      probeExecutor: new PollProbeExecutor({
        fetch: async () => Response.json({ ok: true })
      })
    });
    const result = await runtime.runCycle(
      new AbortController().signal,
      "2026-08-13T03:00:00.100Z"
    );
    assert.equal(checks, 2);
    assert.deepEqual(result.polled.sort(), [exact.subscriptionId, stale.subscriptionId].sort());
    const restored = new SubscriptionStore(fixture.database);
    assert.equal(restored.require(exact.subscriptionId).status, "completed");
    assert.equal(restored.require(stale.subscriptionId).status, "blocked");
    assert.equal(
      restored.require(stale.subscriptionId).latestError,
      "external-ref-trigger:integration-binding-inactive"
    );
    restored.close();
    await runtime.runCycle(new AbortController().signal, "2026-08-13T03:00:01.000Z");
    assert.equal(checks, 2);
  } finally {
    fixture.close();
  }
});

test("Continuous Subscription uses the same binding gate without materializing a delta", async () => {
  const fixture = setup("continuous-stale");
  try {
    const store = new ContinuousSubscriptionStore(fixture.database);
    const subscription = store.create({
      schemaVersion: "ContinuousSubscriptionDefinition@1",
      revision: 1,
      title: "Bound continuous probe",
      ownerAgentId: fixture.agentId,
      probe: {
        plugin: { path: "/missing/probe.mjs", id: "never-loaded", config: {} },
        policy: {
          workspaceRoot: "/workspace",
          allowedHttpOrigins: [],
          allowedExecutables: [],
          allowedEnvironment: [],
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096
        }
      },
      intervalMilliseconds: 100,
      callbacks: [agentCallback(fixture.agentId)],
      externalRefBinding: triggerBinding()
    }, AT);
    store.close();
    const runtime = new ContinuousSubscriptionRuntime({
      databasePath: fixture.database,
      externalRefGuard: async () => ({
        status: "rejected",
        reason: "integration-binding-revision-stale"
      })
    });
    const cycle = await runtime.runCycle(
      new AbortController().signal,
      "2026-08-13T03:00:00.100Z"
    );
    assert.deepEqual(cycle.failed, [subscription.subscriptionId]);
    assert.deepEqual(cycle.deltas, []);
    const restored = new ContinuousSubscriptionStore(fixture.database);
    assert.equal(restored.require(subscription.subscriptionId).status, "blocked");
    assert.deepEqual(restored.visibleCallbacks([subscription.subscriptionId]).get(
      subscription.subscriptionId
    ), []);
    restored.close();
  } finally {
    fixture.close();
  }
});

function setup(name: string): {
  readonly directory: string;
  readonly database: string;
  readonly agentId: string;
  readonly schedules: ScheduledTaskStore;
  readonly runtime: RuntimeStore;
  closed: boolean;
  readonly close: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), `rollerskate-external-trigger-${name}-`));
  const database = join(directory, "runtime.sqlite");
  const foundation = new LocalFoundationStore(database);
  const agent = foundation.addAgent(name, "codex", AT);
  foundation.close();
  const schedules = new ScheduledTaskStore(database);
  const runtime = new RuntimeStore(database);
  const fixture = {
    directory,
    database,
    agentId: agent.principalId,
    schedules,
    runtime,
    closed: false,
    close() {
      if (!fixture.closed) {
        schedules.close();
        runtime.close();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  };
  return fixture;
}

function triggerBinding(externalId = "42"): ExternalRefTriggerBinding {
  return {
    schemaVersion: "ExternalRefTriggerBinding@2",
    integrationBinding: { bindingId: "integration_binding_1", revision: 1 },
    ref: {
      schemaVersion: "ExternalRef@1",
      integrationBindingId: "integration_binding_1",
      kind: "work-item",
      externalId,
      revision: "vk1:expected"
    },
    profileId: "playground@1",
    schemaRef: "work-item.read@1"
  };
}

function readResult(): ConnectorReadResult {
  return {
    schemaVersion: "ConnectorReadResult@1",
    ref: triggerBinding().ref,
    profileId: "playground@1",
    schemaRef: "work-item.read@1",
    boundedPayload: { title: "Bound task" },
    payloadDigest: `sha256:${"a".repeat(64)}`,
    readAt: AT
  };
}

function authorityClient(options: { readonly integrationRevision?: number } = {}) {
  return {
    async integrationBinding() {
      return {
        schemaVersion: "IntegrationBinding@1" as const,
        bindingId: "integration_binding_1",
        ownerHumanId: "human_1",
        connectorId: "vikunja",
        connectorVersion: "1",
        placement: "runtime" as const,
        endpointRef: "http://127.0.0.1:3456",
        profileIds: ["playground@1"],
        externalScopeRef: "7",
        credentialRef: "secret://vikunja/test",
        status: "active" as const,
        revision: options.integrationRevision ?? 1,
        createdAt: AT,
        updatedAt: AT
      };
    }
  };
}

function subscriptionDefinition(agentId: string, pluginPath: string, kind: "exact" | "stale") {
  const callbacks: [] = [];
  return {
    schemaVersion: 3 as const,
    revision: `${kind}-v1`,
    title: `${kind} binding`,
    ownerAgentId: agentId,
    probe: {
      plugin: { path: pluginPath, id: "bound", schemaVersion: 1 as const, config: {} },
      artifactRevision: "fixture-v1",
      artifactDigest: `sha256:${"b".repeat(64)}`,
      policy: {
        workspaceRoot: "/workspace",
        allowedHttpOrigins: ["https://probe.example"],
        allowedExecutables: [],
        allowedEnvironment: [],
        timeoutMilliseconds: 1_000,
        maxOutputBytes: 4_096
      }
    },
    intervalMilliseconds: 100,
    maxWaitMilliseconds: 10_000,
    maxAttempts: 2,
    callbacks,
    approvedGrantDigest: createHash("sha256").update("[]").digest("base64url"),
    externalRefBinding: triggerBinding(kind === "exact" ? "42" : "43")
  };
}

function agentCallback(agentId: string) {
  return {
    callbackId: "agent-1",
    kind: "agent.invoke" as const,
    definition: {
      schemaVersion: "ProactiveCallbackDefinition@1" as const,
      callbackId: "agent-1",
      kind: "agent.invoke" as const,
      agentId,
      workspace: "/workspace",
      prompt: "Inspect the bound reference"
    },
    grant: {
      schemaVersion: "ProactiveCallbackGrant@1" as const,
      kind: "agent.invoke" as const,
      agentId,
      workspace: "/workspace",
      workspaceAccess: "read" as const,
      networkAccess: false
    }
  };
}
