import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "./support/temp-directory.js";

import { LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";
import { addLocalAgent } from "../src/application/agent/control.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import type { CreateScheduleInput } from "../src/capabilities/scheduled-task/model.js";
import { ScheduledTaskRuntime } from "../src/capabilities/scheduled-task/runtime.js";
import { ScheduledTaskStore } from "../src/capabilities/scheduled-task/store.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { runLocalApp } from "../src/entrypoints/cli/main.js";
import { createScheduleAdmissionGate } from "../src/application/schedule/readiness.js";
import { codexDesktopReminderAction, CODEX_DESKTOP_REMINDER_ACTION } from "../src/application/proactive/desktop-reminder-action.js";
import { DeterministicApplicationActionRegistry } from "../src/application/proactive/action-registry.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";

test("due one-shot admits exactly one canonical Event and projects its terminal result", async () => {
  const fixture = setup();
  try {
    const schedule = fixture.schedules.create(
      onceInput(fixture.agentId, "2026-07-24T01:00:00.000Z"),
      "2026-07-24T00:00:00.000Z"
    );
    const first = await fixture.scheduler.runCycle("2026-07-24T01:00:00.000Z");
    const duplicate = await fixture.scheduler.runCycle("2026-07-24T01:00:01.000Z");
    assert.equal(first.admitted.length, 1);
    assert.deepEqual(duplicate.admitted, []);
    assert.equal(fixture.schedules.require(schedule.definition.scheduleId).definition.status, "completed");

    const run = fixture.schedules.runs(schedule.definition.scheduleId)[0]!;
    assert.equal(run.status, "queued");
    assert.equal(run.decisionReason, "due");
    const event = fixture.runtime.event(run.eventId!);
    assert.deepEqual(event?.source, {
      kind: "schedule",
      externalId: `scheduled-run:${run.runId}`
    });

    complete(fixture.runtime, run.eventId!, "2026-07-24T01:01:00.000Z");
    assert.deepEqual(
      (await fixture.scheduler.runCycle("2026-07-24T01:02:00.000Z")).projected,
      [run.runId]
    );
    const terminal = fixture.schedules.requireRun(run.runId);
    assert.equal(terminal.status, "succeeded");
    assert.match(terminal.sessionId ?? "", /^ses_/);
  } finally {
    fixture.close();
  }
});

test("readiness deferral persists without Event admission and cancellation wins an asynchronous probe", async () => {
  const fixture = setup();
  try {
    const schedule = fixture.schedules.create(onceInput(fixture.agentId, "2026-07-24T01:00:00.000Z"),
      "2026-07-24T00:00:00.000Z");
    const scheduler = new ScheduledTaskRuntime({
      store: fixture.schedules, runtime: fixture.runtime, validateTarget: () => undefined,
      admissionGate: async () => ({ status: "defer", reason: "waiting-network" })
    });
    await scheduler.runCycle("2026-07-24T01:00:00.000Z");
    const pending = fixture.schedules.runs(schedule.definition.scheduleId)[0]!;
    assert.equal(pending.status, "queued");
    assert.equal(pending.eventId, undefined);
    assert.equal(pending.decisionReason, "waiting-network");
    const cancelling = new ScheduledTaskRuntime({
      store: fixture.schedules, runtime: fixture.runtime, validateTarget: () => undefined,
      admissionGate: async () => {
        fixture.schedules.setStatus(schedule.definition.scheduleId, "cancel", "2026-07-24T01:00:01.000Z");
        return { status: "ready" };
      }
    });
    await cancelling.runCycle("2026-07-24T01:00:01.000Z");
    assert.equal(fixture.schedules.requireRun(pending.runId).eventId, undefined);
    await fixture.scheduler.runCycle("2026-07-24T01:00:02.000Z");
    assert.equal(fixture.schedules.requireRun(pending.runId).status, "skipped");
  } finally { fixture.close(); }
});

test("wake readiness defers network and exact Desktop dependencies, then expires without an Agent", async () => {
  const fixture = setup();
  const database = openRuntimeDatabase(fixture.database);
  const schedules = new ScheduledTaskStore(database);
  const runtime = new RuntimeStore(database);
  try {
    const legacy = schedules.create(onceInput(fixture.agentId, "2026-07-24T01:00:00.000Z"),
      "2026-07-24T00:00:00.000Z");
    schedules.setStatus(legacy.definition.scheduleId, "pause", "2026-07-24T00:01:00.000Z");
    let power: "awake" | "sleeping" | "unknown" = "sleeping";
    let online = false;
    let desktop = false;
    let clock = 0;
    let networks = 0;
    const threadId = "00000000-0000-4000-8000-000000000001";
    const gate = createScheduleAdmissionGate({
      runs: { projection: () => undefined }, agentClient: () => "codex", clock: () => clock,
      power: async () => power,
      network: async () => { networks++; return online; },
      desktop: async target => { assert.equal(target, threadId); if (!desktop) throw new Error("offline"); }
    });
    assert.deepEqual(await gate(legacy.revision, "2026-07-24T01:00:00.000Z"), { status: "defer", reason: "waiting-awake" });
    assert.equal(networks, 0);
    power = "awake"; clock += 6_000;
    assert.deepEqual(await gate(legacy.revision, "2026-07-24T01:00:06.000Z"), { status: "defer", reason: "waiting-network" });
    online = true; clock += 6_000;
    assert.deepEqual(await gate(legacy.revision, "2026-07-24T01:00:12.000Z"), { status: "ready" });
    const actions = new DeterministicApplicationActionRegistry(database, [codexDesktopReminderAction]);
    const reminder = schedules.withImmediateTransaction(() => schedules.createTargetedInTransaction({
      scheduleId: "sch_00000000-0000-7000-8000-000000000001", ownerPrincipalId: fixture.agentId,
      kind: "once", expression: "2026-07-24T01:00:00.000Z", misfirePolicy: "run_once", overlapPolicy: "skip",
      misfireGraceMilliseconds: 0, target: actions.compileTarget(CODEX_DESKTOP_REMINDER_ACTION, {
        threadId, body: "fixed text", expiresAt: "2026-07-24T01:01:00.000Z"
      })
    }, "2026-07-24T00:00:00.000Z"));
    const scheduler = new ScheduledTaskRuntime({ store: schedules, runtime: runtime,
      validateTarget: () => undefined, applicationActions: actions, admissionGate: gate });
    await scheduler.runCycle("2026-07-24T01:00:12.000Z");
    const pending = schedules.runs(reminder.definition.scheduleId)[0]!;
    assert.equal(pending.decisionReason, "waiting-desktop");
    assert.equal(pending.eventId, undefined);
    schedules.setStatus(reminder.definition.scheduleId, "pause", "2026-07-24T01:00:13.000Z");
    await scheduler.runCycle("2026-07-24T01:00:14.000Z");
    assert.equal(schedules.requireRun(pending.runId).status, "queued");
    schedules.setStatus(reminder.definition.scheduleId, "resume", "2026-07-24T01:00:15.000Z");
    assert.equal(schedules.require(reminder.definition.scheduleId).definition.status, "completed");
    assert.equal(schedules.runs(reminder.definition.scheduleId).length, 1);
    clock += 60_000; power = "sleeping";
    await scheduler.runCycle("2026-07-24T01:01:00.000Z");
    assert.equal(schedules.requireRun(pending.runId).status, "skipped");
    assert.equal(schedules.requireRun(pending.runId).decisionReason, "reminder-expired");
    assert.equal(database.prepare("SELECT count(*) AS n FROM deliveries").get()?.n, 0);
    desktop = true;
    assert.deepEqual(await gate(reminder.revision, "2026-07-24T01:01:01.000Z"), { status: "skip", reason: "reminder-expired" });
    power = "awake"; clock += 6_000;
    const ready = schedules.withImmediateTransaction(() => schedules.createTargetedInTransaction({
      scheduleId: "sch_00000000-0000-7000-8000-000000000002", ownerPrincipalId: fixture.agentId,
      kind: "once", expression: "2026-07-24T01:02:00.000Z", misfirePolicy: "run_once", overlapPolicy: "skip",
      misfireGraceMilliseconds: 0, target: actions.compileTarget(CODEX_DESKTOP_REMINDER_ACTION, {
        threadId, body: "ready text", expiresAt: "2026-07-24T01:03:00.000Z"
      })
    }, "2026-07-24T01:01:00.000Z"));
    await scheduler.runCycle("2026-07-24T01:02:00.000Z");
    await scheduler.runCycle("2026-07-24T01:02:01.000Z");
    assert.equal(schedules.runs(ready.definition.scheduleId)[0]!.status, "succeeded");
    assert.equal(database.prepare("SELECT count(*) AS n FROM deliveries").get()?.n, 1);
    assert.equal(database.prepare("SELECT count(*) AS n FROM events").get()?.n, 0);
  } finally { database.close(); fixture.close(); }
});

test("sleep recovery coalesces missed cron occurrences without backfill", async () => {
  const fixture = setup();
  try {
    const schedule = fixture.schedules.create(
      cronInput(fixture.agentId, {
        misfirePolicy: "run_once",
        overlapPolicy: "queue"
      }),
      "2026-07-24T00:00:00.000Z"
    );
    const result = await fixture.scheduler.runCycle("2026-07-24T05:30:00.000Z");
    assert.equal(result.admitted.length, 1);
    const runs = fixture.schedules.runs(schedule.definition.scheduleId);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.scheduledFor, "2026-07-24T01:00:00.000Z");
    assert.equal(runs[0]!.coalescedThrough, "2026-07-24T05:00:00.000Z");
    assert.equal(runs[0]!.decisionReason, "misfire-run-once");
    assert.equal(
      fixture.schedules.require(schedule.definition.scheduleId).definition.nextRunAt,
      "2026-07-24T06:00:00.000Z"
    );
  } finally {
    fixture.close();
  }
});

