import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";
import type {
  CreateScheduleInput,
  UpdateScheduleInput
} from "../src/capabilities/scheduled-task/model.js";
import { ScheduledTaskStore } from "../src/capabilities/scheduled-task/store.js";
import { RuntimeStore } from "../src/core/runtime/store.js";

test("Schedule keeps only the current definition and update uses compare-and-swap", () => {
  const fixture = setup();
  const store = new ScheduledTaskStore(fixture.database);
  try {
    const created = store.create(
      scheduleInput(fixture.agentId),
      "2026-07-24T00:00:00.000Z"
    );
    assert.equal(created.definition.currentRevision, 1);
    assert.equal(created.definition.nextRunAt, "2026-07-24T01:00:00.000Z");
    assert.equal(created.revision.expressionVersion, "cron-v1");

    const updated = store.update(created.definition.scheduleId, {
      ...revisionInput(fixture.agentId),
      expectedRevision: 1,
      prompt: "Updated prompt"
    }, "2026-07-24T00:30:00.000Z");
    assert.equal(updated.definition.currentRevision, 2);
    assert.equal(updated.revision.prompt, "Updated prompt");
    assert.throws(
      () => store.requireRevision(created.definition.scheduleId, 1),
      /not current and has no run snapshot/
    );
    assert.throws(
      () => store.update(created.definition.scheduleId, {
        ...revisionInput(fixture.agentId),
        expectedRevision: 1
      }, "2026-07-24T00:31:00.000Z"),
      /revision conflict/
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("ScheduledRun occurrence admission is unique and history survives cancel", () => {
  const fixture = setup();
  const store = new ScheduledTaskStore(fixture.database);
  try {
    const schedule = store.create(
      scheduleInput(fixture.agentId),
      "2026-07-24T00:00:00.000Z"
    );
    const input = {
      scheduleId: schedule.definition.scheduleId,
      occurrenceKey: schedule.definition.nextOccurrenceKey!,
      scheduledFor: schedule.definition.nextRunAt!,
      scheduleRevision: 1,
      status: "queued" as const,
      admittedAt: "2026-07-24T01:00:00.000Z",
      createdAt: "2026-07-24T01:00:00.000Z"
    };
    const first = store.insertRun(input);
    const duplicate = store.insertRun(input);
    assert.equal(first.status, "accepted");
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.run.runId, first.run.runId);

    store.setStatus(schedule.definition.scheduleId, "cancel", "2026-07-24T01:01:00.000Z");
    store.setStatus(schedule.definition.scheduleId, "cancel", "2026-07-24T01:02:00.000Z");
    assert.equal(store.require(schedule.definition.scheduleId).definition.status, "cancelled");
    assert.equal(store.runs(schedule.definition.scheduleId).length, 1);
  } finally {
    store.close();
    fixture.close();
  }
});

test("target replacement is rejected while a run is unterminated", () => {
  const fixture = setup();
  const store = new ScheduledTaskStore(fixture.database);
  try {
    const schedule = store.create(
      scheduleInput(fixture.agentId),
      "2026-07-24T00:00:00.000Z"
    );
    store.insertRun({
      scheduleId: schedule.definition.scheduleId,
      occurrenceKey: schedule.definition.nextOccurrenceKey!,
      scheduledFor: schedule.definition.nextRunAt!,
      scheduleRevision: 1,
      status: "running",
      createdAt: "2026-07-24T01:00:00.000Z"
    });
    const replacement: UpdateScheduleInput = {
      ...revisionInput(fixture.agentId),
      expectedRevision: 1,
      workspace: "/different"
    };
    assert.throws(
      () => store.update(schedule.definition.scheduleId, replacement),
      /target cannot change/
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("pause and resume deliberately calculate from resume time", () => {
  const fixture = setup();
  const store = new ScheduledTaskStore(fixture.database);
  try {
    const schedule = store.create(
      scheduleInput(fixture.agentId),
      "2026-07-24T00:00:00.000Z"
    );
    store.setStatus(schedule.definition.scheduleId, "pause", "2026-07-24T00:30:00.000Z");
    const resumed = store.setStatus(
      schedule.definition.scheduleId,
      "resume",
      "2026-07-24T03:30:00.000Z"
    );
    assert.equal(resumed.definition.nextRunAt, "2026-07-24T04:00:00.000Z");
  } finally {
    store.close();
    fixture.close();
  }
});

test("stale due admission and advance cannot overwrite a newer revision", () => {
  const fixture = setup();
  const store = new ScheduledTaskStore(fixture.database);
  try {
    const original = store.create(
      scheduleInput(fixture.agentId),
      "2026-07-24T00:00:00.000Z"
    );
    const updated = store.update(original.definition.scheduleId, {
      ...revisionInput(fixture.agentId),
      expectedRevision: 1,
      expression: "30 * * * *"
    }, "2026-07-24T00:30:00.000Z");
    assert.equal(updated.definition.nextRunAt, "2026-07-24T01:30:00.000Z");
    assert.throws(() => store.insertDueRun({
      scheduleId: original.definition.scheduleId,
      occurrenceKey: original.definition.nextOccurrenceKey!,
      scheduledFor: original.definition.nextRunAt!,
      scheduleRevision: 1,
      status: "queued",
      createdAt: "2026-07-24T01:00:00.000Z"
    }), /occurrence changed before admission/);
    store.advanceExpected(
      original.definition.scheduleId,
      "2026-07-24T01:00:00.000Z",
      "2026-07-24T01:00:00.000Z",
      {
        revision: 1,
        occurrenceKey: original.definition.nextOccurrenceKey!
      }
    );
    assert.equal(
      store.require(original.definition.scheduleId).definition.nextRunAt,
      "2026-07-24T01:30:00.000Z"
    );
  } finally {
    store.close();
    fixture.close();
  }
});

function setup(): {
  readonly database: string;
  readonly agentId: string;
  readonly close: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "rollerskate-schedule-store-"));
  const database = join(root, "runtime.sqlite");
  const runtime = new RuntimeStore(database);
  runtime.close();
  const foundation = new LocalFoundationStore(database);
  const agent = foundation.addAgent("scheduler", "codex", "2026-07-24T00:00:00.000Z");
  return {
    database,
    agentId: agent.principalId,
    close: () => foundation.close()
  };
}

function scheduleInput(agentId: string): CreateScheduleInput {
  return {
    ownerPrincipalId: agentId,
    ...revisionInput(agentId)
  };
}

function revisionInput(agentId: string): Omit<UpdateScheduleInput, "expectedRevision"> {
  return {
    agentId,
    kind: "cron",
    expression: "0 * * * *",
    timezone: "UTC",
    misfirePolicy: "run_once",
    overlapPolicy: "queue",
    misfireGraceMilliseconds: 60_000,
    sessionPolicy: "new_each_run",
    prompt: "Run report",
    workspace: "/workspace"
  };
}
