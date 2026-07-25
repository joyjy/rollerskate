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
