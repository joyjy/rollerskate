import type {
  ScheduledRunStatus,
  ScheduleStatus
} from "../../capabilities/scheduled-task/model.js";
import type { DatabaseSync } from "node:sqlite";
import { ScheduledTaskStore } from "../../capabilities/scheduled-task/store.js";
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
  inspectSchedules,
  listScheduleOccurrences,
  listSchedules,
  traceScheduleOccurrence,
  type ScheduleOccurrenceInspection,
  type ScheduleInspection
} from "./control.js";
import {
  literalLikePattern,
  normalizeListPageInput,
  type ListPage,
  type ListPageInput
} from "../list-page.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import type { ProactiveTarget } from "../../modules/proactive/target.js";
import { proactiveTargetRunBinding } from "../../modules/proactive/target.js";
import type { RunSourceBinding } from "../../modules/steward/source-contract.js";

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
  readonly sessionPolicy: "new_each_run" | "fixed" | null;
  readonly fixedSessionId: string | null;
  readonly owner: AgentReferenceView;
  readonly agent: AgentReferenceView | null;
  readonly sourceBinding: RunSourceBinding | null;
  readonly target: ProactiveTarget | null;
  readonly runCounts: Readonly<Record<ScheduledRunStatus, number>>;
  readonly availableActions: {
    readonly pause: boolean;
    readonly resume: boolean;
    readonly cancel: boolean;
    readonly runNow: boolean;
    readonly archive: boolean;
    readonly unarchive: boolean;
  };
  readonly archivedAt: string | null;
  readonly updatedAt: string;
}

export interface ScheduleDetailView {
  readonly summary: ScheduleSummaryView;
  readonly revision: {
    readonly revision: number;
    readonly misfirePolicy: "skip" | "run_once";
    readonly overlapPolicy: "skip" | "queue";
    readonly misfireGraceMilliseconds: number;
    readonly prompt: string | null;
    readonly workspace: string | null;
    readonly externalRefBinding: ScheduleInspection["schedule"]["revision"]["externalRefBinding"] | null;
    readonly callbacks: readonly unknown[];
    readonly createdAt: string;
  };
  readonly runs: readonly ScheduleOccurrenceView[];
}

