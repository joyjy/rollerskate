import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { loadOwnerExternalWorkflowRegistry } from
  "../src/application/proactive/external-workflow-registry.js";
import { ExternalWorkflowRuntime } from
  "../src/application/proactive/external-workflow-runtime.js";
import { migrateLegacyScheduleToExternalWorkflow } from
  "../src/application/proactive/source-migration.js";
import { resolveUnknownScheduledRun } from
  "../src/application/schedule/control.js";
import { ScheduledTaskRuntime } from
  "../src/capabilities/scheduled-task/runtime.js";
import { ScheduledTaskStore } from
  "../src/capabilities/scheduled-task/store.js";
import { newScheduleId } from "../src/capabilities/scheduled-task/model.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { HostCallbackKernel } from "../src/infrastructure/callback/host-kernel.js";
import { ExternalWorkflowStore } from
  "../src/infrastructure/proactive/external-workflow-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { withImmediateTransaction } from
  "../src/infrastructure/sqlite/transaction.js";

test("external workflow runs once without Agent Event and keeps a durable receipt", async () => {
  const fixture = setup();
  try {
    const registry = loadOwnerExternalWorkflowRegistry(fixture.repo, fixture.runtimeDirectory);
    const workflows = new ExternalWorkflowStore(fixture.database);
    const schedules = new ScheduledTaskStore(fixture.database);
    const runtimeStore = new RuntimeStore(fixture.database);
    const scheduleId = newScheduleId();
    const target = registry.compileTarget("workflow:test/echo@1");
    withImmediateTransaction(fixture.database, () => schedules.createTargetedInTransaction({
      scheduleId,
      ownerPrincipalId: fixture.ownerAgentId,
      kind: "once",
      expression: "2026-09-03T01:00:00.000Z",
      misfirePolicy: "run_once",
      overlapPolicy: "skip",
      misfireGraceMilliseconds: 60_000,
      target
    }, "2026-09-03T00:59:00.000Z"));
    const scheduler = new ScheduledTaskRuntime({
      store: schedules,
      runtime: runtimeStore,
      validateTarget: () => undefined,
      externalWorkflows: workflows
    });
    const admitted = await scheduler.runCycle("2026-09-03T01:00:00.000Z");
    assert.equal(admitted.admitted.length, 1);
    const occurrence = schedules.requireRun(admitted.admitted[0]!);
    assert.equal(occurrence.status, "running");
    const external = new ExternalWorkflowRuntime({
      store: workflows,
      registry,
      executor: new HostCallbackKernel()
    });
    const controller = new AbortController();
    const claimed = external.poll(controller.signal, "2026-09-03T01:00:01.000Z");
    assert.equal(claimed.claimed.length, 1);
    const settled = await external.settle();
    assert.deepEqual(settled.succeeded, claimed.claimed);
    await scheduler.runCycle("2026-09-03T01:00:02.000Z");
    const terminal = schedules.requireRun(occurrence.runId);
    assert.equal(terminal.status, "succeeded");
    const execution = workflows.execution({
      kind: "schedule",
      id: scheduleId,
      definitionRevision: "ScheduleRevision@3:1"
    }, occurrence.occurrenceKey)!;
    assert.equal(execution.receipt?.status, "succeeded");
    assert.match(execution.receipt?.stdout ?? "", /request:ewx1_/);
    assert.equal(count(fixture.database, "events"), 0);
    assert.equal(count(fixture.database, "executions"), 0);
    schedules.close();
    runtimeStore.close();
  } finally {
    fixture.close();
  }
});

test("Owner workflow registry rejects loose permissions and executable drift", () => {
  const fixture = setup();
  try {
    chmodSync(fixture.paths.externalWorkflows, 0o644);
    assert.throws(
      () => loadOwnerExternalWorkflowRegistry(fixture.repo, fixture.runtimeDirectory),
      /mode-0600/
    );
    chmodSync(fixture.paths.externalWorkflows, 0o600);
    const registry = loadOwnerExternalWorkflowRegistry(
      fixture.repo,
      fixture.runtimeDirectory
    );
    const target = registry.compileTarget("workflow:test/echo@1");
    writeFileSync(join(fixture.runtimeDirectory, "workflow.sh"), "#!/bin/sh\nexit 0\n");
    assert.throws(() => registry.resolve(target), /changed after registration load/);
  } finally {
    fixture.close();
  }
});

