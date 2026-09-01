import { statSync } from "node:fs";

import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import type {
  CreateScheduleInput,
  ScheduleOccurrence,
  Schedule,
  ScheduleRevisionInput,
  UpdateScheduleInput
} from "../../capabilities/scheduled-task/model.js";
import {
  ScheduledTaskStore,
  type InsertScheduledRunReceipt
} from "../../capabilities/scheduled-task/store.js";
import type { RuntimeAudit, RuntimeStore } from "../../core/runtime/store.js";
import type { RuntimeDelivery } from "../../core/runtime/model.js";
import type { ProactiveCallbackOccurrence } from "../../modules/callback/proactive-model.js";
import { RuntimeStore as RuntimeStoreImplementation } from "../../core/runtime/store.js";
import { scheduleRunBindingAdapter } from "./source-binding.js";
import { activateScheduleOccurrenceInTransaction } from
  "../../capabilities/scheduled-task/run-binding.js";
import type {
  AgentRunCycleProjection,
  AgentRunProjection
} from "../../modules/steward/state-machine.js";

export interface ScheduleControlInput extends Omit<ScheduleRevisionInput, "agentId" | "workspace"> {
  readonly agent: string;
}

export interface UpdateScheduleControlInput extends ScheduleControlInput {
  readonly expectedRevision: number;
}

export interface ScheduleInspection {
  readonly schedule: Schedule;
  readonly owner: LocalAgent;
  readonly agent?: LocalAgent;
  readonly runs: readonly ScheduleOccurrenceInspection[];
}

export interface ScheduleOccurrenceInspection {
  readonly run: ScheduleOccurrence;
  readonly audit?: RuntimeAudit;
  readonly agentRun?: AgentRunProjection;
  readonly cycle?: AgentRunCycleProjection;
  readonly callbacks: readonly {
    readonly occurrence: ProactiveCallbackOccurrence;
    readonly delivery?: RuntimeDelivery;
  }[];
}

/** @deprecated Use ScheduleOccurrenceInspection. */
export type ScheduledRunInspection = ScheduleOccurrenceInspection;

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

export function inspectSchedules(
  repoRoot: string,
  scheduleIds: readonly string[],
  runtimeDirectory?: string
): ScheduleInspection[] {
  if (scheduleIds.length > 100) throw new Error("scheduleIds exceeds 100 items");
  return withStores(repoRoot, runtimeDirectory, (stores) =>
    scheduleIds.map((scheduleId) => inspection(stores.schedules.require(scheduleId), stores))
  );
}

export function controlSchedule(
  repoRoot: string,
  scheduleId: string,
  action: "pause" | "resume" | "cancel",
  runtimeDirectory?: string,
  at = new Date().toISOString()
): ScheduleInspection {
  return withStores(repoRoot, runtimeDirectory, (stores) => {
    const current = stores.schedules.require(scheduleId);
    if (action === "resume" && current.revision.schemaVersion !== "ScheduleRevision@2") {
      throw new Error("legacy_trigger_execution_closed: migrate this Schedule to a bound Run");
    }
    return inspection(stores.schedules.setStatus(scheduleId, action, at), stores);
  });
}

export function setScheduleArchived(
  repoRoot: string,
  scheduleId: string,
  archived: boolean,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): { readonly inspection: ScheduleInspection; readonly changed: boolean } {
  return withStores(repoRoot, runtimeDirectory, (stores) => {
    const result = stores.schedules.setArchived(scheduleId, archived, at);
    return { inspection: inspection(result.schedule, stores), changed: result.changed };
  });
}

