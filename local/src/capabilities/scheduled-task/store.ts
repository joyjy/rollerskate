import type { DatabaseSync } from "node:sqlite";

import { requireLocalId } from "../../core/id.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { openInitializedRuntimeDatabase } from
  "../../infrastructure/sqlite/database.js";
import { migrateLocalDatabase } from "../../infrastructure/sqlite/schema/index.js";
import { withImmediateTransaction } from "../../infrastructure/sqlite/transaction.js";
import { CallbackStore } from "../../infrastructure/callback/store.js";
import { encodeExternalRefTriggerBinding } from
  "../../modules/external-resource/trigger-binding.js";
import type { ProactiveCallbackOccurrence } from "../../modules/callback/proactive-model.js";
import { parseDeterministicApplicationActionReceipt } from
  "../../modules/proactive/target.js";
import {
  parseProactiveTarget,
  type ExternalWorkflowProactiveTarget
} from "../../modules/proactive/target.js";
import {
  newScheduleId,
  requireScheduleId,
  requireScheduleRevision,
  type CreateScheduleInput,
  type CreateBoundScheduleInput,
  type CreateTargetedScheduleInput,
  type ScheduledRun,
  type Schedule,
  type ScheduleDefinition,
  type ScheduleRevision,
  type ScheduleStatus,
  type UpdateScheduleInput
} from "./model.js";
import { nextCronOccurrence } from "./time.js";
import {
  bounded,
  initialOccurrence,
  iso,
  mapDefinition,
  mapRevision,
  normalizeRevision,
  normalizeBoundRevision,
  normalizeTargetedRevision,
  encodeScheduleSourceBinding,
  encodeProactiveTarget,
  scheduleDefinitionSnapshot,
  parseScheduleDefinitionSnapshot,
  targetChanged,
  text,
  type DefinitionRow,
  type RevisionRow
} from "./store/codec.js";
import {
  ScheduledRunStore,
  type InsertScheduledRunInput,
  type InsertScheduledRunReceipt,
  type ScheduledRunPatch
} from "./store/run.js";

export type {
  InsertScheduledRunInput,
  InsertScheduledRunReceipt,
  ScheduledRunPatch
} from "./store/run.js";

export interface ExpectedScheduleOccurrence {
  readonly revision: number;
  readonly occurrenceKey: string;
}

export class ScheduledTaskStore {
  readonly #database: DatabaseSync;
  readonly #ownsDatabase: boolean;
  readonly #callbacks: CallbackStore;
  readonly #runtime: RuntimeStore;
  readonly #runs: ScheduledRunStore;