test("pre-effect interruption retries but post-effect interruption becomes manual unknown", () => {
  const fixture = setup();
  try {
    const registry = loadOwnerExternalWorkflowRegistry(fixture.repo, fixture.runtimeDirectory);
    const store = new ExternalWorkflowStore(fixture.database);
    const target = registry.compileTarget("workflow:test/echo@1");
    const source = {
      kind: "schedule" as const,
      id: newScheduleId(),
      definitionRevision: "ScheduleRevision@3:1"
    };
    withImmediateTransaction(fixture.database, () => store.enqueueInTransaction({
      target,
      source,
      occurrenceKey: "manual:recovery",
      observation: {},
      at: "2026-09-03T02:00:00.000Z"
    }));
    const first = store.claimDue("test-owner", "2026-09-03T02:00:00.000Z")[0]!;
    const retried = store.failBeforeEffect(
      first.execution.executionId,
      "test-owner",
      first.leaseToken,
      "registry temporarily unavailable",
      1_000,
      "2026-09-03T02:00:00.100Z"
    );
    assert.equal(retried.status, "retry_wait");
    const second = store.claimDue("test-owner", "2026-09-03T02:00:01.100Z")[0]!;
    store.markEffectStarted(
      second.execution.executionId,
      "test-owner",
      second.leaseToken,
      "2026-09-03T02:00:01.200Z"
    );
    const recovered = store.recoverInterrupted("2026-09-03T02:00:02.000Z");
    assert.deepEqual(recovered.unknown, [second.execution.executionId]);
    assert.equal(store.claimDue("another-owner", "2026-09-03T03:00:00.000Z").length, 0);
    const unknown = store.execution(source, "manual:recovery")!;
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.receipt?.status, "unknown");
    const resolved = store.resolveUnknown(
      unknown.executionId,
      "succeeded",
      "Verified from the owner LWW",
      "2026-09-03T02:01:00.000Z"
    );
    assert.equal(resolved.status, "succeeded");
    assert.equal(resolved.receipt?.resolution, "manual");
    assert.equal(resolved.unknownReceipt?.status, "unknown");
  } finally {
    fixture.close();
  }
});

test("Schedule unknown resolution commits workflow and parent receipts atomically", async () => {
  const fixture = setup();
  try {
    const registry = loadOwnerExternalWorkflowRegistry(fixture.repo, fixture.runtimeDirectory);
    const store = new ExternalWorkflowStore(fixture.database);
    const schedules = new ScheduledTaskStore(fixture.database);
    const runtimeStore = new RuntimeStore(fixture.database);
    const scheduleId = newScheduleId();
    withImmediateTransaction(fixture.database, () => schedules.createTargetedInTransaction({
      scheduleId,
      ownerPrincipalId: fixture.ownerAgentId,
      kind: "once",
      expression: "2026-09-03T03:00:00.000Z",
      misfirePolicy: "run_once",
      overlapPolicy: "skip",
      misfireGraceMilliseconds: 60_000,
      target: registry.compileTarget("workflow:test/echo@1")
    }, "2026-09-03T02:59:00.000Z"));
    const scheduler = new ScheduledTaskRuntime({
      store: schedules,
      runtime: runtimeStore,
      validateTarget: () => undefined,
      externalWorkflows: store
    });
    const admitted = await scheduler.runCycle("2026-09-03T03:00:00.000Z");
    const occurrence = schedules.requireRun(admitted.admitted[0]!);
    const claimed = store.claimDue("test-owner", "2026-09-03T03:00:01.000Z")[0]!;
    store.markEffectStarted(
      claimed.execution.executionId,
      "test-owner",
      claimed.leaseToken,
      "2026-09-03T03:00:01.100Z"
    );
    store.recoverInterrupted("2026-09-03T03:00:02.000Z");
    await scheduler.runCycle("2026-09-03T03:00:03.000Z");
    const resolved = resolveUnknownScheduledRun(
      fixture.repo,
      occurrence.runId,
      "succeeded",
      fixture.runtimeDirectory,
      "2026-09-03T03:01:00.000Z"
    );
    assert.equal(resolved.run.status, "succeeded");
    assert.equal(resolved.externalWorkflowExecution?.receipt?.resolution, "manual");
    assert.equal(resolved.externalWorkflowExecution?.unknownReceipt?.status, "unknown");
    schedules.close();
    runtimeStore.close();
  } finally {
    fixture.close();
  }
});

