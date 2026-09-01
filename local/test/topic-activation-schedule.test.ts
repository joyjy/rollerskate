import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { addLocalAgent } from "../src/application/agent/control.js";
import {
  createLocalTopicActivationSchedule,
  pauseLocalTopicActivationSchedule,
  resumeLocalTopicActivationSchedule
} from "../src/application/topic/schedule-control.js";
import { localTopicActivationSchedule } from
  "../src/application/topic/schedule-query.js";
import { TopicActivationScheduleRuntime } from
  "../src/application/topic/schedule-runtime.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { runLocalApp } from "../src/entrypoints/cli/main.js";

test("Topic activation occurrence is admitted exactly once with one durable receipt", () => {
  const fixture = runtimeFixture("exact-once");
  try {
    const agent = addLocalAgent(fixture.repo, "alice", "codex", fixture.optionsAt(AT));
    const created = createLocalTopicActivationSchedule(fixture.repo, {
      kind: "once",
      expression: DUE,
      candidatePolicy: "deterministic_one"
    }, fixture.optionsAt(AT));
    const scheduleRuntime = new TopicActivationScheduleRuntime(
      fixture.repo, fixture.options
    );
    try {
      const first = scheduleRuntime.runCycle(DUE);
      assert.equal(first.admittedActivationEventIds.length, 1);
      assert.equal(scheduleRuntime.runCycle(DUE).admittedActivationEventIds.length, 0);
      const runtime = new RuntimeStore(join(fixture.runtime, "runtime.db"));
      try {
        const activation = runtime.event(first.admittedActivationEventIds[0]!);
        assert.equal(activation?.type, "chat.activation");
        if (activation?.type !== "chat.activation") assert.fail("activation missing");
        assert.deepEqual(activation.candidateAgentIds, [agent.principalId]);
        assert.equal(activation.reason, "scheduled");
      } finally {
        runtime.close();
      }
    } finally {
      scheduleRuntime.close();
    }
    const view = localTopicActivationSchedule(
      fixture.repo, created.schedule.scheduleId, fixture.runtime
    );
    assert.equal(view.schedule.status, "completed");
    assert.deepEqual(view.receipts.map(({ action }) => action), [
      "occurrence_admitted", "created"
    ]);
  } finally {
    fixture.close();
  }
});

test("misfire skip and paused window advance without replaying backlog", () => {
  const fixture = runtimeFixture("bounded-skip");
  try {
    addLocalAgent(fixture.repo, "alice", "codex", fixture.optionsAt(AT));
    const once = createLocalTopicActivationSchedule(fixture.repo, {
      kind: "once",
      expression: DUE,
      misfirePolicy: "skip",
      misfireGraceMilliseconds: 0
    }, fixture.optionsAt(AT));
    const runtime = new TopicActivationScheduleRuntime(fixture.repo, fixture.options);
    try {
      const skipped = runtime.runCycle("2026-08-03T01:01:00.000Z");
      assert.deepEqual(skipped.skippedOccurrenceKeys, [once.schedule.nextOccurrenceKey]);
    } finally {
      runtime.close();
    }
    const skippedView = localTopicActivationSchedule(
      fixture.repo, once.schedule.scheduleId, fixture.runtime
    );
    assert.equal(skippedView.receipts[0]?.reason, "misfire-skip");

    const cron = createLocalTopicActivationSchedule(fixture.repo, {
      kind: "cron",
      expression: "0 * * * *",
      timezone: "UTC"
    }, fixture.optionsAt(AT));
    const paused = pauseLocalTopicActivationSchedule(
      fixture.repo, cron.schedule.scheduleId, cron.schedule.revision,
      fixture.optionsAt("2026-08-03T00:30:00.000Z")
    );
    assert.equal(pauseLocalTopicActivationSchedule(
      fixture.repo, cron.schedule.scheduleId, cron.schedule.revision,
      fixture.optionsAt("2026-08-03T00:31:00.000Z")
    ).outcome, "unchanged");
    const resumed = resumeLocalTopicActivationSchedule(
      fixture.repo, cron.schedule.scheduleId, paused.schedule.revision,
      fixture.optionsAt("2026-08-03T03:30:00.000Z")
    );
    assert.equal(resumeLocalTopicActivationSchedule(
      fixture.repo, cron.schedule.scheduleId, paused.schedule.revision,
      fixture.optionsAt("2026-08-03T03:31:00.000Z")
    ).outcome, "unchanged");
    assert.equal(resumed.schedule.nextRunAt, "2026-08-03T04:00:00.000Z");
    const resumedView = localTopicActivationSchedule(
      fixture.repo, cron.schedule.scheduleId, fixture.runtime
    );
    assert.equal(resumedView.receipts.some(({ reason }) => reason === "paused-window"), true);
    assert.equal(resumedView.receipts.filter(
      ({ action }) => action === "occurrence_skipped"
    ).length, 1);
  } finally {
    fixture.close();
  }
});