test("misfire skip records one bounded decision", async () => {
  const fixture = setup();
  try {
    const schedule = fixture.schedules.create(
      cronInput(fixture.agentId, {
        misfirePolicy: "skip",
        overlapPolicy: "skip"
      }),
      "2026-07-24T00:00:00.000Z"
    );
    const result = await fixture.scheduler.runCycle("2026-07-24T05:30:00.000Z");
    assert.equal(result.skipped.length, 1);
    assert.equal(result.admitted.length, 0);
    const run = fixture.schedules.runs(schedule.definition.scheduleId)[0]!;
    assert.equal(run.status, "skipped");
    assert.equal(run.coalescedThrough, "2026-07-24T05:00:00.000Z");
    assert.equal(fixture.runtime.events().filter(
      (event) => event.source.kind === "schedule"
    ).length, 0);
  } finally {
    fixture.close();
  }
});

test("overlap queue keeps one pending run and admits it after the active run", async () => {
  const fixture = setup();
  try {
    const schedule = fixture.schedules.create(
      cronInput(fixture.agentId, {
        misfirePolicy: "run_once",
        overlapPolicy: "queue"
      }),
      "2026-07-24T00:00:00.000Z"
    );
    await fixture.scheduler.runCycle("2026-07-24T01:00:00.000Z");
    await fixture.scheduler.runCycle("2026-07-24T03:30:00.000Z");
    await fixture.scheduler.runCycle("2026-07-24T04:30:00.000Z");
    const queued = fixture.schedules.runs(schedule.definition.scheduleId);
    assert.equal(queued.length, 2);
    const active = queued.find((run) => run.eventId !== undefined)!;
    const pending = queued.find((run) => run.eventId === undefined)!;
    assert.equal(pending.status, "queued");
    assert.equal(pending.coalescedThrough, "2026-07-24T04:00:00.000Z");

    complete(fixture.runtime, active.eventId!, "2026-07-24T04:31:00.000Z");
    const recovered = await fixture.scheduler.runCycle("2026-07-24T04:32:00.000Z");
    assert.deepEqual(recovered.projected, [active.runId]);
    assert.deepEqual(recovered.admitted, [pending.runId]);
    assert.match(fixture.schedules.requireRun(pending.runId).eventId ?? "", /^evt_/);
  } finally {
    fixture.close();
  }
});