export interface ScheduleOccurrenceView {
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
  readonly agentRunId: string | null;
  readonly cycleId: string | null;
  readonly agentRunStatus: string | null;
  readonly cycleStatus: string | null;
  readonly admissionReceipt: ScheduleOccurrenceInspection["run"]["admissionReceipt"] | null;
  readonly actionReceipt: ScheduleOccurrenceInspection["run"]["actionReceipt"] | null;
  readonly externalWorkflowExecution: ScheduleOccurrenceInspection["externalWorkflowExecution"] | null;
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

export interface ScheduleRunSourceView {
  readonly status: ScheduleStatus;
  readonly nextRunAt: string | null;
  readonly occurrence: {
    readonly runId: string;
    readonly occurrenceKey: string;
    readonly status: ScheduledRunStatus;
    readonly agentRunId: string | null;
    readonly cycleId: string | null;
    readonly updatedAt: string;
    readonly failureRef: string | null;
  } | null;
}

/** @deprecated Use ScheduleOccurrenceView. */
export type ScheduledRunView = ScheduleOccurrenceView;

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

export function pageScheduleViews(
  repoRoot: string,
  input: ListPageInput = {},
  runtimeDirectory?: string
): ListPage<ScheduleSummaryView> {
  const query = normalizeListPageInput(input);
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  const where = `
    ($archive = 'all'
      OR ($archive = 'current' AND schedule.archived_at IS NULL)
      OR ($archive = 'archived' AND schedule.archived_at IS NOT NULL))
    AND ($search = ''
      OR schedule.schedule_id LIKE $pattern ESCAPE '\\'
      OR schedule.status LIKE $pattern ESCAPE '\\'
      OR schedule.kind LIKE $pattern ESCAPE '\\'
      OR schedule.expression LIKE $pattern ESCAPE '\\'
      OR COALESCE(schedule.timezone, '') LIKE $pattern ESCAPE '\\'
      OR owner.handle LIKE $pattern ESCAPE '\\'
      OR COALESCE(target.handle, '') LIKE $pattern ESCAPE '\\')
  `;
  const filterParameters = {
    archive: query.archive,
    search: query.search,
    pattern: literalLikePattern(query.search)
  };
  try {
    database.exec("BEGIN");
    const total = Number((database.prepare(`
      SELECT COUNT(*) AS count
      FROM schedules AS schedule
      JOIN agents AS owner ON owner.principal_id = schedule.owner_principal_id
      LEFT JOIN agents AS target ON target.principal_id = schedule.agent_id
      WHERE ${where}
    `).get(filterParameters) as { count: number }).count);
    const ids = database.prepare(`
      SELECT schedule.schedule_id
      FROM schedules AS schedule
      JOIN agents AS owner ON owner.principal_id = schedule.owner_principal_id
      LEFT JOIN agents AS target ON target.principal_id = schedule.agent_id
      WHERE ${where}
      ORDER BY schedule.updated_at DESC, schedule.schedule_id DESC
      LIMIT $pageSize OFFSET $offset
    `).all({
      ...filterParameters,
      pageSize: query.pageSize,
      offset: query.offset
    }) as unknown as Array<{ schedule_id: string }>;
    database.exec("COMMIT");
    return {
      items: inspectSchedules(
        repoRoot,
        ids.map(({ schedule_id }) => schedule_id),
        runtimeDirectory
      ).map(scheduleSummaryView),
      total,
      page: query.page,
      pageSize: query.pageSize
    };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export function inspectScheduleView(
  repoRoot: string,
  scheduleId: string,
  runtimeDirectory?: string
): ScheduleDetailView {
  return scheduleDetailView(inspectSchedule(repoRoot, scheduleId, runtimeDirectory));
}

export function inspectScheduleViewForRunSource(
  database: DatabaseSync,
  scheduleId: string
): ScheduleRunSourceView {
  const store = new ScheduledTaskStore(database, { migrate: false });
  try {
    const schedule = store.require(scheduleId);
    const occurrence = store.runs(scheduleId, 1)[0];
    return {
      status: schedule.definition.status,
      nextRunAt: schedule.definition.nextRunAt ?? null,
      occurrence: occurrence === undefined
        ? null
        : {
            runId: occurrence.runId,
            occurrenceKey: occurrence.occurrenceKey,
            status: occurrence.status,
            agentRunId: occurrence.agentRunId ?? null,
            cycleId: occurrence.cycleId ?? null,
            updatedAt: occurrence.updatedAt,
            failureRef: occurrence.status === "unknown" &&
              occurrence.agentRunId === undefined
              ? runtimeFailureRef("schedule", occurrence.runId)
              : null
          }
    };
  } finally {
    store.close();
  }
}

export function listScheduleOccurrenceViews(
  repoRoot: string,
  scheduleId: string,
  runtimeDirectory?: string,
  limit = 100
): readonly ScheduleOccurrenceView[] {
  return listScheduleOccurrences(repoRoot, scheduleId, runtimeDirectory, limit)
    .map(scheduleOccurrenceView);
}

export function traceScheduleOccurrenceView(
  repoRoot: string,
  runId: string,
  runtimeDirectory?: string
): ScheduleOccurrenceView {
  return scheduleOccurrenceView(
    traceScheduleOccurrence(repoRoot, runId, runtimeDirectory)
  );
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
    sessionPolicy: revision.sessionPolicy ?? null,
    fixedSessionId: revision.fixedSessionId ?? null,
    owner: agentReference(inspection.owner),
    agent: inspection.agent === undefined ? null : agentReference(inspection.agent),
    sourceBinding: revision.schemaVersion === "ScheduleRevision@2"
      ? revision.sourceBinding
      : revision.schemaVersion === "ScheduleRevision@3"
        ? proactiveTargetRunBinding(revision.target) ?? null
        : null,
    target: revision.schemaVersion === "ScheduleRevision@3" ? revision.target : null,
    runCounts,
    availableActions: {
      pause: definition.status === "active",
      resume: definition.status === "paused",
      cancel: definition.status === "active" || definition.status === "paused",
      runNow: definition.status === "active" || definition.status === "paused",
      archive: definition.archivedAt === undefined &&
        (definition.status === "completed" || definition.status === "cancelled"),
      unarchive: definition.archivedAt !== undefined
    },
    archivedAt: definition.archivedAt ?? null,
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
      prompt: revision.prompt ?? null,
      workspace: revision.workspace ?? null,
      externalRefBinding: revision.externalRefBinding ?? null,
      callbacks: revision.callbacks ?? [],
      createdAt: revision.createdAt
    },
    runs: inspection.runs.map(scheduleOccurrenceView)
  };
}

export function scheduleOccurrenceView(
  inspection: ScheduleOccurrenceInspection
): ScheduleOccurrenceView {
  const run = inspection.run;
  const resolvable = run.status === "unknown" && run.agentRunId === undefined;
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
    agentRunId: run.agentRunId ?? null,
    cycleId: run.cycleId ?? null,
    agentRunStatus: inspection.agentRun?.status ?? null,
    cycleStatus: inspection.cycle?.status ?? null,
    admissionReceipt: run.admissionReceipt ?? null,
    actionReceipt: run.actionReceipt ?? null,
    externalWorkflowExecution: inspection.externalWorkflowExecution ?? null,
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

/** @deprecated Use listScheduleOccurrenceViews. */
export const listScheduledRunViews = listScheduleOccurrenceViews;

/** @deprecated Use traceScheduleOccurrenceView. */
export const traceScheduledRunView = traceScheduleOccurrenceView;

/** @deprecated Use scheduleOccurrenceView. */
export const scheduledRunView = scheduleOccurrenceView;

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
