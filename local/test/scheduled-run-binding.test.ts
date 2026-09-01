import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runScheduleNow } from "../src/application/schedule/control.js";
import { inspectScheduleView } from "../src/application/schedule/query.js";
import {
  scheduleRunBindingAdapter,
  scheduleSourceBindingRegistrar
} from "../src/application/schedule/source-binding.js";
import { applyRunDecisionInTransaction } from
  "../src/application/steward/decision.js";
import { startStewardRunFromIntent } from
  "../src/application/steward/intent-control.js";
import { cancelStewardRun } from "../src/application/steward/control.js";
import { ScheduledTaskRuntime } from
  "../src/capabilities/scheduled-task/runtime.js";
import { ScheduledTaskStore } from
  "../src/capabilities/scheduled-task/store.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { AgentRunStore } from "../src/infrastructure/sqlite/agent-run-store.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("ScheduleRevision@2 binds atomically and a due once occurrence only activates its Run", async () => {
  const fixture = setup();
  const started = startStewardRunFromIntent(
    fixture.repo,
    intent("bound-once", "once"),
    fixture.runtimeDirectory,
    "2026-08-26T04:00:00.000Z"
  );
  let context = openContext(fixture.paths.database);
  try {
    const bound = bindSchedule(context, started.run.runId, onceDecision(1, {
      expression: "2026-08-26T04:01:00.000Z",
      misfirePolicy: "run_once",
      overlapPolicy: "skip",
      misfireGraceMilliseconds: 60_000,
      cancellationPolicy: "pause_source"
    }), "2026-08-26T04:00:01.000Z");
    assert.equal(bound.status, "awaiting_source");
    const schedule = context.schedules.boundForRun(bound.runId);
    assert.equal(schedule?.revision.schemaVersion, "ScheduleRevision@2");
    assert.equal(schedule?.revision.agentId, undefined);
    assert.equal(schedule?.revision.prompt, undefined);
    assert.equal(schedule?.revision.workspace, undefined);
    assert.deepEqual(context.database.prepare(`
      SELECT callback_id FROM proactive_callback_definitions
      WHERE owner_kind = 'schedule' AND owner_id = ?
    `).all(schedule!.definition.scheduleId), []);

    const cycle = scheduler(context);
    const admitted = await cycle.runCycle("2026-08-26T04:01:00.000Z");
    assert.equal(admitted.admitted.length, 1);
    const occurrence = context.schedules.requireRun(admitted.admitted[0]!);
    assert.equal(occurrence.agentRunId, bound.runId);
    assert.notEqual(occurrence.cycleId, undefined);
    assert.equal(occurrence.eventId, undefined);
    assert.equal(occurrence.executionId, undefined);
    assert.equal(occurrence.admissionReceipt?.agentRunId, bound.runId);
    const diagnostics = inspectScheduleView(
      fixture.repo,
      schedule!.definition.scheduleId,
      fixture.runtimeDirectory
    );
    assert.equal(diagnostics.summary.agent, null);
    assert.equal(diagnostics.summary.sourceBinding?.runId, bound.runId);
    assert.equal(diagnostics.runs[0]?.agentRunId, bound.runId);
    assert.equal(diagnostics.runs[0]?.cycleId, occurrence.cycleId);
    assert.equal(diagnostics.runs[0]?.admissionReceipt?.occurrenceId, occurrence.runId);
    assert.deepEqual(context.database.prepare(`
      SELECT occurrence_id FROM proactive_callback_occurrences
      WHERE owner_kind = 'schedule' AND owner_id = ?
    `).all(schedule!.definition.scheduleId), []);
    const occurrenceEvent = context.runtime.event(
      occurrence.admissionReceipt!.orchestratorEventId
    );
    assert.equal(occurrenceEvent?.type, "agent.request");
    assert.equal(occurrenceEvent?.source.kind, "handler");
    assert.equal(occurrenceEvent?.type === "agent.request"
      ? occurrenceEvent.runContext?.resultContractId
      : undefined, "run-decision@3");

    const cycleId = occurrence.cycleId!;
    closeContext(context);
    context = openContext(fixture.paths.database);
    assert.deepEqual(context.database.prepare(`
      SELECT callback_id FROM proactive_callback_definitions
      WHERE owner_kind = 'schedule' AND owner_id = ?
    `).all(schedule!.definition.scheduleId), []);
    const active = context.runs.requireProjection(bound.runId);
    context.runtime.withImmediateTransaction(() => {
      context.runs.terminalizeInTransaction({
        runId: active.runId,
        expectedVersion: active.version,
        status: "succeeded",
        summary: "once cycle accepted",
        scope: "cycle",
        updatedAt: "2026-08-26T04:01:10.000Z"
      });
    });
    const projected = await scheduler(context).runCycle("2026-08-26T04:01:11.000Z");
    assert.deepEqual(projected.projected, [occurrence.runId]);
    assert.equal(context.schedules.requireRun(occurrence.runId).status, "succeeded");
    assert.equal(context.runs.cycle(cycleId)?.status, "succeeded");
    assert.equal(
      context.schedules.require(schedule!.definition.scheduleId).definition.status,
      "completed"
    );
  } finally {
    closeContext(context);
    fixture.close();
  }
});

