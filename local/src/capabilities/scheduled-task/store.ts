import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { requireLocalId } from "../../core/id.js";
import { requireRuntimeId } from "../../core/runtime/model.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { migrateLocalDatabase } from "../../infrastructure/sqlite/local-schema.js";
import {
  newScheduledRunId,
  newScheduleId,
  requireScheduleId,
  requireScheduleRevision,
  requireScheduledRunId,
  type CreateScheduleInput,
  type ScheduledRun,
  type ScheduledRunStatus,
  type Schedule,
  type ScheduleDefinition,
  type ScheduleRevision,
  type ScheduleRevisionInput,
  type ScheduleStatus,
  type UpdateScheduleInput
} from "./model.js";
import {
  canonicalCronExpression,
  canonicalOnceExpression,
  nextCronOccurrence,
  requireIanaTimezone,
  type ScheduledOccurrence
} from "./time.js";

interface DefinitionRow {
  schedule_id: string;
  owner_principal_id: string;
  status: ScheduleStatus;
  current_revision: number;
  next_run_at: string | null;
  next_occurrence_key: string | null;
  next_occurrence_missing: number;
  created_at: string;
  updated_at: string;
}

interface RevisionRow {
  schedule_id: string;
  revision: number;
  agent_id: string;
  kind: ScheduleRevision["kind"];
  expression: string;
  expression_version: ScheduleRevision["expressionVersion"];
  timezone: string | null;
  misfire_policy: ScheduleRevision["misfirePolicy"];
  overlap_policy: ScheduleRevision["overlapPolicy"];
  misfire_grace_ms: number;
  session_policy: ScheduleRevision["sessionPolicy"];
  fixed_session_id: string | null;
  prompt: string;
  workspace: string;
  created_at: string;
}

interface RunRow {
  run_id: string;
  schedule_id: string;
  occurrence_key: string;
  scheduled_for: string;
  schedule_revision: number;
  definition_snapshot_json: string;
  coalesced_through: string | null;
  admitted_at: string | null;
  status: ScheduledRunStatus;
  event_id: string | null;
  execution_id: string | null;
  session_id: string | null;
  decision_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface InsertScheduledRunInput {
  readonly scheduleId: string;
  readonly occurrenceKey: string;
  readonly scheduledFor: string;
  readonly scheduleRevision: number;
  readonly status: ScheduledRunStatus;
  readonly coalescedThrough?: string;
  readonly admittedAt?: string;
  readonly decisionReason?: string;
  readonly createdAt?: string;
}

export interface InsertScheduledRunReceipt {
  readonly run: ScheduledRun;
  readonly status: "accepted" | "duplicate";
}

export interface ExpectedScheduleOccurrence {
  readonly revision: number;
  readonly occurrenceKey: string;
}

export interface ScheduledRunPatch {
  readonly status?: ScheduledRunStatus;
  readonly coalescedThrough?: string;
  readonly admittedAt?: string;
  readonly eventId?: string;
  readonly executionId?: string;
  readonly sessionId?: string;
  readonly decisionReason?: string;
  readonly completedAt?: string;
}

export class ScheduledTaskStore {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string) {
    this.#database = openRuntimeDatabase(databasePath);
    this.#migrate();
  }

