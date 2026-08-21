import type {
  ScheduledRunStatus,
  ScheduleStatus
} from "../../capabilities/scheduled-task/model.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import {
  eventTraceViews,
  type EventTraceView
} from "../event/query.js";
import {
  runtimeFailureConsoleRoute,
  runtimeFailureRef
} from "../runtime/failure-query.js";
import {
  inspectSchedule,
  listScheduledRuns,
  listSchedules,
  traceScheduledRun,
  type ScheduledRunInspection,
  type ScheduleInspection
} from "./control.js";

export interface ScheduleSummaryView {
  readonly scheduleId: string;
  readonly status: ScheduleStatus;
  readonly statusReason: string;
  readonly currentRevision: number;
  readonly nextRunAt: string | null;
  readonly nextOccurrenceMissing: boolean;
  readonly kind: "once" | "cron";
  readonly expression: string;
  readonly timezone: string | null;
  readonly sessionPolicy: "new_each_run" | "fixed";
  readonly fixedSessionId: string | null;
  readonly owner: AgentReferenceView;
  readonly agent: AgentReferenceView;
  readonly runCounts: Readonly<Record<ScheduledRunStatus, number>>;
  readonly availableActions: {
    readonly pause: boolean;
    readonly resume: boolean;
    readonly cancel: boolean;
    readonly runNow: boolean;
  };
  readonly updatedAt: string;
}

export interface ScheduleDetailView {
  readonly summary: ScheduleSummaryView;
  readonly revision: {
    readonly revision: number;
    readonly misfirePolicy: "skip" | "run_once";
    readonly overlapPolicy: "skip" | "queue";
    readonly misfireGraceMilliseconds: number;
    readonly prompt: string;
    readonly workspace: string;
    readonly externalRefBinding: ScheduleInspection["schedule"]["revision"]["externalRefBinding"] | null;
    readonly callbacks: ScheduleInspection["schedule"]["revision"]["callbacks"];
    readonly createdAt: string;
  };
  readonly runs: readonly ScheduledRunView[];
}

export interface ScheduledRunView {
  readonly runId: string;
  readonly scheduleId: string;
  readonly occurrenceKey: string;
  readonly scheduledFor: string;
  readonly scheduleRevision: number;
  readonly status: ScheduledRunStatus;
  readonly statusReason: string;
  readonly eventId: string | null;
  readonly executionId: string | null;
  readonly sessionId: string | null;
  readonly decisionReason: string | null;
  readonly callbacks: readonly ScheduledCallbackView[];
  readonly availableActions: {
    readonly resolveSucceeded: boolean;
    readonly resolveFailed: boolean;
  };
  readonly failure: {
    readonly failureRef: string;
    readonly consoleRoute: string;
  } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly audit: EventTraceView | null;
}

export interface ScheduledCallbackView {
  readonly occurrenceId: string;
  readonly callbackId: string;
  readonly ordinal: number;
  readonly kind: "agent.invoke" | "command.exec" | "destination.deliver";
  readonly status: "pending" | "started" | "succeeded" | "blocked" | "failed" | "unknown";
  readonly phase: "pending" | "admitted" | "terminal" | "unknown";
  readonly eventId: string | null;
  readonly deliveryId: string | null;
  readonly receipt: unknown | null;
  readonly lastError: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly delivery: {
    readonly status: "pending" | "delivering" | "retry_wait" | "delivered" | "failed";
    readonly attemptCount: number;
    readonly maxAttempts: number;
    readonly receipt: string | null;
    readonly lastError: string | null;
  } | null;
}

interface AgentReferenceView {
  readonly principalId: string;
  readonly handle: string;
  readonly client: LocalAgent["client"];
  readonly status: LocalAgent["status"];
}

export function listScheduleViews(
  repoRoot: string,
  runtimeDirectory?: string
): readonly ScheduleSummaryView[] {
  return listSchedules(repoRoot, runtimeDirectory).map(scheduleSummaryView);
}

export function inspectScheduleView(
  repoRoot: string,
  scheduleId: string,
  runtimeDirectory?: string
): ScheduleDetailView {
  return scheduleDetailView(inspectSchedule(repoRoot, scheduleId, runtimeDirectory));
}

export function listScheduledRunViews(
  repoRoot: string,
  scheduleId: string,
  runtimeDirectory?: string,
  limit = 100
): readonly ScheduledRunView[] {
  return listScheduledRuns(repoRoot, scheduleId, runtimeDirectory, limit)
    .map(scheduledRunView);
}

export function traceScheduledRunView(
  repoRoot: string,
  runId: string,
  runtimeDirectory?: string
): ScheduledRunView {
  return scheduledRunView(traceScheduledRun(repoRoot, runId, runtimeDirectory));
}

