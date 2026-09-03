import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DeterministicApplicationActionRegistry,
  type DeterministicApplicationActionRegistration
} from "../src/application/proactive/action-registry.js";
import { OwnerProactiveSourceCompiler } from
  "../src/application/proactive/source-compiler.js";
import { ScheduledTaskRuntime } from
  "../src/capabilities/scheduled-task/runtime.js";
import { ScheduledTaskStore } from
  "../src/capabilities/scheduled-task/store.js";
import { newScheduleId } from "../src/capabilities/scheduled-task/model.js";
import { SubscriptionStore } from "../src/capabilities/subscription/store.js";
import { ContinuousSubscriptionStore } from
  "../src/capabilities/subscription/continuous-store.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { withImmediateTransaction } from
  "../src/infrastructure/sqlite/transaction.js";
import { localId } from "../src/core/id.js";

test("Schedule application action terminalizes once without Agent Execution", async () => {
  const fixture = setup();
  try {
    const { registry, effects } = actionRegistry(fixture.database);
    const schedules = new ScheduledTaskStore(fixture.database);
    const runtime = new RuntimeStore(fixture.database);
    const scheduleId = newScheduleId();
    const target = registry.compileTarget("action:test/record@1", { value: "schedule" });
    const scheduleInput = {
      scheduleId,
      ownerPrincipalId: fixture.ownerAgentId,
      kind: "once",
      expression: "2026-09-03T01:00:00.000Z",
      misfirePolicy: "run_once",
      overlapPolicy: "skip",
      misfireGraceMilliseconds: 60_000,
      target
    } as const;
    withImmediateTransaction(fixture.database, () => {
      schedules.createTargetedInTransaction(scheduleInput, "2026-09-03T00:59:00.000Z");
      schedules.createTargetedInTransaction(scheduleInput, "2026-09-03T00:59:01.000Z");
    });
    assert.equal(count(fixture.database, "schedules"), 1);
    const scheduler = new ScheduledTaskRuntime({
      store: schedules,
      runtime,
      validateTarget: () => undefined,
      applicationActions: registry
    });
    const result = await scheduler.runCycle("2026-09-03T01:00:00.000Z");
    assert.equal(result.admitted.length, 1);
    const occurrence = schedules.requireRun(result.admitted[0]!);
    assert.equal(occurrence.status, "succeeded");
    assert.equal(schedules.actionReceipt(occurrence)?.status, "succeeded");
    assert.deepEqual(effects(), ["schedule"]);
    assert.equal(count(fixture.database, "events"), 0);
    assert.equal(count(fixture.database, "executions"), 0);
    await scheduler.runCycle("2026-09-03T01:00:01.000Z");
    assert.deepEqual(effects(), ["schedule"]);
    schedules.close();
    runtime.close();
  } finally {
    fixture.close();
  }
});