test("overlap skip records one decision without a concurrent invocation", async () => {
  const fixture = setup();
  try {
    const schedule = fixture.schedules.create(
      cronInput(fixture.agentId, {
        misfirePolicy: "run_once",
        overlapPolicy: "skip"
      }),
      "2026-07-24T00:00:00.000Z"
    );
    await fixture.scheduler.runCycle("2026-07-24T01:00:00.000Z");
    const second = await fixture.scheduler.runCycle("2026-07-24T02:00:00.000Z");
    assert.equal(second.skipped.length, 1);
    const runs = fixture.schedules.runs(schedule.definition.scheduleId);
    assert.equal(runs.length, 2);
    assert.equal(runs.filter((run) => run.eventId !== undefined).length, 1);
    assert.equal(runs.find((run) => run.status === "skipped")?.decisionReason, "overlap-skip");
  } finally {
    fixture.close();
  }
});

test("cancelled pending overlap is skipped before Event admission", async () => {
  const fixture = setup();
  try {
    const schedule = fixture.schedules.create(
      cronInput(fixture.agentId, {
        misfirePolicy: "run_once",
        overlapPolicy: "queue"
      }),
      "2026-07-24T00:00:00.000Z"
    );
    await fixture.scheduler.runCycle("2026-07-24T01:00:00.000Z");
    await fixture.scheduler.runCycle("2026-07-24T02:00:00.000Z");
    const before = fixture.schedules.runs(schedule.definition.scheduleId);
    const active = before.find((run) => run.eventId !== undefined)!;
    const pending = before.find((run) => run.eventId === undefined)!;
    fixture.schedules.setStatus(
      schedule.definition.scheduleId,
      "cancel",
      "2026-07-24T02:01:00.000Z"
    );
    complete(fixture.runtime, active.eventId!, "2026-07-24T02:02:00.000Z");

    const result = await fixture.scheduler.runCycle("2026-07-24T02:03:00.000Z");
    assert.ok(result.skipped.includes(pending.runId));
    assert.equal(fixture.schedules.requireRun(pending.runId).status, "skipped");
    assert.equal(
      fixture.schedules.requireRun(pending.runId).decisionReason,
      "schedule-cancelled"
    );
    assert.equal(fixture.schedules.requireRun(pending.runId).eventId, undefined);
  } finally {
    fixture.close();
  }
});

