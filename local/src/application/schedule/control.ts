import { statSync } from "node:fs";

import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import type {
  CreateScheduleInput,
  ScheduledRun,
  Schedule,
  ScheduleRevisionInput,
  UpdateScheduleInput
} from "../../capabilities/scheduled-task/model.js";
import {
  ScheduledTaskStore,
  type InsertScheduledRunReceipt
} from "../../capabilities/scheduled-task/store.js";
import type { RuntimeAudit, RuntimeStore } from "../../core/runtime/store.js";
import { RuntimeStore as RuntimeStoreImplementation } from "../../core/runtime/store.js";

export interface ScheduleControlInput extends Omit<ScheduleRevisionInput, "agentId" | "workspace"> {
  readonly agent: string;
}

export interface UpdateScheduleControlInput extends ScheduleControlInput {
  readonly expectedRevision: number;
}

export interface ScheduleInspection {
  readonly schedule: Schedule;
  readonly owner: LocalAgent;
  readonly agent: LocalAgent;
  readonly runs: readonly ScheduledRunInspection[];
}

export interface ScheduledRunInspection {
  readonly run: ScheduledRun;
  readonly audit?: RuntimeAudit;
}

export function createSchedule(
  repoRoot: string,
  input: ScheduleControlInput,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): ScheduleInspection {
  return withStores(repoRoot, runtimeDirectory, (stores) => {
    const agent = requireActiveAgent(stores.foundation, input.agent);
    validateTarget(stores, agent, input);
    const create: CreateScheduleInput = {
      ownerPrincipalId: agent.principalId,
      agentId: agent.principalId,
      ...revisionInput(input, stores.workspace)
    };
    const schedule = stores.schedules.create(create, at);
    return inspection(schedule, stores);
  });
}

export function updateSchedule(
  repoRoot: string,
  scheduleId: string,
  input: UpdateScheduleControlInput,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): ScheduleInspection {
  return withStores(repoRoot, runtimeDirectory, (stores) => {
    const agent = requireActiveAgent(stores.foundation, input.agent);
    validateTarget(stores, agent, input);
    const update: UpdateScheduleInput = {
      expectedRevision: input.expectedRevision,
      agentId: agent.principalId,
      ...revisionInput(input, stores.workspace)
    };
    const schedule = stores.schedules.update(scheduleId, update, at);
    return inspection(schedule, stores);
  });
}

export function listSchedules(
  repoRoot: string,
  runtimeDirectory?: string
): ScheduleInspection[] {
  return withStores(repoRoot, runtimeDirectory, (stores) =>
    stores.schedules.list().map((schedule) => inspection(schedule, stores))
  );
}

export function inspectSchedule(
  repoRoot: string,
  scheduleId: string,
  runtimeDirectory?: string
): ScheduleInspection {
  return withStores(repoRoot, runtimeDirectory, (stores) =>
    inspection(stores.schedules.require(scheduleId), stores)
  );
}

export function controlSchedule(
  repoRoot: string,
  scheduleId: string,
  action: "pause" | "resume" | "cancel",
  runtimeDirectory?: string,
  at = new Date().toISOString()
): ScheduleInspection {
  return withStores(repoRoot, runtimeDirectory, (stores) =>
    inspection(stores.schedules.setStatus(scheduleId, action, at), stores)
  );
}

export function runScheduleNow(
  repoRoot: string,
  scheduleId: string,
  requestId: string,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): InsertScheduledRunReceipt {
  return withStores(repoRoot, runtimeDirectory, (stores) => {
    const schedule = stores.schedules.require(scheduleId);
    const idempotencyKey = text(requestId, "requestId", 256);
    const occurrenceKey = `manual:${idempotencyKey}`;
    const existing = stores.schedules.runForOccurrence(scheduleId, occurrenceKey);
    if (existing !== undefined) return { run: existing, status: "duplicate" };
    if (schedule.definition.status === "cancelled" ||
      schedule.definition.status === "completed") {
      throw new Error(
        `Schedule cannot run now from ${schedule.definition.status}: ${scheduleId}`
      );
    }
    const active = stores.schedules.unterminatedRuns(scheduleId)
      .some((run) => run.eventId !== undefined) ||
      (schedule.revision.fixedSessionId !== undefined &&
        stores.schedules.hasActiveFixedSessionRun(schedule.revision.fixedSessionId));
    const status = active && schedule.revision.overlapPolicy === "skip"
      ? "skipped"
      : "queued";
    return stores.schedules.insertRun({
      scheduleId,
      occurrenceKey,
      scheduledFor: at,
      scheduleRevision: schedule.definition.currentRevision,
      status,
      decisionReason: status === "skipped" ? "manual-overlap-skip" : "manual",
      createdAt: at
    });
  });
}