test("one-shot and continuous application actions own terminal checkpoint state", () => {
  const fixture = setup();
  try {
    const { registry, effects } = actionRegistry(fixture.database);
    const oneShot = new SubscriptionStore(fixture.database, {
      applicationActions: registry
    });
    const continuous = new ContinuousSubscriptionStore(fixture.database, {
      applicationActions: registry
    });
    const schedules = new ScheduledTaskStore(fixture.database);
    const compiler = new OwnerProactiveSourceCompiler({
      database: fixture.database,
      actions: registry,
      schedules,
      oneShot,
      continuous
    });
    const oneShotId = localId("sub");
    const continuousId = localId("sub");
    const oneShotIntent = {
      kind: "subscription",
      action: { actionRef: "action:test/record@1", input: { value: "one-shot" } },
      source: {
        schemaVersion: "SubscriptionDefinition@5",
        subscriptionId: oneShotId,
        revision: "1",
        title: "one shot action",
        probe: probe(),
        intervalMilliseconds: 100,
        maxWaitMilliseconds: 1_000,
        maxAttempts: 3
      }
    } as const;
    const continuousIntent = {
      kind: "continuous_subscription",
      action: { actionRef: "action:test/record@1", input: { value: "continuous" } },
      source: {
        schemaVersion: "ContinuousSubscriptionDefinition@3",
        subscriptionId: continuousId,
        revision: 1,
        title: "continuous action",
        probe: {
          plugin: { path: "/test/plugin.mjs", id: "test", config: {} },
          policy: probe().policy
        },
        intervalMilliseconds: 100
      }
    } as const;
    compiler.compile(oneShotIntent, "2026-09-03T02:00:00.000Z");
    compiler.compile(continuousIntent, "2026-09-03T02:00:00.000Z");
    compiler.compile(oneShotIntent, "2026-09-03T02:00:01.000Z");
    compiler.compile(continuousIntent, "2026-09-03T02:00:01.000Z");
    assert.equal(count(fixture.database, "subscriptions"), 1);
    assert.equal(count(fixture.database, "continuous_subscriptions"), 1);
    const terminal = oneShot.recordObservation(oneShotId, observation("terminal", true),
      "2026-09-03T02:00:01.000Z");
    assert.equal(terminal.status, "completed");
    assert.equal(terminal.actionReceipt?.status, "succeeded");
    const first = continuous.recordObservation(
      continuousId,
      observation("delta-1", false),
      "2026-09-03T02:00:01.000Z"
    ).subscription;
    assert.equal(first.checkpointOccurrenceKey, "delta-1");
    assert.equal(first.pendingOccurrenceKey, undefined);
    assert.equal(first.latestActionReceipt?.status, "succeeded");
    continuous.recordObservation(
      continuousId,
      observation("delta-1", false),
      "2026-09-03T02:00:02.000Z"
    );
    assert.deepEqual(effects(), ["one-shot", "continuous"]);
    assert.equal(count(fixture.database, "events"), 0);
    assert.equal(count(fixture.database, "executions"), 0);
    oneShot.close();
    continuous.close();
    schedules.close();
  } finally {
    fixture.close();
  }
});

function probe() {
  return {
    plugin: {
      path: "/test/plugin.mjs",
      id: "test",
      schemaVersion: 1 as const,
      config: {},
      artifactRevision: "test@1",
      artifactDigest: `sha256:${"a".repeat(64)}`
    },
    policy: {
      workspaceRoot: "/test",
      allowedHttpOrigins: [] as string[],
      allowedExecutables: [] as string[],
      allowedEnvironment: [] as string[],
      timeoutMilliseconds: 1_000,
      maxOutputBytes: 1_024
    },
    artifactRevision: "test@1",
    artifactDigest: `sha256:${"a".repeat(64)}`
  };
}

function observation(occurrenceKey: string, terminal: boolean) {
  return {
    version: "test@1",
    occurrenceKey,
    facts: { occurrenceKey },
    terminal: terminal ? "success" as const : null
  };
}

function actionRegistry(database: ReturnType<typeof openRuntimeDatabase>) {
  const recorded: string[] = [];
  const registration: DeterministicApplicationActionRegistration = {
    ref: "action:test/record@1",
    inputSchema: "TestRecordInput@1",
    parseInput(value) {
      const input = value as { readonly value?: unknown };
      if (typeof input.value !== "string") throw new Error("value is required");
      return { value: input.value };
    },
    executeInTransaction({ actionInput }) {
      const input = actionInput as { readonly value: string };
      recorded.push(input.value);
      return { status: "succeeded", output: { value: input.value } };
    }
  };
  return {
    registry: new DeterministicApplicationActionRegistry(database, [registration]),
    effects: () => [...recorded]
  };
}

function setup() {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-target-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-target-runtime-"));
  const paths = runtimePaths(repo, runtimeDirectory);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths, "2026-09-03T00:00:00.000Z");
  const foundation = new LocalFoundationStore(paths.database);
  foundation.addAgent("owner-action", "codex", "2026-09-03T00:00:00.000Z");
  const ownerAgentId = foundation.agentByHandle("owner-action")!.principalId;
  foundation.close();
  const database = openRuntimeDatabase(paths.database);
  return {
    database,
    ownerAgentId,
    close() {
      database.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  };
}

function count(database: ReturnType<typeof openRuntimeDatabase>, table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number | bigint;
  }).count);
}