test("admission failure is terminal and does not become a misfire retry", async () => {
  const fixture = setup(() => "agent-suspended");
  try {
    const schedule = fixture.schedules.create(
      onceInput(fixture.agentId, "2026-07-24T01:00:00.000Z"),
      "2026-07-24T00:00:00.000Z"
    );
    const result = await fixture.scheduler.runCycle("2026-07-24T01:00:00.000Z");
    assert.equal(result.failed.length, 1);
    const run = fixture.schedules.runs(schedule.definition.scheduleId)[0]!;
    assert.equal(run.status, "failed");
    assert.equal(run.decisionReason, "admission-failed:agent-suspended");
    assert.equal(run.eventId, undefined);
    assert.deepEqual(
      (await fixture.scheduler.runCycle("2026-07-24T02:00:00.000Z")).failed,
      []
    );
  } finally {
    fixture.close();
  }
});

test("interrupted scheduled provider work becomes unknown instead of replaying", async () => {
  const fixture = setup();
  try {
    const schedule = fixture.schedules.create(
      onceInput(fixture.agentId, "2026-07-24T01:00:00.000Z"),
      "2026-07-24T00:00:00.000Z"
    );
    await fixture.scheduler.runCycle("2026-07-24T01:00:00.000Z");
    const run = fixture.schedules.runs(schedule.definition.scheduleId)[0]!;
    const execution = fixture.runtime.claimDueExecutions(
      1,
      "2026-07-24T01:01:00.000Z"
    )[0]!;
    assert.equal(execution.eventId, run.eventId);

    assert.equal(
      fixture.schedules.reconcileInterrupted("2026-07-24T01:02:00.000Z"),
      1
    );
    fixture.runtime.reconcileInterrupted("2026-07-24T01:02:00.000Z");
    assert.equal(fixture.schedules.requireRun(run.runId).status, "unknown");
    assert.equal(
      fixture.schedules.requireRun(run.runId).decisionReason,
      "provider-outcome-unknown"
    );
    assert.equal(fixture.runtime.execution(execution.executionId)?.status, "failed");
    assert.deepEqual(
      (await fixture.scheduler.runCycle("2026-07-24T01:03:00.000Z")).projected,
      []
    );
  } finally {
    fixture.close();
  }
});