test("recurring Schedule owns misfire, overlap queue, duplicate run-now, restart, and cancel", async () => {
  const fixture = setup();
  const started = startStewardRunFromIntent(
    fixture.repo,
    intent("bound-cron", "cron"),
    fixture.runtimeDirectory,
    "2026-08-26T05:00:00.000Z"
  );
  const context = openContext(fixture.paths.database);
  try {
    const bound = bindSchedule(context, started.run.runId, cronDecision(1, {
      expression: "* * * * *",
      timezone: "UTC",
      misfirePolicy: "run_once",
      overlapPolicy: "queue",
      misfireGraceMilliseconds: 0,
      cancellationPolicy: "cancel_source"
    }), "2026-08-26T05:00:01.000Z");
    const schedule = context.schedules.boundForRun(bound.runId)!;
    const first = await scheduler(context).runCycle("2026-08-26T05:02:30.000Z");
    assert.equal(first.admitted.length, 1);
    const firstOccurrence = context.schedules.requireRun(first.admitted[0]!);
    assert.equal(firstOccurrence.decisionReason, "misfire-run-once");
    assert.equal(firstOccurrence.coalescedThrough, "2026-08-26T05:02:00.000Z");

    const manual = runScheduleNow(
      fixture.repo,
      schedule.definition.scheduleId,
      "manual-dedupe",
      fixture.runtimeDirectory,
      "2026-08-26T05:02:40.000Z"
    );
    const duplicate = runScheduleNow(
      fixture.repo,
      schedule.definition.scheduleId,
      "manual-dedupe",
      fixture.runtimeDirectory,
      "2026-08-26T05:02:41.000Z"
    );
    assert.equal(manual.run.status, "queued");
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.run.runId, manual.run.runId);

    const overlap = await scheduler(context).runCycle("2026-08-26T05:03:00.000Z");
    assert.equal(overlap.queued.length, 1);
    assert.equal(context.schedules.pendingRuns().length, 1);
    const active = context.runs.requireProjection(bound.runId);
    context.runtime.withImmediateTransaction(() => {
      context.runs.terminalizeInTransaction({
        runId: active.runId,
        expectedVersion: active.version,
        status: "succeeded",
        summary: "first cron cycle accepted",
        scope: "cycle",
        updatedAt: "2026-08-26T05:03:10.000Z"
      });
    });
    const resumed = await scheduler(context).runCycle("2026-08-26T05:03:11.000Z");
    assert.equal(resumed.projected.includes(firstOccurrence.runId), true);
    assert.deepEqual(resumed.admitted, [manual.run.runId]);
    assert.notEqual(context.schedules.requireRun(manual.run.runId).cycleId, undefined);

    const queued = await scheduler(context).runCycle("2026-08-26T05:04:00.000Z");
    assert.equal(queued.queued.length, 1);
    const queuedOccurrenceId = queued.queued[0]!;

    cancelStewardRun(
      fixture.repo,
      bound.runId,
      fixture.runtimeDirectory,
      "2026-08-26T05:03:20.000Z"
    );
    const cancelled = await scheduler(context).runCycle("2026-08-26T05:04:01.000Z");
    assert.equal(cancelled.skipped.includes(queuedOccurrenceId), true);
    assert.equal(
      context.schedules.requireRun(queuedOccurrenceId).decisionReason,
      "schedule-cancelled"
    );
    assert.equal(
      context.schedules.require(schedule.definition.scheduleId).definition.status,
      "cancelled"
    );
  } finally {
    closeContext(context);
    fixture.close();
  }
});