  public create(
    input: CreateScheduleInput,
    createdAt = new Date().toISOString()
  ): Schedule {
    requireLocalId(input.ownerPrincipalId, "prn", "ownerPrincipalId");
    const at = iso(createdAt, "createdAt");
    const scheduleId = newScheduleId();
    const revision = normalizeRevision(scheduleId, 1, input, at);
    const next = initialOccurrence(revision, at);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`
        INSERT INTO schedules (
          schedule_id, owner_principal_id, status, current_revision,
          next_run_at, next_occurrence_key, next_occurrence_missing,
          agent_id, kind, expression, expression_version, timezone,
          misfire_policy, overlap_policy, misfire_grace_ms, session_policy,
          fixed_session_id, prompt, workspace, revision_created_at,
          created_at, updated_at
        ) VALUES (?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        scheduleId,
        input.ownerPrincipalId,
        next?.scheduledFor ?? null,
        next?.occurrenceKey ?? null,
        next?.missingLocalTime === true ? 1 : 0,
        revision.agentId,
        revision.kind,
        revision.expression,
        revision.expressionVersion,
        revision.timezone ?? null,
        revision.misfirePolicy,
        revision.overlapPolicy,
        revision.misfireGraceMilliseconds,
        revision.sessionPolicy,
        revision.fixedSessionId ?? null,
        revision.prompt,
        revision.workspace,
        revision.createdAt,
        at,
        at
      );
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.require(scheduleId);
  }

  public get(scheduleId: string): Schedule | undefined {
    requireScheduleId(scheduleId);
    const definition = this.#definition(scheduleId);
    if (definition === undefined) return undefined;
    return {
      definition,
      revision: this.requireRevision(scheduleId, definition.currentRevision)
    };
  }

  public require(scheduleId: string): Schedule {
    const schedule = this.get(scheduleId);
    if (schedule === undefined) throw new Error(`Schedule not found: ${scheduleId}`);
    return schedule;
  }

  public list(): Schedule[] {
    return (this.#database.prepare(`
      SELECT * FROM schedules
      ORDER BY created_at DESC, schedule_id ASC
    `).all() as unknown as DefinitionRow[]).map((row) => {
      const definition = mapDefinition(row);
      return {
        definition,
        revision: this.requireRevision(definition.scheduleId, definition.currentRevision)
      };
    });
  }

  public requireRevision(scheduleId: string, revision: number): ScheduleRevision {
    requireScheduleId(scheduleId);
    requireScheduleRevision(revision);
    const row = this.#database.prepare(`
      SELECT schedule_id, current_revision AS revision, agent_id, kind,
        expression, expression_version, timezone, misfire_policy,
        overlap_policy, misfire_grace_ms, session_policy, fixed_session_id,
        prompt, workspace, revision_created_at AS created_at
      FROM schedules
      WHERE schedule_id = ? AND current_revision = ?
    `).get(scheduleId, revision) as RevisionRow | undefined;
    if (row !== undefined) return mapRevision(row);
    const snapshot = this.#database.prepare(`
      SELECT definition_snapshot_json
      FROM scheduled_runs
      WHERE schedule_id = ? AND schedule_revision = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(scheduleId, revision) as {
      definition_snapshot_json: string;
    } | undefined;
    if (snapshot === undefined) {
      throw new Error(
        `Schedule revision is not current and has no run snapshot: ${scheduleId}@${revision}`
      );
    }
    return parseScheduleDefinitionSnapshot(snapshot.definition_snapshot_json);
  }