export function scheduleSummaryView(inspection: ScheduleInspection): ScheduleSummaryView {
  const definition = inspection.schedule.definition;
  const revision = inspection.schedule.revision;
  const runCounts = emptyRunCounts();
  for (const { run } of inspection.runs) runCounts[run.status] += 1;
  return {
    scheduleId: definition.scheduleId,
    status: definition.status,
    statusReason: scheduleStatusReason(definition.status),
    currentRevision: definition.currentRevision,
    nextRunAt: definition.nextRunAt ?? null,
    nextOccurrenceMissing: definition.nextOccurrenceMissing,
    kind: revision.kind,
    expression: revision.expression,
    timezone: revision.timezone ?? null,
    sessionPolicy: revision.sessionPolicy,
    fixedSessionId: revision.fixedSessionId ?? null,
    owner: agentReference(inspection.owner),
    agent: agentReference(inspection.agent),
    runCounts,
    availableActions: {
      pause: definition.status === "active",
      resume: definition.status === "paused",
      cancel: definition.status === "active" || definition.status === "paused",
      runNow: definition.status === "active" || definition.status === "paused"
    },
    updatedAt: definition.updatedAt
  };
}

export function scheduleDetailView(inspection: ScheduleInspection): ScheduleDetailView {
  const revision = inspection.schedule.revision;
  return {
    summary: scheduleSummaryView(inspection),
    revision: {
      revision: revision.revision,
      misfirePolicy: revision.misfirePolicy,
      overlapPolicy: revision.overlapPolicy,
      misfireGraceMilliseconds: revision.misfireGraceMilliseconds,
      prompt: revision.prompt,
      workspace: revision.workspace,
      externalRefBinding: revision.externalRefBinding ?? null,
      callbacks: revision.callbacks,
      createdAt: revision.createdAt
    },
    runs: inspection.runs.map(scheduledRunView)
  };
}

export function scheduledRunView(inspection: ScheduledRunInspection): ScheduledRunView {
  const run = inspection.run;
  const resolvable = run.status === "unknown";
  const failureRef = resolvable
    ? runtimeFailureRef("schedule", run.runId)
    : null;
  return {
    runId: run.runId,
    scheduleId: run.scheduleId,
    occurrenceKey: run.occurrenceKey,
    scheduledFor: run.scheduledFor,
    scheduleRevision: run.scheduleRevision,
    status: run.status,
    statusReason: runStatusReason(run.status, run.decisionReason),
    eventId: run.eventId ?? null,
    executionId: run.executionId ?? null,
    sessionId: run.sessionId ?? null,
    decisionReason: run.decisionReason ?? null,
    callbacks: inspection.callbacks.map(({ occurrence, delivery }) => ({
      occurrenceId: occurrence.occurrenceId,
      callbackId: occurrence.callbackId,
      ordinal: occurrence.ordinal,
      kind: occurrence.kind,
      status: occurrence.status,
      phase: occurrence.status === "pending"
        ? "pending"
        : occurrence.status === "started"
          ? "admitted"
          : occurrence.status === "unknown"
            ? "unknown"
            : "terminal",
      eventId: occurrence.eventId ?? null,
      deliveryId: delivery?.deliveryId ?? callbackDeliveryId(occurrence.receipt) ?? null,
      receipt: occurrence.receipt ?? null,
      lastError: occurrence.lastError ?? null,
      startedAt: occurrence.startedAt ?? null,
      completedAt: occurrence.completedAt ?? null,
      delivery: delivery === undefined
        ? null
        : {
            status: delivery.status,
            attemptCount: delivery.attemptCount,
            maxAttempts: delivery.maxAttempts,
            receipt: delivery.receipt ?? null,
            lastError: delivery.lastError ?? null
          }
    })),
    availableActions: {
      resolveSucceeded: resolvable,
      resolveFailed: resolvable
    },
    failure: failureRef === null
      ? null
      : {
          failureRef,
          consoleRoute: runtimeFailureConsoleRoute(failureRef)
        },
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt ?? null,
    audit: inspection.audit === undefined
      ? null
      : eventTraceViews([inspection.audit])[0]!
  };
}

function callbackDeliveryId(receipt: unknown): string | undefined {
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return undefined;
  const deliveryId = (receipt as Record<string, unknown>).deliveryId;
  return typeof deliveryId === "string" ? deliveryId : undefined;
}

function scheduleStatusReason(status: ScheduleStatus): string {
  if (status === "active") return "Future occurrences are eligible for admission.";
  if (status === "paused") return "Automatic occurrence admission is paused.";
  if (status === "completed") return "The one-shot Schedule completed and cannot run again.";
  return "The Schedule was cancelled and cannot admit new runs.";
}

function runStatusReason(status: ScheduledRunStatus, reason?: string): string {
  if (status === "queued") return "The run is waiting for Event admission.";
  if (status === "running") return "The admitted Event is still executing.";
  if (reason !== undefined) return reason;
  if (status === "succeeded") return "The provider outcome completed successfully.";
  if (status === "failed") return "The run reached a terminal failure.";
  if (status === "skipped") return "Policy skipped this occurrence.";
  return "The provider outcome is unknown and requires explicit reconciliation.";
}

function emptyRunCounts(): Record<ScheduledRunStatus, number> {
  return {
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    unknown: 0
  };
}

function agentReference(agent: LocalAgent): AgentReferenceView {
  return {
    principalId: agent.principalId,
    handle: agent.handle,
    client: agent.client,
    status: agent.status
  };
}