test("schedule occurrence failure advances once with a durable failed receipt", () => {
  const fixture = runtimeFixture("failed-occurrence");
  try {
    addLocalAgent(fixture.repo, "alice", "codex", fixture.optionsAt(AT));
    const created = createLocalTopicActivationSchedule(fixture.repo, {
      kind: "once",
      expression: DUE,
      intentPolicy: { kind: "choose_from_themes" }
    }, fixture.optionsAt(AT));
    const runtime = new TopicActivationScheduleRuntime(fixture.repo, fixture.options);
    try {
      const failed = runtime.runCycle(DUE);
      assert.deepEqual(failed.failedOccurrenceKeys, [created.schedule.nextOccurrenceKey]);
      assert.deepEqual(runtime.runCycle(DUE).failedOccurrenceKeys, []);
    } finally {
      runtime.close();
    }
    const view = localTopicActivationSchedule(
      fixture.repo, created.schedule.scheduleId, fixture.runtime
    );
    assert.equal(view.schedule.status, "completed");
    assert.equal(view.receipts[0]?.action, "occurrence_failed");
    assert.match(view.receipts[0]?.reason ?? "", /choose_from_themes/);
  } finally {
    fixture.close();
  }
});

test("exact v55 database materializes additive v60 schedule and channel tables", () => {
  const fixture = runtimeFixture("migration-v55");
  try {
    addLocalAgent(fixture.repo, "alice", "codex", fixture.optionsAt(AT));
    const databasePath = join(fixture.runtime, "runtime.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      DROP TABLE channel_follows;
      DROP TABLE channel_send_receipts;
      DROP TABLE interactive_channel_bindings;
      DROP TABLE topic_activation_schedule_receipts;
      DROP TABLE topic_activation_schedules;
      UPDATE schema_meta SET value = '55' WHERE key = 'schema_version';
    `);
    database.close();
    const diagnostics = initializeRuntimeSchema(databasePath);
    assert.equal(diagnostics.schemaVersion, 69);
    assert.equal(diagnostics.tables.length, 29);
    for (const table of [
      "topic_activation_schedules", "topic_activation_schedule_receipts",
      "interactive_channel_bindings", "channel_send_receipts", "channel_follows"
    ]) assert.equal(diagnostics.tables.includes(table), true);
  } finally {
    fixture.close();
  }
});

test("Chat schedule CLI creates, inspects and controls the Topic schedule", async () => {
  const fixture = runtimeFixture("cli");
  try {
    addLocalAgent(fixture.repo, "alice", "codex", fixture.optionsAt(AT));
    const created = await cli(fixture, [
      "chat", "schedule", "create", "--once", "2099-08-03T01:00:00.000Z",
      "--misfire", "skip", "--candidates", "deterministic_one"
    ]);
    assert.equal(created.outcome, "applied");
    const schedule = created.schedule as { scheduleId: string; revision: number };
    const paused = await cli(fixture, [
      "chat", "schedule", "pause", schedule.scheduleId,
      "--revision", String(schedule.revision)
    ]);
    assert.equal((paused.schedule as { status: string }).status, "paused");
    const status = await cli(fixture, [
      "chat", "schedule", "status", schedule.scheduleId
    ]);
    assert.equal((status.schedule as { scheduleId: string }).scheduleId, schedule.scheduleId);
  } finally {
    fixture.close();
  }
});

const AT = "2026-08-03T00:00:00.000Z";
const DUE = "2026-08-03T01:00:00.000Z";

function runtimeFixture(name: string) {
  const repo = mkdtempSync(join(tmpdir(), `rollerskate-topic-schedule-${name}-repo-`));
  const runtime = mkdtempSync(join(tmpdir(), `rollerskate-topic-schedule-${name}-runtime-`));
  return {
    repo,
    runtime,
    options: { runtimeDirectory: runtime },
    optionsAt: (at: string) => ({ runtimeDirectory: runtime, now: () => new Date(at) }),
    close: () => {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
    }
  };
}

async function cli(
  fixture: ReturnType<typeof runtimeFixture>,
  arguments_: readonly string[]
): Promise<Record<string, unknown>> {
  let output = "";
  assert.equal(await runLocalApp(fixture.repo, [
    "--runtime", fixture.runtime, ...arguments_
  ], {}, { write(text) { output += text; } }), 0);
  return JSON.parse(output) as Record<string, unknown>;
}