  public update(
    scheduleId: string,
    input: UpdateScheduleInput,
    updatedAt = new Date().toISOString()
  ): Schedule {
    requireScheduleId(scheduleId);
    requireScheduleRevision(input.expectedRevision, "expectedRevision");
    const at = iso(updatedAt, "updatedAt");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.require(scheduleId);
      if (current.definition.status === "completed" ||
        current.definition.status === "cancelled") {
        throw new Error(`Schedule cannot update from ${current.definition.status}: ${scheduleId}`);
      }
      if (current.definition.currentRevision !== input.expectedRevision) {
        throw new Error(
          `Schedule revision conflict: expected ${input.expectedRevision}, ` +
          `current ${current.definition.currentRevision}`
        );
      }
      const nextRevision = input.expectedRevision + 1;
      const revision = normalizeRevision(scheduleId, nextRevision, input, at);
      if (targetChanged(current.revision, revision) && this.hasUnterminatedRun(scheduleId)) {
        throw new Error("Schedule target cannot change while a run is unterminated");
      }
      const next = initialOccurrence(revision, at);
      const result = this.#database.prepare(`
        UPDATE schedules
        SET current_revision = ?, next_run_at = ?, next_occurrence_key = ?,
          next_occurrence_missing = ?, agent_id = ?, kind = ?, expression = ?,
          expression_version = ?, timezone = ?, misfire_policy = ?,
          overlap_policy = ?, misfire_grace_ms = ?, session_policy = ?,
          fixed_session_id = ?, prompt = ?, workspace = ?,
          revision_created_at = ?, updated_at = ?
        WHERE schedule_id = ? AND current_revision = ?
      `).run(
        nextRevision,
        next?.scheduledFor ?? null,
        next?.occurrenceKey ?? null,
        next?.missingLocalTime === true ? 1 : 0,
        revision.agentId,
        revision.kind,
        revision.expression,
        revision.expressionVersion,
        revision.timezone ?? null,
        revision.misfirePolicy,
        revision.overlapPolicy,
        revision.misfireGraceMilliseconds,
        revision.sessionPolicy,
        revision.fixedSessionId ?? null,
        revision.prompt,
        revision.workspace,
        revision.createdAt,
        at,
        scheduleId,
        input.expectedRevision
      );
      if (result.changes !== 1) throw new Error(`Schedule revision conflict: ${scheduleId}`);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.require(scheduleId);
  }

  public setStatus(
    scheduleId: string,
    action: "pause" | "resume" | "cancel",
    at = new Date().toISOString()
  ): Schedule {
    const schedule = this.require(scheduleId);
    const timestamp = iso(at, "at");
    const allowed: Readonly<Record<typeof action, readonly ScheduleStatus[]>> = {
      pause: ["active"],
      resume: ["paused"],
      cancel: ["active", "paused"]
    };
    const target: ScheduleStatus = action === "pause"
      ? "paused"
      : action === "resume"
        ? "active"
        : "cancelled";
    if (schedule.definition.status === target) return schedule;
    if (!allowed[action].includes(schedule.definition.status)) {
      throw new Error(`Schedule cannot ${action} from ${schedule.definition.status}: ${scheduleId}`);
    }
    const next = action === "resume"
      ? initialOccurrence(schedule.revision, timestamp)
      : undefined;
    this.#database.prepare(`
      UPDATE schedules
      SET status = ?, updated_at = ?,
        next_run_at = CASE WHEN ? = 'resume' THEN ? ELSE next_run_at END,
        next_occurrence_key = CASE WHEN ? = 'resume' THEN ? ELSE next_occurrence_key END,
        next_occurrence_missing = CASE WHEN ? = 'resume' THEN ? ELSE next_occurrence_missing END
      WHERE schedule_id = ?
    `).run(
      target,
      timestamp,
      action,
      next?.scheduledFor ?? null,
      action,
      next?.occurrenceKey ?? null,
      action,
      next?.missingLocalTime === true ? 1 : 0,
      scheduleId
    );
    return this.require(scheduleId);
  }

  public due(now = new Date().toISOString(), limit = 20): Schedule[] {
    const at = iso(now, "now");
    bounded(limit, 1, 100, "limit");
    return (this.#database.prepare(`
      SELECT * FROM schedules
      WHERE status = 'active' AND next_run_at IS NOT NULL
        AND julianday(next_run_at) <= julianday(?)
      ORDER BY next_run_at ASC, schedule_id ASC
      LIMIT ?
    `).all(at, limit) as unknown as DefinitionRow[]).map((row) => {
      const definition = mapDefinition(row);
      return {
        definition,
        revision: this.requireRevision(definition.scheduleId, definition.currentRevision)
      };
    });
  }

  public advance(scheduleId: string, after: string, at = new Date().toISOString()): Schedule {
    return this.advanceExpected(scheduleId, after, at);
  }

  public advanceExpected(
    scheduleId: string,
    after: string,
    at = new Date().toISOString(),
    expected?: ExpectedScheduleOccurrence
  ): Schedule {
    const schedule = this.require(scheduleId);
    const timestamp = iso(at, "at");
    const expectation = expected === undefined
      ? { sql: "", parameters: [] as Array<string | number> }
      : {
          sql: " AND current_revision = ? AND next_occurrence_key = ?",
          parameters: [
            requireScheduleRevision(expected.revision, "expected.revision"),
            text(expected.occurrenceKey, "expected.occurrenceKey", 512)
          ]
        };
    if (schedule.revision.kind === "once") {
      this.#database.prepare(`
        UPDATE schedules
        SET status = 'completed', next_run_at = NULL, next_occurrence_key = NULL,
          next_occurrence_missing = 0, updated_at = ?
        WHERE schedule_id = ? AND status = 'active'${expectation.sql}
      `).run(timestamp, scheduleId, ...expectation.parameters);
      return this.require(scheduleId);
    }
    const next = nextCronOccurrence(
      schedule.revision.expression,
      schedule.revision.timezone!,
      iso(after, "after")
    );
    this.#database.prepare(`
      UPDATE schedules
      SET next_run_at = ?, next_occurrence_key = ?, next_occurrence_missing = ?,
        updated_at = ?
      WHERE schedule_id = ? AND status = 'active'${expectation.sql}
    `).run(
      next.scheduledFor,
      next.occurrenceKey,
      next.missingLocalTime ? 1 : 0,
      timestamp,
      scheduleId,
      ...expectation.parameters
    );
    return this.require(scheduleId);
  }

  public insertDueRun(input: InsertScheduledRunInput): InsertScheduledRunReceipt {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
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
      const receipt = this.insertRun(input);
      this.#database.exec("COMMIT");
      return receipt;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
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
    const definitionSnapshot = scheduleDefinitionSnapshot(
      this.requireRevision(input.scheduleId, input.scheduleRevision)
    );
    try {
      this.#database.prepare(`
        INSERT INTO scheduled_runs (
          run_id, schedule_id, occurrence_key, scheduled_for, schedule_revision,
          definition_snapshot_json, coalesced_through, admitted_at, status, decision_reason,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        completed_at = ?, updated_at = ?
      WHERE run_id = ?
    `).run(
      status,
      coalescedThrough ?? null,
      admittedAt ?? null,
      patch.eventId ?? current.eventId ?? null,
      patch.executionId ?? current.executionId ?? null,
      patch.sessionId ?? current.sessionId ?? null,
      patch.decisionReason ?? current.decisionReason ?? null,
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

  public runForOccurrence(
    scheduleId: string,
    occurrenceKey: string
  ): ScheduledRun | undefined {
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
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#database.prepare(`
        SELECT run.run_id, execution.execution_id
        FROM scheduled_runs run
        JOIN executions execution ON execution.execution_id = run.execution_id
        WHERE run.status IN ('queued', 'running')
          AND execution.status = 'running'
      `).all() as unknown as Array<{ run_id: string; execution_id: string }>;
      for (const row of rows) {
        this.#database.prepare(`
          UPDATE scheduled_runs
          SET status = 'unknown', decision_reason = 'provider-outcome-unknown',
            updated_at = ?
          WHERE run_id = ?
        `).run(timestamp, row.run_id);
        this.#database.prepare(`
          UPDATE executions
          SET status = 'failed', last_error = 'scheduled_provider_outcome_unknown',
            completed_at = ?, updated_at = ?
          WHERE execution_id = ? AND status = 'running'
        `).run(timestamp, timestamp, row.execution_id);
      }
      this.#database.exec("COMMIT");
      return rows.length;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public close(): void {
    this.#database.close();
  }

  #definition(scheduleId: string): ScheduleDefinition | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM schedules WHERE schedule_id = ?
    `).get(scheduleId) as DefinitionRow | undefined;
    return row === undefined ? undefined : mapDefinition(row);
  }