test("queued ScheduleRevision@2 occurrence closes when a terminal Run pauses its source", async () => {
  const fixture = setup();
  const started = startStewardRunFromIntent(
    fixture.repo,
    intent("queued-terminal", "cron"),
    fixture.runtimeDirectory,
    "2026-08-26T07:00:00.000Z"
  );
  const context = openContext(fixture.paths.database);
  try {
    const bound = bindSchedule(context, started.run.runId, cronDecision(1, {
      expression: "* * * * *",
      timezone: "UTC",
      misfirePolicy: "run_once",
      overlapPolicy: "queue",
      misfireGraceMilliseconds: 60_000,
      cancellationPolicy: "pause_source"
    }), "2026-08-26T07:00:01.000Z");
    const schedule = context.schedules.boundForRun(bound.runId)!;
    const first = await scheduler(context).runCycle("2026-08-26T07:01:00.000Z");
    assert.equal(first.admitted.length, 1);
    const queued = await scheduler(context).runCycle("2026-08-26T07:02:00.000Z");
    assert.equal(queued.queued.length, 1);

    cancelStewardRun(
      fixture.repo,
      bound.runId,
      fixture.runtimeDirectory,
      "2026-08-26T07:02:10.000Z"
    );
    const reconciled = await scheduler(context).runCycle("2026-08-26T07:02:11.000Z");
    assert.equal(reconciled.skipped.includes(queued.queued[0]!), true);
    assert.equal(
      context.schedules.requireRun(queued.queued[0]!).decisionReason,
      "bound-run-cancelled"
    );
    assert.equal(
      context.schedules.require(schedule.definition.scheduleId).definition.status,
      "paused"
    );
  } finally {
    closeContext(context);
    fixture.close();
  }
});

test("ScheduleRevision@2 keeps misfire and overlap skip source-owned", async () => {
  const fixture = setup();
  const once = startStewardRunFromIntent(
    fixture.repo,
    intent("misfire-skip", "once"),
    fixture.runtimeDirectory,
    "2026-08-26T06:00:00.000Z"
  );
  const cron = startStewardRunFromIntent(
    fixture.repo,
    intent("overlap-skip", "cron"),
    fixture.runtimeDirectory,
    "2026-08-26T06:00:02.000Z"
  );
  const context = openContext(fixture.paths.database);
  try {
    const onceBound = bindSchedule(context, once.run.runId, onceDecision(1, {
      expression: "2026-08-26T06:01:00.000Z",
      misfirePolicy: "skip",
      overlapPolicy: "skip",
      misfireGraceMilliseconds: 0,
      cancellationPolicy: "pause_source"
    }), "2026-08-26T06:00:01.000Z");
    const cronBound = bindSchedule(context, cron.run.runId, cronDecision(1, {
      expression: "* * * * *",
      timezone: "UTC",
      misfirePolicy: "run_once",
      overlapPolicy: "skip",
      misfireGraceMilliseconds: 60_000,
      cancellationPolicy: "pause_source"
    }), "2026-08-26T06:00:03.000Z");
    const first = await scheduler(context).runCycle("2026-08-26T06:01:01.000Z");
    assert.equal(first.admitted.length, 1);
    assert.equal(first.skipped.length, 1);
    assert.equal(context.runs.requireProjection(onceBound.runId).activeCycleId, undefined);
    const overlap = await scheduler(context).runCycle("2026-08-26T06:02:00.000Z");
    assert.equal(overlap.skipped.length, 1);
    assert.equal(context.schedules.pendingRuns().length, 0);
    assert.notEqual(context.runs.requireProjection(cronBound.runId).activeCycleId, undefined);
  } finally {
    closeContext(context);
    fixture.close();
  }
});