test("crash after Event admission is repaired through the Event source receipt", async () => {
  const fixture = setup();
  try {
    const schedule = fixture.schedules.create(
      onceInput(fixture.agentId, "2026-07-24T01:00:00.000Z"),
      "2026-07-24T00:00:00.000Z"
    );
    const run = fixture.schedules.insertRun({
      scheduleId: schedule.definition.scheduleId,
      occurrenceKey: schedule.definition.nextOccurrenceKey!,
      scheduledFor: schedule.definition.nextRunAt!,
      scheduleRevision: 1,
      status: "queued",
      decisionReason: "due",
      createdAt: "2026-07-24T01:00:00.000Z"
    }).run;
    fixture.runtime.appendEvent({
      type: "agent.request",
      source: {
        kind: "schedule",
        externalId: `scheduled-run:${run.runId}`
      },
      agentId: fixture.agentId,
      prompt: "Run report",
      createdAt: "2026-07-24T01:00:00.000Z"
    });
    fixture.schedules.advance(
      schedule.definition.scheduleId,
      "2026-07-24T01:00:00.000Z",
      "2026-07-24T01:00:00.000Z"
    );

    assert.deepEqual(
      (await fixture.scheduler.runCycle("2026-07-24T01:01:00.000Z")).admitted,
      [run.runId]
    );
    assert.equal(fixture.runtime.events().filter(
      (event) => event.source.externalId === `scheduled-run:${run.runId}`
    ).length, 1);
    assert.match(fixture.schedules.requireRun(run.runId).executionId ?? "", /^exe_/);
  } finally {
    fixture.close();
  }
});

test("fixed Session is carried by the admitted Event", async () => {
  const fixture = setup();
  try {
    const seed = fixture.runtime.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "fixed-session-seed" },
      agentId: fixture.agentId,
      prompt: "seed",
      createdAt: "2026-07-24T00:00:00.000Z"
    });
    complete(fixture.runtime, seed.event.eventId, "2026-07-24T00:01:00.000Z");
    const sessionId = fixture.runtime.audit(seed.event.eventId)!.session!.sessionId;
    const schedule = fixture.schedules.create({
      ...onceInput(fixture.agentId, "2026-07-24T01:00:00.000Z"),
      sessionPolicy: "fixed",
      fixedSessionId: sessionId
    }, "2026-07-24T00:02:00.000Z");

    await fixture.scheduler.runCycle("2026-07-24T01:00:00.000Z");
    const run = fixture.schedules.runs(schedule.definition.scheduleId)[0]!;
    assert.equal(fixture.runtime.event(run.eventId!)?.sessionId, sessionId);
  } finally {
    fixture.close();
  }
});

test("two schedules sharing a fixed Session cannot resume it concurrently", async () => {
  const fixture = setup();
  try {
    const seed = fixture.runtime.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "shared-fixed-session-seed" },
      agentId: fixture.agentId,
      prompt: "seed",
      createdAt: "2026-07-24T00:00:00.000Z"
    });
    complete(fixture.runtime, seed.event.eventId, "2026-07-24T00:01:00.000Z");
    const fixedSessionId = fixture.runtime.audit(seed.event.eventId)!.session!.sessionId;
    for (const prompt of ["first", "second"]) {
      fixture.schedules.create({
        ...onceInput(fixture.agentId, "2026-07-24T01:00:00.000Z"),
        sessionPolicy: "fixed",
        fixedSessionId,
        overlapPolicy: "queue",
        prompt
      }, "2026-07-24T00:02:00.000Z");
    }
    const result = await fixture.scheduler.runCycle("2026-07-24T01:00:00.000Z");
    assert.equal(result.admitted.length, 1);
    assert.equal(result.queued.length, 1);
    assert.equal(fixture.runtime.events().filter(
      (event) => event.source.kind === "schedule"
    ).length, 1);
    assert.equal(fixture.schedules.pendingRuns().length, 1);
  } finally {
    fixture.close();
  }
});

