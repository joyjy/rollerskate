import type { DatabaseSync } from "node:sqlite";
import { withImmediateTransaction } from "../../../infrastructure/sqlite/transaction.js";

import { requireRuntimeId } from "../../../core/runtime/model.js";
import { RuntimeStore } from "../../../core/runtime/store.js";
import {
  requireAgentRunCycleId,
  requireAgentRunId
} from "../../../modules/steward/state-machine.js";
import {
  newScheduledRunId,
  requireScheduleId,
  requireScheduleRevision,
  requireScheduledRunId,
  type ScheduledRun,
  type ScheduleOccurrenceAdmissionReceipt,
  type ScheduledRunStatus,
  type ScheduleRevision,
  type ScheduleStatus
} from "../model.js";
import {
  bounded,
  isUniqueConstraint,
  iso,
  mapRun,
  optionalText,
  parseScheduleOccurrenceAdmissionReceipt,
  scheduleDefinitionSnapshot,
  terminalRunStatus,
  text,
  validateRunStatus,
  type RunRow
} from "./codec.js";

export interface InsertScheduledRunInput {
  readonly scheduleId: string;
  readonly occurrenceKey: string;
  readonly scheduledFor: string;
  readonly scheduleRevision: number;
  readonly status: ScheduledRunStatus;
  readonly coalescedThrough?: string;
  readonly admittedAt?: string;
  readonly decisionReason?: string;
  readonly agentRunId?: string;
  readonly createdAt?: string;
}

export interface InsertScheduledRunReceipt {
  readonly run: ScheduledRun;
  readonly status: "accepted" | "duplicate";
}

export interface ScheduledRunPatch {
  readonly status?: ScheduledRunStatus;
  readonly coalescedThrough?: string;
  readonly admittedAt?: string;
  readonly eventId?: string;
  readonly executionId?: string;
  readonly sessionId?: string;
  readonly cycleId?: string;
  readonly admissionReceipt?: ScheduleOccurrenceAdmissionReceipt;
  readonly decisionReason?: string;
  readonly completedAt?: string;
}

export class ScheduledRunStore {
  readonly #database: DatabaseSync;
  readonly #runtime: RuntimeStore;
  readonly #requireRevision: (scheduleId: string, revision: number) => ScheduleRevision;

  public constructor(options: {
    readonly database: DatabaseSync;
    readonly runtime: RuntimeStore;
    readonly requireRevision: (scheduleId: string, revision: number) => ScheduleRevision;
  }) {
    this.#database = options.database;
    this.#runtime = options.runtime;
    this.#requireRevision = options.requireRevision;
  }

  public insertDueRun(input: InsertScheduledRunInput): InsertScheduledRunReceipt {
    return withImmediateTransaction(
      this.#database,
      () => this.insertDueRunInTransaction(input)
    );
  }