function bindSchedule(
  context: Context,
  runId: string,
  decision: ReturnType<typeof onceDecision> | ReturnType<typeof cronDecision>,
  at: string
) {
  return context.runtime.withImmediateTransaction(() =>
    applyRunDecisionInTransaction({
      runtime: context.runtime,
      runs: context.runs,
      run: context.runs.requireProjection(runId),
      decision,
      requestId: `bind:${runId}`,
      sourceKind: "handler",
      bindSource: scheduleSourceBindingRegistrar(context.schedules),
      at
    }).run
  );
}

function scheduler(context: Context): ScheduledTaskRuntime {
  return new ScheduledTaskRuntime({
    store: context.schedules,
    runtime: context.runtime,
    validateTarget: () => undefined,
    runBinding: scheduleRunBindingAdapter({
      runtime: context.runtime,
      runs: context.runs
    })
  });
}

function intent(requestId: string, triggerIntent: "once" | "cron") {
  return {
    schemaVersion: "RunIntent@1",
    requestId,
    objective: "Process each admitted schedule occurrence",
    acceptance: ["Each occurrence is handled exactly once"],
    contextRefs: [],
    triggerIntent,
    requestedParticipantRefs: ["agent:worker"],
    terminalEvidence: ["cycle receipt"]
  } as const;
}

function onceDecision(
  expectedRunVersion: number,
  parameters: {
    readonly expression: string;
    readonly misfirePolicy: "skip" | "run_once";
    readonly overlapPolicy: "skip" | "queue";
    readonly misfireGraceMilliseconds: number;
    readonly cancellationPolicy: "pause_source" | "cancel_source";
  }
) {
  return decision(expectedRunVersion, "schedule.once@1", parameters);
}

function cronDecision(
  expectedRunVersion: number,
  parameters: {
    readonly expression: string;
    readonly timezone: string;
    readonly misfirePolicy: "skip" | "run_once";
    readonly overlapPolicy: "skip" | "queue";
    readonly misfireGraceMilliseconds: number;
    readonly cancellationPolicy: "pause_source" | "cancel_source";
  }
) {
  return decision(expectedRunVersion, "schedule.cron@1", parameters);
}

function decision(
  expectedRunVersion: number,
  templateId: "schedule.once@1" | "schedule.cron@1",
  parameters: Readonly<Record<string, unknown>>
) {
  return {
    schemaVersion: "RunDecision@3",
    action: "await_source",
    expectedRunVersion,
    rationale: "Wait for the admitted Schedule",
    checkedAcceptance: [],
    state: {
      schemaVersion: "OrchestratorState@1",
      goal: "Process occurrences",
      tasks: [],
      acceptedEvidence: [],
      unresolvedQuestions: []
    },
    awaitSource: { sourceKind: "schedule", templateId, parameters }
  } as const;
}

interface Context {
  readonly database: ReturnType<typeof openRuntimeDatabase>;
  readonly runtime: RuntimeStore;
  readonly runs: AgentRunStore;
  readonly schedules: ScheduledTaskStore;
}

function openContext(databasePath: string): Context {
  const database = openRuntimeDatabase(databasePath);
  return {
    database,
    runtime: new RuntimeStore(database),
    runs: new AgentRunStore(database),
    schedules: new ScheduledTaskStore(database)
  };
}

function closeContext(context: Context): void {
  context.schedules.close();
  context.runs.close();
  context.runtime.close();
  context.database.close();
}

function setup() {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-schedule-binding-repo-"));
  const runtimeDirectory = mkdtempSync(
    join(tmpdir(), "rollerskate-schedule-binding-runtime-")
  );
  const paths = runtimePaths(repo, runtimeDirectory);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths, "2026-08-26T03:59:00.000Z");
  const foundation = new LocalFoundationStore(paths.database);
  foundation.addAgent("codex", "codex", "2026-08-26T03:59:00.000Z");
  foundation.addAgent("worker", "codex", "2026-08-26T03:59:00.000Z");
  foundation.close();
  return {
    repo,
    runtimeDirectory,
    paths,
    close() {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  };
}