test("Execution retry stays on the same ScheduledRun and Event", async () => {
  const fixture = setup();
  try {
    const schedule = fixture.schedules.create(
      onceInput(fixture.agentId, "2026-07-24T01:00:00.000Z"),
      "2026-07-24T00:00:00.000Z"
    );
    await fixture.scheduler.runCycle("2026-07-24T01:00:00.000Z");
    const run = fixture.schedules.runs(schedule.definition.scheduleId)[0]!;
    const execution = fixture.runtime.claimDueExecutions(
      1,
      "2026-07-24T01:01:00.000Z"
    )[0]!;
    fixture.runtime.failExecution(
      execution.executionId,
      "temporary provider failure",
      "2026-07-24T01:01:00.000Z",
      1_000
    );
    await fixture.scheduler.runCycle("2026-07-24T01:01:00.500Z");
    assert.equal(fixture.schedules.runs(schedule.definition.scheduleId).length, 1);
    assert.equal(fixture.schedules.requireRun(run.runId).eventId, run.eventId);
    assert.equal(
      fixture.runtime.execution(execution.executionId)?.status,
      "retry_wait"
    );
  } finally {
    fixture.close();
  }
});

test("public CLI cannot create a legacy one-shot outside Steward source binding", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-schedule-loop-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-schedule-loop-runtime-"));
  try {
    addLocalAgent(repo, "alice", "codex", { runtimeDirectory });
    const scheduleFile = join(runtimeDirectory, "schedule.json");
    await assert.rejects(
      runLocalApp(repo, [
        "--runtime", runtimeDirectory, "schedule", "create", scheduleFile
      ]),
      /legacy_trigger_write_closed/
    );
    const schedules = new ScheduledTaskStore(runtimePaths(repo, runtimeDirectory).database);
    try {
      assert.deepEqual(schedules.list(), []);
    } finally {
      schedules.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

function setup(
  invalid: () => string | undefined = () => undefined
): {
  readonly database: string;
  readonly agentId: string;
  readonly schedules: ScheduledTaskStore;
  readonly runtime: RuntimeStore;
  readonly scheduler: ScheduledTaskRuntime;
  readonly close: () => void;
} {
  const root = temporaryDirectory("rollerskate-schedule-runtime-");
  const database = join(root, "runtime.sqlite");
  const runtime = new RuntimeStore(database);
  const foundation = new LocalFoundationStore(database);
  const agent = foundation.addAgent("scheduler", "codex", "2026-07-24T00:00:00.000Z");
  const schedules = new ScheduledTaskStore(database);
  const scheduler = new ScheduledTaskRuntime({
    store: schedules,
    runtime,
    validateTarget: invalid
  });
  return {
    database,
    agentId: agent.principalId,
    schedules,
    runtime,
    scheduler,
    close() {
      schedules.close();
      runtime.close();
      foundation.close();
    }
  };
}

function onceInput(agentId: string, expression: string): CreateScheduleInput {
  return {
    ownerPrincipalId: agentId,
    agentId,
    kind: "once",
    expression,
    misfirePolicy: "run_once",
    overlapPolicy: "queue",
    misfireGraceMilliseconds: 60_000,
    sessionPolicy: "new_each_run",
    prompt: "Run report",
    workspace: "/workspace"
  };
}

function cronInput(
  agentId: string,
  policy: Pick<CreateScheduleInput, "misfirePolicy" | "overlapPolicy">
): CreateScheduleInput {
  return {
    ownerPrincipalId: agentId,
    agentId,
    kind: "cron",
    expression: "0 * * * *",
    timezone: "UTC",
    ...policy,
    misfireGraceMilliseconds: 0,
    sessionPolicy: "new_each_run",
    prompt: "Run report",
    workspace: "/workspace"
  };
}

function complete(runtime: RuntimeStore, eventId: string, at: string): void {
  const execution = runtime.claimDueExecutions(1, at)[0]!;
  assert.equal(execution.eventId, eventId);
  runtime.completeExecution(execution.executionId, {
    adapterId: "fake-agent-v1",
    workspace: "/workspace",
    providerSessionId: `provider-${eventId}`,
    output: "done"
  }, at);
}
