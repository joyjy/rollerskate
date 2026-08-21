import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { runScheduleCommand } from "../src/entrypoints/cli/schedule.js";
import { ScheduledTaskStore } from "../src/capabilities/scheduled-task/store.js";
import { CallbackStore } from "../src/infrastructure/callback/store.js";

test("Scheduled Task CLI help exposes the host command callback boundary", () => {
  let output = "";
  assert.equal(runScheduleCommand(
    "/does/not/need/to/exist",
    ["create", "--help"],
    { write(text) { output += text; } }
  ), 0);
  assert.match(output, /runtime must be "host"/);
  assert.match(output, /may start transitive child processes/);
  assert.match(output, /legacy runtime: "node" callbacks remain readable/);
});

test("Scheduled Task CLI provides a complete durable control and trace surface", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-schedule-cli-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-schedule-cli-runtime-"));
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    initializeRuntimeSchema(paths.database);
    bootstrapLocalFoundation(paths, "2026-07-24T00:00:00.000Z");
    const foundation = new LocalFoundationStore(paths.database);
    foundation.addAgent("alice", "codex", "2026-07-24T00:00:00.000Z");
    foundation.close();

    const createFile = join(repo, "schedule.json");
    writeFileSync(createFile, JSON.stringify({
      schemaVersion: 1,
      agent: "alice",
      kind: "once",
      expression: "2099-07-24T01:00:00.000Z",
      misfirePolicy: "run_once",
      overlapPolicy: "queue",
      misfireGraceMilliseconds: 60_000,
      session: { policy: "new_each_run" },
      prompt: "Run report"
    }));
    const created = command(repo, runtimeDirectory, ["create", createFile]) as {
      summary: {
        scheduleId: string;
        currentRevision: number;
        agent: { handle: string };
      };
      agent: { handle: string };
    };
    const scheduleId = created.summary.scheduleId;
    assert.equal(created.summary.agent.handle, "alice");
    assert.match(scheduleId, /^sch_/);

    const runNow = command(repo, runtimeDirectory, [
      "run-now",
      scheduleId,
      "--request-id",
      "cli-smoke-1"
    ]) as { status: string; run: { runId: string; occurrenceKey: string } };
    const duplicate = command(repo, runtimeDirectory, [
      "run-now",
      scheduleId,
      "--request-id",
      "cli-smoke-1"
    ]) as { status: string; run: { runId: string } };
    assert.equal(runNow.status, "accepted");
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.run.runId, runNow.run.runId);
    assert.equal(runNow.run.occurrenceKey, "manual:cli-smoke-1");
    const scheduleStore = new ScheduledTaskStore(paths.database);
    scheduleStore.patchRun(runNow.run.runId, {
      status: "unknown",
      decisionReason: "provider-outcome-unknown"
    });
    scheduleStore.close();
    const resolved = command(repo, runtimeDirectory, [
      "resolve",
      runNow.run.runId,
      "succeeded"
    ]) as { status: string; decisionReason: string };
    assert.equal(resolved.status, "succeeded");
    assert.equal(resolved.decisionReason, "manual-resolved-succeeded");

    const updateFile = join(repo, "schedule-update.json");
    writeFileSync(updateFile, JSON.stringify({
      schemaVersion: 1,
      expectedRevision: 1,
      agent: "alice",
      kind: "once",
      expression: "2099-07-25T01:00:00.000Z",
      misfirePolicy: "skip",
      overlapPolicy: "queue",
      misfireGraceMilliseconds: 120_000,
      session: { policy: "new_each_run" },
      prompt: "Updated report"
    }));
    const updated = command(repo, runtimeDirectory, [
      "update",
      scheduleId,
      updateFile
    ]) as {
      summary: { currentRevision: number };
      revision: { prompt: string };
    };
    assert.equal(updated.summary.currentRevision, 2);
    assert.equal(updated.revision.prompt, "Updated report");

    const listed = command(repo, runtimeDirectory, ["list"]) as unknown[];
    const runs = command(repo, runtimeDirectory, ["runs", scheduleId]) as Array<{
      runId: string;
    }>;
    const limitedRuns = command(
      repo,
      runtimeDirectory,
      ["runs", scheduleId, "--limit", "1"]
    ) as Array<{ runId: string }>;
    const traced = command(repo, runtimeDirectory, [
      "trace",
      runNow.run.runId
    ]) as { runId: string; audit: unknown | null };
    assert.equal(listed.length, 1);
    assert.equal(runs.length, 1);
    assert.equal(limitedRuns.length, 1);
    assert.equal(limitedRuns[0]?.runId, runNow.run.runId);
    assert.equal(traced.runId, runNow.run.runId);
    assert.equal(traced.audit, null);

    const paused = command(repo, runtimeDirectory, ["pause", scheduleId]) as {
      summary: { status: string };
    };
    const resumed = command(repo, runtimeDirectory, ["resume", scheduleId]) as {
      summary: { status: string };
    };
    const cancelled = command(repo, runtimeDirectory, ["cancel", scheduleId]) as {
      summary: { status: string };
    };
    const cancelledAgain = command(repo, runtimeDirectory, ["cancel", scheduleId]) as {
      summary: { status: string };
    };
    const duplicateAfterCancel = command(repo, runtimeDirectory, [
      "run-now",
      scheduleId,
      "--request-id",
      "cli-smoke-1"
    ]) as { status: string; run: { runId: string } };
    assert.equal(paused.summary.status, "paused");
    assert.equal(resumed.summary.status, "active");
    assert.equal(cancelled.summary.status, "cancelled");
    assert.equal(cancelledAgain.summary.status, "cancelled");
    assert.equal(duplicateAfterCancel.status, "duplicate");
    assert.equal(duplicateAfterCancel.run.runId, runNow.run.runId);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("Scheduled Task CLI rejects implicit timezones and unstable run-now requests", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-schedule-cli-validation-repo-"));
  const file = join(repo, "invalid.json");
  try {
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      agent: "alice",
      kind: "cron",
      expression: "0 9 * * *",
      misfirePolicy: "skip",
      overlapPolicy: "skip",
      misfireGraceMilliseconds: 0,
      session: { policy: "new_each_run" },
      prompt: "Run"
    }));
    assert.throws(
      () => runScheduleCommand(repo, ["create", file], { write() {} }, repo),
      /cron schedule requires timezone/
    );
    assert.throws(
      () => runScheduleCommand(repo, ["run-now", "sch_bad"], { write() {} }, repo),
      /--request-id/
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Scheduled Task CLI schemaVersion 2 accepts ordered free callbacks", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-schedule-v2-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-schedule-v2-runtime-"));
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    bootstrapLocalFoundation(paths, "2026-07-28T00:00:00.000Z");
    const foundation = new LocalFoundationStore(paths.database);
    foundation.addAgent("alice", "codex", "2026-07-28T00:00:00.000Z");
    foundation.close();
    const file = join(repo, "schedule-v2.json");
    writeFileSync(file, JSON.stringify({
      schemaVersion: 2,
      agent: "alice",
      kind: "once",
      expression: "2099-07-28T01:00:00.000Z",
      misfirePolicy: "run_once",
      overlapPolicy: "queue",
      misfireGraceMilliseconds: 60_000,
      session: { policy: "new_each_run" },
      prompt: "Compatibility metadata",
      callbacks: [{
        callbackId: "notify",
        kind: "destination.deliver",
        definition: {
          schemaVersion: "ProactiveCallbackDefinition@1",
          callbackId: "notify",
          kind: "destination.deliver",
          destinationId: "dst_019fa649-637b-7bf2-ad2b-a9b7be044fcd",
          destinationKind: "macos-notification",
          address: { channel: "owner" },
          payload: { title: "Scheduled", body: "Done" }
        },
        grant: {
          schemaVersion: "ProactiveCallbackGrant@1",
          kind: "destination.deliver",
          destinationId: "dst_019fa649-637b-7bf2-ad2b-a9b7be044fcd",
          destinationKind: "macos-notification",
          address: { channel: "owner" }
        }
      }]
    }));
    const created = command(repo, runtimeDirectory, ["create", file]) as {
      revision: { callbacks: Array<{ kind: string }> };
    };
    assert.deepEqual(created.revision.callbacks.map(({ kind }) => kind), [
      "destination.deliver"
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("manual unknown resolution atomically resolves Schedule callback children and exposes receipts", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-schedule-resolve-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-schedule-resolve-runtime-"));
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    bootstrapLocalFoundation(paths, "2026-07-28T00:00:00.000Z");
    const foundation = new LocalFoundationStore(paths.database);
    const agent = foundation.addAgent("alice", "codex", "2026-07-28T00:00:00.000Z");
    const workspace = foundation.foundation()!.workspacePath;
    foundation.close();
    const schedules = new ScheduledTaskStore(paths.database);
    const callbacks = new CallbackStore(paths.database);
    let runId = "";
    try {
      const schedule = schedules.create({
        ownerPrincipalId: agent.principalId,
        agentId: agent.principalId,
        kind: "once",
        expression: "2099-07-28T01:00:00.000Z",
        misfirePolicy: "run_once",
        overlapPolicy: "queue",
        misfireGraceMilliseconds: 60_000,
        sessionPolicy: "new_each_run",
        prompt: "Compatibility metadata",
        workspace,
        callbacks: [{
          callbackId: "notify",
          kind: "destination.deliver",
          definition: {
            schemaVersion: "ProactiveCallbackDefinition@1",
            callbackId: "notify",
            kind: "destination.deliver",
            destinationId: "dst_019fa649-637b-7bf2-ad2b-a9b7be044fcd",
            destinationKind: "macos-notification",
            address: { channel: "owner" },
            payload: { title: "Scheduled", body: "Done" }
          },
          grant: {
            schemaVersion: "ProactiveCallbackGrant@1",
            kind: "destination.deliver",
            destinationId: "dst_019fa649-637b-7bf2-ad2b-a9b7be044fcd",
            destinationKind: "macos-notification",
            address: { channel: "owner" }
          }
        }]
      }, "2026-07-28T00:00:00.000Z");
      const run = schedules.insertRun({
        scheduleId: schedule.definition.scheduleId,
        occurrenceKey: "manual:resolve",
        scheduledFor: "2026-07-28T00:00:01.000Z",
        scheduleRevision: schedule.definition.currentRevision,
        status: "queued"
      }).run;
      runId = run.runId;
      schedules.admitCallbackRun(runId, "2026-07-28T00:00:01.000Z");
      callbacks.beginNext({
        ownerKind: "schedule",
        ownerId: schedule.definition.scheduleId,
        triggerOccurrenceKey: runId
      }, "2026-07-28T00:00:02.000Z");
      assert.equal(callbacks.reconcileInterrupted("2026-07-28T00:00:03.000Z"), 1);
      schedules.patchRun(runId, {
        status: "unknown",
        decisionReason: "provider-outcome-unknown"
      }, "2026-07-28T00:00:03.000Z");
    } finally {
      callbacks.close();
      schedules.close();
    }
    const resolved = command(repo, runtimeDirectory, ["resolve", runId, "succeeded"]) as {
      status: string;
      callbacks: Array<{
        status: string;
        phase: string;
        receipt: { resolution: string; priorStatus: string };
      }>;
    };
    assert.equal(resolved.status, "succeeded");
    assert.deepEqual(resolved.callbacks.map(({ status, phase }) => ({ status, phase })), [
      { status: "succeeded", phase: "terminal" }
    ]);
    assert.equal(resolved.callbacks[0]!.receipt.resolution, "manual");
    assert.equal(resolved.callbacks[0]!.receipt.priorStatus, "unknown");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

function command(
  repo: string,
  runtimeDirectory: string,
  arguments_: readonly string[]
): unknown {
  let output = "";
  assert.equal(runScheduleCommand(
    repo,
    arguments_,
    { write(text) { output += text; } },
    runtimeDirectory
  ), 0);
  return JSON.parse(output) as unknown;
}