test("paused legacy Schedule migrates idempotently to an Owner workflow target", () => {
  const fixture = setup();
  try {
    const schedules = new ScheduledTaskStore(fixture.database);
    const schedule = schedules.create({
      ownerPrincipalId: fixture.ownerAgentId,
      agentId: fixture.ownerAgentId,
      kind: "cron",
      expression: "0 9,18 * * *",
      timezone: "Asia/Shanghai",
      misfirePolicy: "skip",
      overlapPolicy: "skip",
      misfireGraceMilliseconds: 900_000,
      sessionPolicy: "new_each_run",
      prompt: "legacy compatibility metadata",
      workspace: fixture.paths.workspace
    }, "2026-09-03T00:00:00.000Z");
    schedules.setStatus(schedule.definition.scheduleId, "pause", "2026-09-03T00:01:00.000Z");
    schedules.close();
    fixture.database.close();
    const input = {
      scheduleId: schedule.definition.scheduleId,
      expectedRevision: 1,
      workflowRef: "workflow:test/echo@1",
      requestId: "migrate-test-echo-v1"
    };
    const migrated = migrateLegacyScheduleToExternalWorkflow(
      fixture.repo,
      input,
      fixture.runtimeDirectory,
      "2026-09-03T00:02:00.000Z"
    );
    const duplicate = migrateLegacyScheduleToExternalWorkflow(
      fixture.repo,
      input,
      fixture.runtimeDirectory,
      "2026-09-03T00:03:00.000Z"
    );
    assert.equal(migrated.status, "migrated");
    assert.equal(migrated.schedule.definition.status, "paused");
    assert.equal(migrated.schedule.definition.currentRevision, 2);
    assert.equal(migrated.schedule.revision.schemaVersion, "ScheduleRevision@3");
    assert.equal(migrated.schedule.revision.schemaVersion === "ScheduleRevision@3"
      ? migrated.schedule.revision.target.kind
      : undefined, "external_workflow");
    assert.equal(duplicate.status, "duplicate");
    assert.deepEqual(duplicate.receipt, migrated.receipt);
  } finally {
    fixture.close(false);
  }
});

function setup() {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-workflow-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-workflow-runtime-"));
  const paths = runtimePaths(repo, runtimeDirectory);
  mkdirSync(paths.workspace, { recursive: true });
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths, "2026-09-03T00:00:00.000Z");
  const foundation = new LocalFoundationStore(paths.database);
  foundation.addAgent("workflow-owner", "codex", "2026-09-03T00:00:00.000Z");
  const ownerAgentId = foundation.agentByHandle("workflow-owner")!.principalId;
  foundation.close();
  const executable = join(runtimeDirectory, "workflow.sh");
  writeFileSync(executable, [
    "#!/bin/sh",
    "printf 'request:%s\\n' \"$ROLLERSKATE_WORKFLOW_REQUEST_ID\""
  ].join("\n"));
  chmodSync(executable, 0o700);
  writeFileSync(paths.externalWorkflows, `${JSON.stringify({
    schemaVersion: "OwnerExternalWorkflowRegistry@1",
    workflows: [{
      schemaVersion: "OwnerExternalWorkflowRegistration@1",
      ref: "workflow:test/echo@1",
      inputSchema: "EmptyInput@1",
      fixedInput: {},
      command: {
        executable: pathToFileURL(executable).href,
        arguments: [],
        cwd: pathToFileURL(runtimeDirectory).href,
        environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        timeoutMilliseconds: 10_000,
        maxOutputBytes: 16_384
      },
      authority: {
        filesystemRoots: [
          pathToFileURL(runtimeDirectory).href,
          pathToFileURL(dirname(executable)).href
        ],
        networkAccess: true
      },
      retry: { maxAttempts: 2, backoffMilliseconds: 1_000 }
    }]
  }, null, 2)}\n`);
  chmodSync(paths.externalWorkflows, 0o600);
  const database = openRuntimeDatabase(paths.database);
  return {
    repo,
    runtimeDirectory,
    paths,
    database,
    ownerAgentId,
    close(closeDatabase = true) {
      if (closeDatabase) {
        try {
          database.close();
        } catch {
          // The migration test closes this shared handle before opening the application seam.
        }
      }
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
