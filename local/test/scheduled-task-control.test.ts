import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runScheduleCommand } from "../src/entrypoints/cli/schedule.js";
import { ScheduledTaskStore } from "../src/capabilities/scheduled-task/store.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";

test("Scheduled Task CLI closes legacy create and update before reading input", () => {
  for (const arguments_ of [
    ["create", "--help"],
    ["create", "/missing/schedule.json"],
    ["update", "sch_missing", "/missing/update.json"]
  ]) {
    assert.throws(
      () => runScheduleCommand("/missing", arguments_, { write() {} }, "/missing/runtime"),
      /legacy_trigger_write_closed.*RunIntent@1/
    );
  }
});

test("legacy Schedule remains readable and stoppable but cannot resume or run now", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-schedule-cutover-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-schedule-cutover-runtime-"));
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    bootstrapLocalFoundation(paths, "2026-08-26T10:00:00.000Z");
    const foundation = new LocalFoundationStore(paths.database);
    const owner = foundation.addAgent("legacy-owner", "codex", "2026-08-26T10:00:00.000Z");
    const workspace = foundation.foundation()!.workspacePath;
    foundation.close();
    const store = new ScheduledTaskStore(paths.database);
    const schedule = store.create({
      ownerPrincipalId: owner.principalId,
      agentId: owner.principalId,
      kind: "once",
      expression: "2099-08-26T10:00:00.000Z",
      misfirePolicy: "run_once",
      overlapPolicy: "queue",
      misfireGraceMilliseconds: 60_000,
      sessionPolicy: "new_each_run",
      prompt: "legacy readback",
      workspace
    }, "2026-08-26T10:00:00.000Z");
    store.close();
    const scheduleId = schedule.definition.scheduleId;

    let output = "";
    assert.equal(runScheduleCommand(
      repo,
      ["list"],
      { write(value) { output += value; } },
      runtimeDirectory
    ), 0);
    assert.equal((JSON.parse(output) as unknown[]).length, 1);

    assert.equal(runScheduleCommand(
      repo,
      ["pause", scheduleId],
      { write() {} },
      runtimeDirectory
    ), 0);
    assert.throws(() => runScheduleCommand(
      repo,
      ["resume", scheduleId],
      { write() {} },
      runtimeDirectory
    ), /legacy_trigger_execution_closed/);
    assert.throws(() => runScheduleCommand(
      repo,
      ["run-now", scheduleId, "--request-id", "legacy-manual"],
      { write() {} },
      runtimeDirectory
    ), /legacy_trigger_execution_closed/);
    assert.equal(runScheduleCommand(
      repo,
      ["cancel", scheduleId],
      { write() {} },
      runtimeDirectory
    ), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});
