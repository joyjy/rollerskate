import type { DatabaseSync } from "node:sqlite";

import { createSchema } from "./definition.js";
import { tableColumns, tableExists, writeSchemaVersion } from "./introspection.js";

export function assertV66SchemaShape(database: DatabaseSync): void {
  if (!tableExists(database, "schedules") || !tableExists(database, "scheduled_runs") ||
    !tableColumns(database, "agent_runs").includes("source_binding_json")) {
    throw new Error("Local database schema 66 has an unsupported Schedule shape");
  }
}

export function migrateV66Schema(database: DatabaseSync, targetVersion: number): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      ALTER TABLE schedules RENAME TO schedules_v66;
      ALTER TABLE scheduled_runs RENAME TO scheduled_runs_v66;
      DROP INDEX IF EXISTS schedules_due;
      DROP INDEX IF EXISTS scheduled_runs_schedule;
      DROP INDEX IF EXISTS scheduled_runs_status;
    `);
    createSchema(database);
    database.exec(`
      INSERT INTO schedules (
        schedule_id, owner_principal_id, status, current_revision,
        next_run_at, next_occurrence_key, next_occurrence_missing,
        definition_schema, agent_id, kind, expression, expression_version, timezone,
        misfire_policy, overlap_policy, misfire_grace_ms, session_policy,
        fixed_session_id, prompt, workspace, source_binding_json,
        external_ref_binding_json, revision_created_at, archived_at, created_at, updated_at
      )
      SELECT
        schedule_id, owner_principal_id, status, current_revision,
        next_run_at, next_occurrence_key, next_occurrence_missing,
        'ScheduleRevision@1', agent_id, kind, expression, expression_version, timezone,
        misfire_policy, overlap_policy, misfire_grace_ms, session_policy,
        fixed_session_id, prompt, workspace, NULL,
        external_ref_binding_json, revision_created_at, archived_at, created_at, updated_at
      FROM schedules_v66;

      INSERT INTO scheduled_runs (
        run_id, schedule_id, occurrence_key, scheduled_for, schedule_revision,
        definition_snapshot_json, coalesced_through, admitted_at, status,
        event_id, execution_id, session_id, agent_run_id, cycle_id,
        admission_receipt_json, decision_reason, created_at, updated_at, completed_at
      )
      SELECT
        run_id, schedule_id, occurrence_key, scheduled_for, schedule_revision,
        definition_snapshot_json, coalesced_through, admitted_at, status,
        event_id, execution_id, session_id, NULL, NULL, NULL,
        decision_reason, created_at, updated_at, completed_at
      FROM scheduled_runs_v66;

      DROP TABLE scheduled_runs_v66;
      DROP TABLE schedules_v66;
    `);
    writeSchemaVersion(database, targetVersion);
    const violations = database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `Local database migration left ${violations.length} foreign key violations`
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