export function listScheduledRuns(
  repoRoot: string,
  scheduleId: string,
  runtimeDirectory?: string,
  limit = 100
): ScheduledRunInspection[] {
  return withStores(repoRoot, runtimeDirectory, (stores) =>
    stores.schedules.runs(scheduleId, limit).map((run) => runInspection(run, stores.runtime))
  );
}

export function traceScheduledRun(
  repoRoot: string,
  runId: string,
  runtimeDirectory?: string
): ScheduledRunInspection {
  return withStores(repoRoot, runtimeDirectory, (stores) =>
    runInspection(stores.schedules.requireRun(runId), stores.runtime)
  );
}

export function resolveUnknownScheduledRun(
  repoRoot: string,
  runId: string,
  outcome: "succeeded" | "failed",
  runtimeDirectory?: string,
  at = new Date().toISOString()
): ScheduledRunInspection {
  return withStores(repoRoot, runtimeDirectory, (stores) => {
    const run = stores.schedules.requireRun(runId);
    if (run.status !== "unknown") {
      throw new Error(`Scheduled run is not unknown: ${runId}`);
    }
    const resolved = stores.schedules.patchRun(runId, {
      status: outcome,
      decisionReason: `manual-resolved-${outcome}`,
      completedAt: at
    }, at);
    return runInspection(resolved, stores.runtime);
  });
}

interface Stores {
  readonly schedules: ScheduledTaskStore;
  readonly runtime: RuntimeStore;
  readonly foundation: LocalFoundationStore;
  readonly workspace: string;
}

function withStores<T>(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  callback: (stores: Stores) => T
): T {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const foundation = new LocalFoundationStore(paths.database);
  const runtime = new RuntimeStoreImplementation(paths.database);
  const schedules = new ScheduledTaskStore(paths.database);
  try {
    const local = foundation.foundation();
    if (local === undefined) throw new Error("Local foundation is not initialized");
    if (!statSync(local.workspacePath).isDirectory()) {
      throw new Error(`Local workspace is not a directory: ${local.workspacePath}`);
    }
    return callback({
      schedules,
      runtime,
      foundation,
      workspace: local.workspacePath
    });
  } finally {
    schedules.close();
    runtime.close();
    foundation.close();
  }
}

function inspection(schedule: Schedule, stores: Stores): ScheduleInspection {
  const owner = stores.foundation.agent(schedule.definition.ownerPrincipalId);
  if (owner === undefined) {
    throw new Error(`Schedule owner Agent not found: ${schedule.definition.ownerPrincipalId}`);
  }
  const agent = stores.foundation.agent(schedule.revision.agentId);
  if (agent === undefined) {
    throw new Error(`Schedule target Agent not found: ${schedule.revision.agentId}`);
  }
  return {
    schedule,
    owner,
    agent,
    runs: stores.schedules.runs(schedule.definition.scheduleId)
      .map((run) => runInspection(run, stores.runtime))
  };
}

function runInspection(run: ScheduledRun, runtime: RuntimeStore): ScheduledRunInspection {
  const audit = run.eventId === undefined ? undefined : runtime.audit(run.eventId);
  return {
    run,
    ...(audit === undefined ? {} : { audit })
  };
}

function requireActiveAgent(foundation: LocalFoundationStore, handle: string): LocalAgent {
  const agent = foundation.agentByHandle(handle);
  if (agent === undefined) throw new Error(`Local Agent not found: ${handle}`);
  if (agent.status !== "active") throw new Error(`Local Agent is not active: ${handle}`);
  return agent;
}

function validateTarget(
  stores: Pick<Stores, "runtime" | "workspace">,
  agent: LocalAgent,
  input: ScheduleControlInput
): void {
  if (input.sessionPolicy !== "fixed") return;
  if (input.fixedSessionId === undefined) {
    throw new Error("fixed session policy requires fixedSessionId");
  }
  const session = stores.runtime.session(input.fixedSessionId);
  if (session === undefined) throw new Error(`Session not found: ${input.fixedSessionId}`);
  if (session.agentId !== agent.principalId || session.workspace !== stores.workspace) {
    throw new Error(`Session does not belong to Agent ${agent.handle} and Local workspace`);
  }
}

function revisionInput(
  input: ScheduleControlInput,
  workspace: string
): Omit<ScheduleRevisionInput, "agentId"> {
  return {
    kind: input.kind,
    expression: input.expression,
    ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
    misfirePolicy: input.misfirePolicy,
    overlapPolicy: input.overlapPolicy,
    misfireGraceMilliseconds: input.misfireGraceMilliseconds,
    sessionPolicy: input.sessionPolicy,
    ...(input.fixedSessionId === undefined ? {} : { fixedSessionId: input.fixedSessionId }),
    prompt: input.prompt,
    workspace
  };
}

function text(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${field} must be a non-empty string`);
  if (normalized.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  return normalized;
}