  public insertDueRunInTransaction(
    input: InsertScheduledRunInput
  ): InsertScheduledRunReceipt {
    const definition = this.#database.prepare(`
      SELECT status, current_revision, next_occurrence_key
      FROM schedules
      WHERE schedule_id = ?
    `).get(input.scheduleId) as {
      status: ScheduleStatus;
      current_revision: number;
      next_occurrence_key: string | null;
    } | undefined;
    if (definition === undefined) throw new Error(`Schedule not found: ${input.scheduleId}`);
    if (definition.status !== "active" ||
      definition.current_revision !== input.scheduleRevision ||
      definition.next_occurrence_key !== input.occurrenceKey) {
      throw new Error(`Schedule occurrence changed before admission: ${input.scheduleId}`);
    }
    return this.insertRun(input);
  }

  public insertRun(input: InsertScheduledRunInput): InsertScheduledRunReceipt {
    requireScheduleId(input.scheduleId);
    requireScheduleRevision(input.scheduleRevision, "scheduleRevision");
    const createdAt = iso(input.createdAt ?? new Date().toISOString(), "createdAt");
    const scheduledFor = iso(input.scheduledFor, "scheduledFor");
    const coalescedThrough = input.coalescedThrough === undefined
      ? undefined
      : iso(input.coalescedThrough, "coalescedThrough");
    const admittedAt = input.admittedAt === undefined
      ? undefined
      : iso(input.admittedAt, "admittedAt");
    validateRunStatus(input.status);
    text(input.occurrenceKey, "occurrenceKey", 512);
    optionalText(input.decisionReason, "decisionReason", 1_024);
    const existing = this.#runForOccurrence(input.scheduleId, input.occurrenceKey);
    if (existing !== undefined) return { run: existing, status: "duplicate" };
    const runId = newScheduledRunId();
    const revision = this.#requireRevision(input.scheduleId, input.scheduleRevision);
    const expectedAgentRunId = revision.schemaVersion === "ScheduleRevision@2"
      ? revision.sourceBinding.runId
      : undefined;
    if (input.agentRunId !== expectedAgentRunId) {
      throw new Error("Schedule occurrence Agent Run does not match its revision");
    }
    const definitionSnapshot = scheduleDefinitionSnapshot(revision);
    try {
      this.#database.prepare(`
        INSERT INTO scheduled_runs (
          run_id, schedule_id, occurrence_key, scheduled_for, schedule_revision,
          definition_snapshot_json, coalesced_through, admitted_at, status, decision_reason,
          agent_run_id, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        input.scheduleId,
        input.occurrenceKey,
        scheduledFor,
        input.scheduleRevision,
        JSON.stringify(definitionSnapshot),
        coalescedThrough ?? null,
        admittedAt ?? null,
        input.status,
        input.decisionReason ?? null,
        expectedAgentRunId ?? null,
        createdAt,
        createdAt,
        terminalRunStatus(input.status) ? createdAt : null
      );
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      const duplicate = this.#runForOccurrence(input.scheduleId, input.occurrenceKey);
      if (duplicate === undefined) throw error;
      return { run: duplicate, status: "duplicate" };
    }
    return { run: this.requireRun(runId), status: "accepted" };
  }

  public patchRun(
    runId: string,
    patch: ScheduledRunPatch,
    at = new Date().toISOString()
  ): ScheduledRun {
    const current = this.requireRun(runId);
    const timestamp = iso(at, "at");
    const status = patch.status ?? current.status;
    validateRunStatus(status);
    const coalescedThrough = patch.coalescedThrough === undefined
      ? current.coalescedThrough
      : iso(patch.coalescedThrough, "coalescedThrough");
    const admittedAt = patch.admittedAt === undefined
      ? current.admittedAt
      : iso(patch.admittedAt, "admittedAt");
    if (patch.eventId !== undefined) requireRuntimeId(patch.eventId, "evt", "eventId");
    if (patch.executionId !== undefined) {
      requireRuntimeId(patch.executionId, "exe", "executionId");
    }
    if (patch.sessionId !== undefined) requireRuntimeId(patch.sessionId, "ses", "sessionId");
    const admissionReceipt = patch.admissionReceipt === undefined
      ? current.admissionReceipt
      : parseScheduleOccurrenceAdmissionReceipt(patch.admissionReceipt);
    const cycleId = patch.cycleId ?? current.cycleId;
    if ((cycleId === undefined) !== (admissionReceipt === undefined)) {
      throw new Error("Schedule occurrence cycle and admission receipt must be written together");
    }
    if (cycleId !== undefined) {
      requireAgentRunCycleId(cycleId);
      if (current.agentRunId === undefined || admissionReceipt === undefined ||
        admissionReceipt.scheduleId !== current.scheduleId ||
        admissionReceipt.occurrenceId !== current.runId ||
        admissionReceipt.agentRunId !== current.agentRunId ||
        admissionReceipt.cycleId !== cycleId) {
        throw new Error("Schedule occurrence admission receipt does not match its owner");
      }
      requireAgentRunId(current.agentRunId);
    }
    optionalText(patch.decisionReason, "decisionReason", 1_024);
    const completedAt = patch.completedAt === undefined
      ? terminalRunStatus(status)
        ? current.completedAt ?? timestamp
        : undefined
      : iso(patch.completedAt, "completedAt");
    this.#database.prepare(`
      UPDATE scheduled_runs
      SET status = ?, coalesced_through = ?, admitted_at = ?,
        event_id = ?, execution_id = ?, session_id = ?, decision_reason = ?,
        cycle_id = ?, admission_receipt_json = ?, completed_at = ?, updated_at = ?
      WHERE run_id = ?
    `).run(
      status,
      coalescedThrough ?? null,
      admittedAt ?? null,
      patch.eventId ?? current.eventId ?? null,
      patch.executionId ?? current.executionId ?? null,
      patch.sessionId ?? current.sessionId ?? null,
      patch.decisionReason ?? current.decisionReason ?? null,
      cycleId ?? null,
      admissionReceipt === undefined ? null : JSON.stringify(admissionReceipt),
      completedAt ?? null,
      timestamp,
      runId
    );
    return this.requireRun(runId);
  }

  public run(runId: string): ScheduledRun | undefined {
    requireScheduledRunId(runId);
    const row = this.#database.prepare(`
      SELECT * FROM scheduled_runs WHERE run_id = ?
    `).get(runId) as RunRow | undefined;
    return row === undefined ? undefined : mapRun(row);
  }

  public runForOccurrence(scheduleId: string, occurrenceKey: string): ScheduledRun | undefined {
    requireScheduleId(scheduleId);
    text(occurrenceKey, "occurrenceKey", 512);
    return this.#runForOccurrence(scheduleId, occurrenceKey);
  }

  public requireRun(runId: string): ScheduledRun {
    const run = this.run(runId);
    if (run === undefined) throw new Error(`Scheduled run not found: ${runId}`);
    return run;
  }

  public runs(scheduleId: string, limit = 100): ScheduledRun[] {
    requireScheduleId(scheduleId);
    bounded(limit, 1, 1_000, "limit");
    return (this.#database.prepare(`
      SELECT * FROM scheduled_runs
      WHERE schedule_id = ?
      ORDER BY created_at DESC, run_id DESC
      LIMIT ?
    `).all(scheduleId, limit) as unknown as RunRow[]).map(mapRun);
  }

  public unterminatedRuns(scheduleId: string): ScheduledRun[] {
    requireScheduleId(scheduleId);
    return (this.#database.prepare(`
      SELECT * FROM scheduled_runs
      WHERE schedule_id = ? AND status IN ('queued', 'running', 'unknown')
      ORDER BY created_at ASC, run_id ASC
    `).all(scheduleId) as unknown as RunRow[]).map(mapRun);
  }

  public hasUnterminatedRun(scheduleId: string): boolean {
    return this.unterminatedRuns(scheduleId).length > 0;
  }

  public pendingRuns(limit = 100): ScheduledRun[] {
    bounded(limit, 1, 1_000, "limit");
    return (this.#database.prepare(`
      SELECT * FROM scheduled_runs
      WHERE status = 'queued' AND event_id IS NULL
      ORDER BY created_at ASC, run_id ASC
      LIMIT ?
    `).all(limit) as unknown as RunRow[]).map(mapRun);
  }

  public hasOtherActiveRun(run: ScheduledRun): boolean {
    const row = this.#database.prepare(`
      SELECT 1 FROM scheduled_runs
      WHERE schedule_id = ? AND run_id != ?
        AND status IN ('queued', 'running', 'unknown')
        AND event_id IS NOT NULL
      LIMIT 1
    `).get(run.scheduleId, run.runId) as { 1: number } | undefined;
    return row !== undefined;
  }

  public hasOtherActiveFixedSessionRun(run: ScheduledRun, sessionId: string): boolean {
    requireRuntimeId(sessionId, "ses", "sessionId");
    const row = this.#database.prepare(`
      SELECT 1
      FROM scheduled_runs candidate
      WHERE candidate.run_id != ?
        AND candidate.status IN ('queued', 'running', 'unknown')
        AND candidate.event_id IS NOT NULL
        AND json_extract(candidate.definition_snapshot_json, '$.sessionPolicy') = 'fixed'
        AND json_extract(candidate.definition_snapshot_json, '$.fixedSessionId') = ?
      LIMIT 1
    `).get(run.runId, sessionId) as { 1: number } | undefined;
    return row !== undefined;
  }

  public hasActiveFixedSessionRun(sessionId: string): boolean {
    requireRuntimeId(sessionId, "ses", "sessionId");
    const row = this.#database.prepare(`
      SELECT 1
      FROM scheduled_runs candidate
      WHERE candidate.status IN ('queued', 'running', 'unknown')
        AND candidate.event_id IS NOT NULL
        AND json_extract(candidate.definition_snapshot_json, '$.sessionPolicy') = 'fixed'
        AND json_extract(candidate.definition_snapshot_json, '$.fixedSessionId') = ?
      LIMIT 1
    `).get(sessionId) as { 1: number } | undefined;
    return row !== undefined;
  }

  public reconcileInterrupted(at = new Date().toISOString()): number {
    const timestamp = iso(at, "at");
    return withImmediateTransaction(this.#database, () => {
      const rows = this.#database.prepare(`
        SELECT run.run_id, execution.execution_id, execution.event_id
        FROM scheduled_runs run
        JOIN executions execution ON execution.execution_id = run.execution_id
        WHERE run.status IN ('queued', 'running')
          AND execution.status = 'running'
      `).all() as unknown as Array<{
        run_id: string;
        execution_id: string;
        event_id: string;
      }>;
      for (const row of rows) {
        this.#database.prepare(`
          UPDATE scheduled_runs
          SET status = 'unknown', decision_reason = 'provider-outcome-unknown',
            updated_at = ?
          WHERE run_id = ?
        `).run(timestamp, row.run_id);
        this.#runtime.failExecutionsForEventsInTransaction(
          [row.event_id],
          "scheduled_provider_outcome_unknown",
          timestamp
        );
      }
      return rows.length;
    });
  }

  #runForOccurrence(scheduleId: string, occurrenceKey: string): ScheduledRun | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM scheduled_runs
      WHERE schedule_id = ? AND occurrence_key = ?
    `).get(scheduleId, occurrenceKey) as RunRow | undefined;
    return row === undefined ? undefined : mapRun(row);
  }
}