  public constructor(
    database: string | DatabaseSync,
    options: { readonly migrate?: boolean } = {}
  ) {
    this.#database = typeof database === "string"
      ? openInitializedRuntimeDatabase(database, migrateLocalDatabase)
      : database;
    this.#ownsDatabase = typeof database === "string";
    const nestedOptions = options.migrate === undefined ? {} : { migrate: options.migrate };
    this.#callbacks = new CallbackStore(this.#database, nestedOptions);
    this.#runtime = new RuntimeStore(this.#database, nestedOptions);
    this.#runs = new ScheduledRunStore({
      database: this.#database,
      runtime: this.#runtime,
      requireRevision: (scheduleId, revision) => this.requireRevision(scheduleId, revision)
    });
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
    withImmediateTransaction(this.#database, () => {
      this.#database.prepare(`
        INSERT INTO schedules (
          schedule_id, owner_principal_id, status, current_revision,
          next_run_at, next_occurrence_key, next_occurrence_missing,
          agent_id, kind, expression, expression_version, timezone,
          misfire_policy, overlap_policy, misfire_grace_ms, session_policy,
          fixed_session_id, prompt, workspace, revision_created_at,
          external_ref_binding_json,
          created_at, updated_at
        ) VALUES (?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        encodeExternalRefTriggerBinding(revision.externalRefBinding),
        at,
        at
      );
      this.#callbacks.registerDefinitionsInTransaction(
        { kind: "schedule", id: scheduleId, revision: 1 },
        revision.callbacks,
        at
      );
    });
    return this.require(scheduleId);
  }

  public createBoundInTransaction(
    input: CreateBoundScheduleInput,
    createdAt = new Date().toISOString()
  ): Schedule {
    requireLocalId(input.ownerPrincipalId, "prn", "ownerPrincipalId");
    const at = iso(createdAt, "createdAt");
    const existing = this.boundForRun(input.sourceBinding.runId);
    if (existing !== undefined) {
      const expected = normalizeBoundRevision({
        ...input,
        scheduleId: existing.definition.scheduleId,
        sourceBinding: existing.revision.schemaVersion === "ScheduleRevision@2"
          ? existing.revision.sourceBinding
          : input.sourceBinding
      }, existing.revision.createdAt);
      if (existing.revision.schemaVersion !== "ScheduleRevision@2" ||
        JSON.stringify(scheduleDefinitionSnapshot(existing.revision)) !==
          JSON.stringify(scheduleDefinitionSnapshot(expected))) {
        throw new Error("Agent Run is already bound to another Schedule definition");
      }
      return existing;
    }
    const revision = normalizeBoundRevision(input, at);
    const next = initialOccurrence(revision, at);
    this.#database.prepare(`
      INSERT INTO schedules (
        schedule_id, owner_principal_id, status, current_revision,
        next_run_at, next_occurrence_key, next_occurrence_missing,
        definition_schema, agent_id, kind, expression, expression_version, timezone,
        misfire_policy, overlap_policy, misfire_grace_ms, session_policy,
        fixed_session_id, prompt, workspace, source_binding_json,
        external_ref_binding_json, revision_created_at, created_at, updated_at
      ) VALUES (?, ?, 'active', 1, ?, ?, ?, 'ScheduleRevision@2', NULL, ?, ?, ?, ?,
        ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)
    `).run(
      revision.scheduleId,
      input.ownerPrincipalId,
      next?.scheduledFor ?? null,
      next?.occurrenceKey ?? null,
      next?.missingLocalTime === true ? 1 : 0,
      revision.kind,
      revision.expression,
      revision.expressionVersion,
      revision.timezone ?? null,
      revision.misfirePolicy,
      revision.overlapPolicy,
      revision.misfireGraceMilliseconds,
      encodeScheduleSourceBinding(revision.sourceBinding),
      encodeExternalRefTriggerBinding(revision.externalRefBinding),
      revision.createdAt,
      at,
      at
    );
    return this.require(revision.scheduleId);
  }

  public createTargetedInTransaction(
    input: CreateTargetedScheduleInput,
    createdAt = new Date().toISOString()
  ): Schedule {
    requireLocalId(input.ownerPrincipalId, "prn", "ownerPrincipalId");
    const at = iso(createdAt, "createdAt");
    const revision = normalizeTargetedRevision(input, at);
    const existingById = this.get(revision.scheduleId);
    if (existingById !== undefined) {
      if (existingById.revision.schemaVersion === "ScheduleRevision@3" &&
        scheduleDefinitionIdentity(existingById.revision) ===
          scheduleDefinitionIdentity(revision)) {
        return existingById;
      }
      throw new Error("Schedule ID is already bound to another definition");
    }
    const runId = revision.target.kind === "steward_run"
      ? revision.target.sourceBinding.runId
      : undefined;
    if (runId !== undefined) {
      const existing = this.boundForRun(runId);
      if (existing !== undefined) {
        throw new Error("Agent Run is already bound to another Schedule definition");
      }
    }
    const next = initialOccurrence(revision, at);
    this.#database.prepare(`
      INSERT INTO schedules (
        schedule_id, owner_principal_id, status, current_revision,
        next_run_at, next_occurrence_key, next_occurrence_missing,
        definition_schema, agent_id, kind, expression, expression_version, timezone,
        misfire_policy, overlap_policy, misfire_grace_ms, session_policy,
        fixed_session_id, prompt, workspace, source_binding_json, target_json,
        external_ref_binding_json, revision_created_at, created_at, updated_at
      ) VALUES (?, ?, 'active', 1, ?, ?, ?, 'ScheduleRevision@3', NULL, ?, ?, ?, ?,
        ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)
    `).run(
      revision.scheduleId,
      input.ownerPrincipalId,
      next?.scheduledFor ?? null,
      next?.occurrenceKey ?? null,
      next?.missingLocalTime === true ? 1 : 0,
      revision.kind,
      revision.expression,
      revision.expressionVersion,
      revision.timezone ?? null,
      revision.misfirePolicy,
      revision.overlapPolicy,
      revision.misfireGraceMilliseconds,
      encodeProactiveTarget(revision.target),
      encodeExternalRefTriggerBinding(revision.externalRefBinding),
      revision.createdAt,
      at,
      at
    );
    return this.require(revision.scheduleId);
  }

  public migrateLegacyToExternalWorkflowInTransaction(input: {
    readonly scheduleId: string;
    readonly expectedRevision: number;
    readonly target: ExternalWorkflowProactiveTarget;
    readonly at: string;
  }): Schedule {
    if (!this.#database.isTransaction) {
      throw new Error("Schedule external workflow migration requires an owning transaction");
    }
    const current = this.require(input.scheduleId);
    if (current.definition.status !== "paused") {
      throw new Error("Legacy Schedule must be paused before external workflow migration");
    }
    if (current.definition.currentRevision !== input.expectedRevision ||
      current.revision.schemaVersion !== "ScheduleRevision@1") {
      throw new Error(`Schedule revision conflict: ${input.scheduleId}`);
    }
    if (this.unterminatedRuns(input.scheduleId).length > 0) {
      throw new Error("Legacy Schedule has unterminated occurrences");
    }
    const target = parseProactiveTarget(input.target, {
      kind: "schedule",
      id: input.scheduleId,
      definitionRevision: `ScheduleRevision@3:${input.expectedRevision + 1}`
    });
    if (target.kind !== "external_workflow") {
      throw new Error("Schedule migration requires an external workflow target");
    }
    const at = iso(input.at, "at");
    const changed = this.#database.prepare(`
      UPDATE schedules
      SET current_revision = current_revision + 1,
        definition_schema = 'ScheduleRevision@3', agent_id = NULL,
        session_policy = NULL, fixed_session_id = NULL, prompt = NULL,
        workspace = NULL, source_binding_json = NULL, target_json = ?,
        revision_created_at = ?, updated_at = ?
      WHERE schedule_id = ? AND status = 'paused' AND current_revision = ?
        AND definition_schema = 'ScheduleRevision@1'
    `).run(
      encodeProactiveTarget(target),
      at,
      at,
      input.scheduleId,
      input.expectedRevision
    );
    if (changed.changes !== 1) {
      throw new Error(`Schedule revision conflict: ${input.scheduleId}`);
    }
    return this.require(input.scheduleId);
  }

  public boundForRun(runId: string): Schedule | undefined {
    const row = this.#database.prepare(`
      SELECT schedule_id
      FROM schedules
      WHERE json_extract(source_binding_json, '$.runId') = ?
        OR json_extract(target_json, '$.sourceBinding.runId') = ?
    `).get(runId, runId) as { schedule_id: string } | undefined;
    return row === undefined ? undefined : this.require(row.schedule_id);
  }

  public withImmediateTransaction<T>(operation: () => T): T {
    return withImmediateTransaction(this.#database, operation);
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

  public setArchived(
    scheduleId: string,
    archived: boolean,
    at = new Date().toISOString()
  ): { readonly schedule: Schedule; readonly changed: boolean } {
    const current = this.require(scheduleId);
    if (current.definition.status !== "completed" &&
      current.definition.status !== "cancelled") {
      throw new Error(`Only terminal Schedules can be archived: ${scheduleId}`);
    }
    if (archived === (current.definition.archivedAt !== undefined)) {
      return { schedule: current, changed: false };
    }
    const changed = this.#database.prepare(`
      UPDATE schedules
      SET archived_at = ?
      WHERE schedule_id = ?
        AND ${archived ? "archived_at IS NULL" : "archived_at IS NOT NULL"}
    `).run(archived ? iso(at, "at") : null, scheduleId).changes;
    if (changed !== 1) throw new Error(`Schedule archive update failed: ${scheduleId}`);
    return { schedule: this.require(scheduleId), changed: true };
  }

  public requireRevision(scheduleId: string, revision: number): ScheduleRevision {
    requireScheduleId(scheduleId);
    requireScheduleRevision(revision);
    const row = this.#database.prepare(`
      SELECT schedule_id, current_revision AS revision, agent_id, kind,
        definition_schema,
        expression, expression_version, timezone, misfire_policy,
        overlap_policy, misfire_grace_ms, session_policy, fixed_session_id,
        prompt, workspace, source_binding_json, target_json,
        revision_created_at AS created_at
        , external_ref_binding_json
      FROM schedules
      WHERE schedule_id = ? AND current_revision = ?
    `).get(scheduleId, revision) as RevisionRow | undefined;
    if (row !== undefined) {
      const mapped = mapRevision(row);
      return mapped.schemaVersion === "ScheduleRevision@1"
        ? {
            ...mapped,
            callbacks: this.#callbacks.definitions({
              kind: "schedule",
              id: scheduleId,
              revision
            })
          }
        : mapped;
    }
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
    withImmediateTransaction(this.#database, () => {
      const current = this.require(scheduleId);
      if (current.revision.schemaVersion !== "ScheduleRevision@1") {
        throw new Error("ScheduleRevision@2 is managed through its bound Steward Run");
      }
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
          external_ref_binding_json = ?, revision_created_at = ?, updated_at = ?
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
        encodeExternalRefTriggerBinding(revision.externalRefBinding),
        revision.createdAt,
        at,
        scheduleId,
        input.expectedRevision
      );
      if (result.changes !== 1) throw new Error(`Schedule revision conflict: ${scheduleId}`);
      this.#callbacks.registerDefinitionsInTransaction(
        { kind: "schedule", id: scheduleId, revision: nextRevision },
        revision.callbacks,
        at
      );
    });
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
    return this.#runs.insertDueRun(input);
  }

  public insertDueRunInTransaction(
    input: InsertScheduledRunInput
  ): InsertScheduledRunReceipt {
    return this.#runs.insertDueRunInTransaction(input);
  }

  public insertRun(input: InsertScheduledRunInput): InsertScheduledRunReceipt {
    return this.#runs.insertRun(input);
  }

  public admitCallbackRun(
    runId: string,
    at = new Date().toISOString()
  ): ScheduledRun {
    const timestamp = iso(at, "at");
    return withImmediateTransaction(this.#database, () => {
      const run = this.#runs.requireRun(runId);
      if (run.status !== "queued" || run.eventId !== undefined) {
        throw new Error(`Scheduled run cannot admit callbacks: ${runId}`);
      }
      this.#callbacks.materializeInTransaction({
        kind: "schedule",
        id: run.scheduleId,
        revision: run.scheduleRevision
      }, run.runId, timestamp);
      const changed = this.#database.prepare(`
        UPDATE scheduled_runs SET status = 'running', admitted_at = ?, updated_at = ?
        WHERE run_id = ? AND status = 'queued' AND event_id IS NULL
      `).run(timestamp, timestamp, runId).changes;
      if (changed !== 1) throw new Error(`Scheduled run cannot admit callbacks: ${runId}`);
      const admitted = this.#runs.requireRun(runId);
      return admitted;
    });
  }

  public callbackOccurrences(run: ScheduledRun): ProactiveCallbackOccurrence[] {
    return this.#callbacks.list({
      ownerKind: "schedule",
      ownerId: run.scheduleId,
      triggerOccurrenceKey: run.runId
    });
  }

  public actionReceipt(run: ScheduledRun) {
    const row = this.#database.prepare(`
      SELECT receipt_json FROM deterministic_action_receipts
      WHERE source_kind = 'schedule' AND source_id = ? AND occurrence_key = ?
    `).get(run.scheduleId, run.occurrenceKey) as { receipt_json: string } | undefined;
    return row === undefined
      ? undefined
      : parseDeterministicApplicationActionReceipt(
          JSON.parse(row.receipt_json) as unknown
        );
  }

  public reconcileCallbacks(at = new Date().toISOString()): number {
    return this.#callbacks.reconcileCompleted(at, { ownerKinds: ["schedule"] });
  }

  public admitSingleAgentCallback(
    run: ScheduledRun,
    at = new Date().toISOString()
  ): ProactiveCallbackOccurrence | undefined {
    const occurrences = this.callbackOccurrences(run);
    if (occurrences.length !== 1 || occurrences[0]!.kind !== "agent.invoke" ||
      occurrences[0]!.status !== "pending") return undefined;
    const callback = this.#callbacks.beginNext({
      ownerKind: "schedule",
      ownerId: run.scheduleId,
      triggerOccurrenceKey: run.runId
    }, at);
    if (callback === undefined) return undefined;
    const definition = callback.definition;
    return this.#callbacks.admitAgentEvent(callback.occurrenceId, {
      type: "agent.request",
      source: { kind: "schedule", externalId: `scheduled-run:${run.runId}` },
      agentId: String(definition.agentId),
      prompt: String(definition.prompt),
      ...(definition.sessionId === undefined ? {} : { sessionId: String(definition.sessionId) }),
      createdAt: at
    }, at);
  }

  public patchRun(
    runId: string,
    patch: ScheduledRunPatch,
    at = new Date().toISOString()
  ): ScheduledRun {
    return this.#runs.patchRun(runId, patch, at);
  }

  public resolveUnknownRun(
    runId: string,
    outcome: "succeeded" | "failed",
    at = new Date().toISOString()
  ): ScheduledRun {
    const timestamp = iso(at, "at");
    return withImmediateTransaction(this.#database, () => {
      const run = this.#runs.requireRun(runId);
      if (run.status !== "unknown") throw new Error(`Scheduled run is not unknown: ${runId}`);
      if (run.agentRunId !== undefined) {
        throw new Error("Run-bound Schedule occurrence must be resolved in the Run Workspace");
      }
      this.#callbacks.resolveUnknownGroupInTransaction({
        ownerKind: "schedule",
        ownerId: run.scheduleId,
        triggerOccurrenceKey: run.runId
      }, outcome, timestamp);
      const resolved = this.#runs.patchRun(runId, {
        status: outcome,
        decisionReason: `manual-resolved-${outcome}`,
        completedAt: timestamp
      }, timestamp);
      return resolved;
    });
  }

  public run(runId: string): ScheduledRun | undefined {
    return this.#runs.run(runId);
  }

  public runForOccurrence(
    scheduleId: string,
    occurrenceKey: string
  ): ScheduledRun | undefined {
    return this.#runs.runForOccurrence(scheduleId, occurrenceKey);
  }

  public requireRun(runId: string): ScheduledRun {
    return this.#runs.requireRun(runId);
  }

  public runs(scheduleId: string, limit = 100): ScheduledRun[] {
    return this.#runs.runs(scheduleId, limit);
  }

  public unterminatedRuns(scheduleId: string): ScheduledRun[] {
    return this.#runs.unterminatedRuns(scheduleId);
  }

  public hasUnterminatedRun(scheduleId: string): boolean {
    return this.#runs.hasUnterminatedRun(scheduleId);
  }

  public pendingRuns(limit = 100): ScheduledRun[] {
    return this.#runs.pendingRuns(limit);
  }

  public hasOtherActiveRun(run: ScheduledRun): boolean {
    return this.#runs.hasOtherActiveRun(run);
  }

  public hasOtherActiveFixedSessionRun(run: ScheduledRun, sessionId: string): boolean {
    return this.#runs.hasOtherActiveFixedSessionRun(run, sessionId);
  }

  public hasActiveFixedSessionRun(sessionId: string): boolean {
    return this.#runs.hasActiveFixedSessionRun(sessionId);
  }

  public reconcileInterrupted(at = new Date().toISOString()): number {
    return this.#runs.reconcileInterrupted(at);
  }

  public close(): void {
    this.#callbacks.close();
    if (this.#ownsDatabase) this.#database.close();
  }

  #definition(scheduleId: string): ScheduleDefinition | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM schedules WHERE schedule_id = ?
    `).get(scheduleId) as DefinitionRow | undefined;
    return row === undefined ? undefined : mapDefinition(row);
  }

}

function scheduleDefinitionIdentity(revision: ScheduleRevision): string {
  const { createdAt: _createdAt, ...definition } = scheduleDefinitionSnapshot(revision);
  return JSON.stringify(definition);
}