export function runScheduleNow(
  repoRoot: string,
  scheduleId: string,
  requestId: string,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): InsertScheduledRunReceipt {
  return withStores(repoRoot, runtimeDirectory, (stores) => {
    return stores.runtime.withImmediateTransaction(() => {
      const schedule = stores.schedules.require(scheduleId);
      if (schedule.revision.schemaVersion !== "ScheduleRevision@2") {
        throw new Error("legacy_trigger_execution_closed: migrate this Schedule to a bound Run");
      }
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
      const boundState = stores.runs.projection(schedule.revision.sourceBinding.runId);
      if (boundState === undefined) {
        throw new Error(`Bound Agent Run not found: ${schedule.revision.sourceBinding.runId}`);
      }
      if (boundState !== undefined && [
        "succeeded", "failed", "needs_human", "cancelled"
      ].includes(boundState.status)) {
        throw new Error(`Bound Agent Run is terminal: ${boundState.runId}`);
      }
      const active = boundState.status !== "awaiting_source" ||
        boundState.activeCycleId !== undefined;
      const pendingBoundOccurrence = active && schedule.revision.overlapPolicy === "queue"
        ? stores.schedules.pendingRuns().find((run) => run.scheduleId === scheduleId)
        : undefined;
      const status = pendingBoundOccurrence !== undefined ||
        (active && schedule.revision.overlapPolicy === "skip")
        ? "skipped"
        : "queued";
      const inserted = stores.schedules.insertRun({
        scheduleId,
        occurrenceKey,
        scheduledFor: at,
        scheduleRevision: schedule.definition.currentRevision,
        status,
        agentRunId: schedule.revision.sourceBinding.runId,
        decisionReason: pendingBoundOccurrence !== undefined
          ? `manual-overlap-coalesced:${pendingBoundOccurrence.runId}`
          : status === "skipped"
            ? "manual-overlap-skip"
            : "manual",
        createdAt: at
      });
      if (inserted.status === "duplicate" || status === "skipped" || active) {
        return inserted;
      }
      if (schedule.revision.externalRefBinding !== undefined) {
        throw new Error("Run-now cannot bypass Schedule external-ref freshness admission");
      }
      return {
        status: "accepted",
        run: activateScheduleOccurrenceInTransaction({
          store: stores.schedules,
          adapter: scheduleRunBindingAdapter({
            runtime: stores.runtime,
            runs: stores.runs
          }),
          occurrence: inserted.run,
          revision: schedule.revision,
          freshnessEvidence: [
            `schedule-definition:${schedule.revision.sourceBinding.source.definitionRevision}`
          ],
          at
        })
      };
    });
  });
}

export function listScheduleOccurrences(
  repoRoot: string,
  scheduleId: string,
  runtimeDirectory?: string,
  limit = 100
): ScheduleOccurrenceInspection[] {
  return withStores(repoRoot, runtimeDirectory, (stores) =>
    stores.schedules.runs(scheduleId, limit).map((run) => runInspection(run, stores))
  );
}

export function traceScheduleOccurrence(
  repoRoot: string,
  runId: string,
  runtimeDirectory?: string
): ScheduleOccurrenceInspection {
  return withStores(repoRoot, runtimeDirectory, (stores) =>
    runInspection(stores.schedules.requireRun(runId), stores)
  );
}

export function resolveUnknownScheduledRun(
  repoRoot: string,
  runId: string,
  outcome: "succeeded" | "failed",
  runtimeDirectory?: string,
  at = new Date().toISOString()
): ScheduleOccurrenceInspection {
  return withStores(repoRoot, runtimeDirectory, (stores) => {
    const resolved = stores.schedules.resolveUnknownRun(runId, outcome, at);
    return runInspection(resolved, stores);
  });
}

interface Stores {
  readonly schedules: ScheduledTaskStore;
  readonly runtime: RuntimeStore;
  readonly runs: AgentRunStore;
  readonly foundation: LocalFoundationStore;
  readonly workspace: string;
}

function withStores<T>(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  callback: (stores: Stores) => T
): T {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const database = openRuntimeDatabase(paths.database);
  const foundation = new LocalFoundationStore(database);
  const runtime = new RuntimeStoreImplementation(database);
  const runs = new AgentRunStore(database);
  const schedules = new ScheduledTaskStore(database);
  try {
    const local = foundation.foundation();
    if (local === undefined) throw new Error("Local foundation is not initialized");
    if (!statSync(local.workspacePath).isDirectory()) {
      throw new Error(`Local workspace is not a directory: ${local.workspacePath}`);
    }
    return callback({
      schedules,
      runtime,
      runs,
      foundation,
      workspace: local.workspacePath
    });
  } finally {
    schedules.close();
    runs.close();
    runtime.close();
    foundation.close();
    database.close();
  }
}