  #runForOccurrence(scheduleId: string, occurrenceKey: string): ScheduledRun | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM scheduled_runs
      WHERE schedule_id = ? AND occurrence_key = ?
    `).get(scheduleId, occurrenceKey) as RunRow | undefined;
    return row === undefined ? undefined : mapRun(row);
  }

  #migrate(): void {
    migrateLocalDatabase(this.#database);
  }
}

function normalizeRevision(
  scheduleId: string,
  revision: number,
  input: ScheduleRevisionInput,
  createdAt: string
): ScheduleRevision {
  requireScheduleId(scheduleId);
  requireScheduleRevision(revision);
  requireLocalId(input.agentId, "prn", "agentId");
  const expression = input.kind === "once"
    ? canonicalOnceExpression(input.expression)
    : canonicalCronExpression(input.expression);
  const timezone = input.kind === "cron"
    ? requireIanaTimezone(input.timezone ?? "")
    : undefined;
  if (input.kind === "once" && input.timezone !== undefined) {
    throw new Error("once schedule must not define timezone");
  }
  if (!["skip", "run_once"].includes(input.misfirePolicy)) {
    throw new Error(`unsupported misfire policy: ${input.misfirePolicy}`);
  }
  if (!["skip", "queue"].includes(input.overlapPolicy)) {
    throw new Error(`unsupported overlap policy: ${input.overlapPolicy}`);
  }
  bounded(input.misfireGraceMilliseconds, 0, 604_800_000, "misfireGraceMilliseconds");
  if (!["new_each_run", "fixed"].includes(input.sessionPolicy)) {
    throw new Error(`unsupported session policy: ${input.sessionPolicy}`);
  }
  if (input.sessionPolicy === "fixed") {
    if (input.fixedSessionId === undefined) {
      throw new Error("fixed session policy requires fixedSessionId");
    }
    requireRuntimeId(input.fixedSessionId, "ses", "fixedSessionId");
  } else if (input.fixedSessionId !== undefined) {
    throw new Error("new_each_run session policy must not define fixedSessionId");
  }
  text(input.prompt, "prompt", 64_000);
  text(input.workspace, "workspace", 4_096);
  if (!isAbsolute(input.workspace)) throw new Error("workspace must be an absolute path");
  return {
    scheduleId,
    revision,
    agentId: input.agentId,
    kind: input.kind,
    expression,
    expressionVersion: input.kind === "once" ? "once-rfc3339-v1" : "cron-v1",
    ...(timezone === undefined ? {} : { timezone }),
    misfirePolicy: input.misfirePolicy,
    overlapPolicy: input.overlapPolicy,
    misfireGraceMilliseconds: input.misfireGraceMilliseconds,
    sessionPolicy: input.sessionPolicy,
    ...(input.fixedSessionId === undefined ? {} : { fixedSessionId: input.fixedSessionId }),
    prompt: input.prompt,
    workspace: input.workspace,
    createdAt
  };
}

function scheduleDefinitionSnapshot(
  revision: ScheduleRevision
): Readonly<Record<string, unknown>> {
  return {
    schema: "ScheduleDefinitionSnapshot@1",
    scheduleId: revision.scheduleId,
    revision: revision.revision,
    agentId: revision.agentId,
    kind: revision.kind,
    expression: revision.expression,
    expressionVersion: revision.expressionVersion,
    ...(revision.timezone === undefined ? {} : { timezone: revision.timezone }),
    misfirePolicy: revision.misfirePolicy,
    overlapPolicy: revision.overlapPolicy,
    misfireGraceMilliseconds: revision.misfireGraceMilliseconds,
    sessionPolicy: revision.sessionPolicy,
    ...(revision.fixedSessionId === undefined
      ? {}
      : { fixedSessionId: revision.fixedSessionId }),
    prompt: revision.prompt,
    workspace: revision.workspace,
    createdAt: revision.createdAt
  };
}

function parseScheduleDefinitionSnapshot(value: string): ScheduleRevision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("ScheduledRun definition snapshot must be valid JSON");
  }
  if (!isRecord(parsed) || parsed.schema !== "ScheduleDefinitionSnapshot@1") {
    throw new Error("ScheduledRun definition snapshot schema is unsupported");
  }
  if (typeof parsed.scheduleId !== "string" ||
    typeof parsed.revision !== "number" ||
    typeof parsed.agentId !== "string" ||
    (parsed.kind !== "once" && parsed.kind !== "cron") ||
    typeof parsed.expression !== "string" ||
    (parsed.expressionVersion !== "once-rfc3339-v1" &&
      parsed.expressionVersion !== "cron-v1") ||
    (parsed.misfirePolicy !== "skip" && parsed.misfirePolicy !== "run_once") ||
    (parsed.overlapPolicy !== "skip" && parsed.overlapPolicy !== "queue") ||
    typeof parsed.misfireGraceMilliseconds !== "number" ||
    (parsed.sessionPolicy !== "new_each_run" && parsed.sessionPolicy !== "fixed") ||
    typeof parsed.prompt !== "string" ||
    typeof parsed.workspace !== "string" ||
    typeof parsed.createdAt !== "string") {
    throw new Error("ScheduledRun definition snapshot is malformed");
  }
  return {
    scheduleId: parsed.scheduleId,
    revision: parsed.revision,
    agentId: parsed.agentId,
    kind: parsed.kind,
    expression: parsed.expression,
    expressionVersion: parsed.expressionVersion,
    ...(typeof parsed.timezone === "string" ? { timezone: parsed.timezone } : {}),
    misfirePolicy: parsed.misfirePolicy,
    overlapPolicy: parsed.overlapPolicy,
    misfireGraceMilliseconds: parsed.misfireGraceMilliseconds,
    sessionPolicy: parsed.sessionPolicy,
    ...(typeof parsed.fixedSessionId === "string"
      ? { fixedSessionId: parsed.fixedSessionId }
      : {}),
    prompt: parsed.prompt,
    workspace: parsed.workspace,
    createdAt: parsed.createdAt
  };
}

function initialOccurrence(revision: ScheduleRevision, after: string): ScheduledOccurrence {
  if (revision.kind === "once") {
    return {
      scheduledFor: revision.expression,
      occurrenceKey: revision.expression,
      missingLocalTime: false
    };
  }
  return nextCronOccurrence(revision.expression, revision.timezone!, after);
}

function targetChanged(current: ScheduleRevision, next: ScheduleRevision): boolean {
  return current.agentId !== next.agentId ||
    current.workspace !== next.workspace ||
    current.sessionPolicy !== next.sessionPolicy ||
    current.fixedSessionId !== next.fixedSessionId;
}

function mapDefinition(row: DefinitionRow): ScheduleDefinition {
  return {
    scheduleId: row.schedule_id,
    ownerPrincipalId: row.owner_principal_id,
    status: row.status,
    currentRevision: row.current_revision,
    ...(row.next_run_at === null ? {} : { nextRunAt: row.next_run_at }),
    ...(row.next_occurrence_key === null
      ? {}
      : { nextOccurrenceKey: row.next_occurrence_key }),
    nextOccurrenceMissing: row.next_occurrence_missing === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRevision(row: RevisionRow): ScheduleRevision {
  return {
    scheduleId: row.schedule_id,
    revision: row.revision,
    agentId: row.agent_id,
    kind: row.kind,
    expression: row.expression,
    expressionVersion: row.expression_version,
    ...(row.timezone === null ? {} : { timezone: row.timezone }),
    misfirePolicy: row.misfire_policy,
    overlapPolicy: row.overlap_policy,
    misfireGraceMilliseconds: row.misfire_grace_ms,
    sessionPolicy: row.session_policy,
    ...(row.fixed_session_id === null ? {} : { fixedSessionId: row.fixed_session_id }),
    prompt: row.prompt,
    workspace: row.workspace,
    createdAt: row.created_at
  };
}

function mapRun(row: RunRow): ScheduledRun {
  return {
    runId: row.run_id,
    scheduleId: row.schedule_id,
    occurrenceKey: row.occurrence_key,
    scheduledFor: row.scheduled_for,
    scheduleRevision: row.schedule_revision,
    ...(row.coalesced_through === null ? {} : { coalescedThrough: row.coalesced_through }),
    ...(row.admitted_at === null ? {} : { admittedAt: row.admitted_at }),
    status: row.status,
    ...(row.event_id === null ? {} : { eventId: row.event_id }),
    ...(row.execution_id === null ? {} : { executionId: row.execution_id }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.decision_reason === null ? {} : { decisionReason: row.decision_reason }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at })
  };
}

function validateRunStatus(value: string): asserts value is ScheduledRunStatus {
  if (!["queued", "running", "succeeded", "failed", "skipped", "unknown"].includes(value)) {
    throw new Error(`unsupported ScheduledRun status: ${value}`);
  }
}

function terminalRunStatus(status: ScheduledRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped";
}

function text(value: string, field: string, maximum: number): string {
  if (value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  if (value.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  return value;
}

function optionalText(value: string | undefined, field: string, maximum: number): void {
  if (value !== undefined) text(value, field, maximum);
}

function iso(value: string, field: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${field} must be a valid instant`);
  return new Date(milliseconds).toISOString();
}

function bounded(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}