function inspection(schedule: Schedule, stores: Stores): ScheduleInspection {
  const owner = stores.foundation.agent(schedule.definition.ownerPrincipalId);
  if (owner === undefined) {
    throw new Error(`Schedule owner Agent not found: ${schedule.definition.ownerPrincipalId}`);
  }
  const agent = schedule.revision.schemaVersion === "ScheduleRevision@1"
    ? stores.foundation.agent(schedule.revision.agentId)
    : undefined;
  if (schedule.revision.schemaVersion === "ScheduleRevision@1" && agent === undefined) {
    throw new Error(`Schedule target Agent not found: ${schedule.revision.agentId}`);
  }
  return {
    schedule,
    owner,
    ...(agent === undefined ? {} : { agent }),
    runs: stores.schedules.runs(schedule.definition.scheduleId)
      .map((run) => runInspection(run, stores))
  };
}

function runInspection(
  run: ScheduleOccurrence,
  stores: Pick<Stores, "runtime" | "schedules" | "runs">
): ScheduleOccurrenceInspection {
  const audit = run.eventId === undefined ? undefined : stores.runtime.audit(run.eventId);
  const agentRun = run.agentRunId === undefined
    ? undefined
    : stores.runs.projection(run.agentRunId);
  const cycle = run.cycleId === undefined ? undefined : stores.runs.cycle(run.cycleId);
  const callbacks = stores.schedules.callbackOccurrences(run).map((occurrence) => {
    const deliveryId = callbackDeliveryId(occurrence.receipt);
    const delivery = deliveryId === undefined ? undefined : stores.runtime.delivery(deliveryId);
    return {
      occurrence,
      ...(delivery === undefined ? {} : { delivery })
    };
  });
  return {
    run,
    ...(audit === undefined ? {} : { audit }),
    ...(agentRun === undefined ? {} : { agentRun }),
    ...(cycle === undefined ? {} : { cycle }),
    callbacks
  };
}

/** @deprecated Use listScheduleOccurrences. */
export const listScheduledRuns = listScheduleOccurrences;

/** @deprecated Use traceScheduleOccurrence. */
export const traceScheduledRun = traceScheduleOccurrence;

function callbackDeliveryId(receipt: unknown): string | undefined {
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return undefined;
  const deliveryId = (receipt as Record<string, unknown>).deliveryId;
  return typeof deliveryId === "string" ? deliveryId : undefined;
}

function requireActiveAgent(foundation: LocalFoundationStore, handle: string): LocalAgent {
  const agent = foundation.agentByHandle(handle);
  if (agent === undefined) throw new Error(`Local Agent not found: ${handle}`);
  if (agent.status !== "active") throw new Error(`Local Agent is not active: ${handle}`);
  return agent;
}

function validateTarget(
  stores: Pick<Stores, "runtime" | "workspace" | "foundation">,
  agent: LocalAgent,
  input: ScheduleControlInput
): void {
  if (input.sessionPolicy === "fixed") {
    if (input.fixedSessionId === undefined) {
      throw new Error("fixed session policy requires fixedSessionId");
    }
    const session = stores.runtime.session(input.fixedSessionId);
    if (session === undefined) throw new Error(`Session not found: ${input.fixedSessionId}`);
    if (session.agentId !== agent.principalId || session.workspace !== stores.workspace) {
      throw new Error(`Session does not belong to Agent ${agent.handle} and Local workspace`);
    }
  }
  for (const callback of input.callbacks ?? []) {
    if (callback.kind !== "agent.invoke") continue;
    const agentId = String(callback.definition.agentId);
    const target = stores.foundation.agent(agentId);
    if (target === undefined || target.status !== "active") {
      throw new Error(`Schedule callback Agent is unavailable: ${agentId}`);
    }
    if (callback.definition.workspace !== stores.workspace) {
      throw new Error("Schedule callback workspace must equal the Local workspace");
    }
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
    workspace,
    ...(input.callbacks === undefined ? {} : { callbacks: input.callbacks }),
    ...(input.externalRefBinding === undefined
      ? {}
      : { externalRefBinding: input.externalRefBinding })
  };
}

function text(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${field} must be a non-empty string`);
  if (normalized.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  return normalized;
}
