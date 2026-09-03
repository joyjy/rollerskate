import type { DatabaseSync } from "node:sqlite";

import { createSchema } from "./definition.js";
import { tableColumns, tableExists, writeSchemaVersion } from "./introspection.js";

export function assertV71SchemaShape(database: DatabaseSync): void {
  if (![
    "schedules",
    "scheduled_runs",
    "deterministic_action_receipts"
  ].every((table) => tableExists(database, table)) ||
    !["definition_schema", "source_binding_json", "target_json"].every(
      (column) => tableColumns(database, "schedules").includes(column)
    ) ||
    !["definition_snapshot_json", "agent_run_id", "admission_receipt_json"].every(
      (column) => tableColumns(database, "scheduled_runs").includes(column)
    ) ||
    tableExists(database, "external_workflow_executions") !==
      tableExists(database, "proactive_source_migration_receipts")) {
    throw new Error("Local database schema 71 has an unsupported external workflow shape");
  }
}

export function migrateV71Schema(database: DatabaseSync, targetVersion: number): void {
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      ALTER TABLE schedules RENAME TO schedules_v71;
      ALTER TABLE scheduled_runs RENAME TO scheduled_runs_v71;
      DROP INDEX IF EXISTS schedules_due;
      DROP INDEX IF EXISTS schedules_archive_updated;
      DROP INDEX IF EXISTS schedules_bound_run;
      DROP INDEX IF EXISTS schedules_target_run;
      DROP INDEX IF EXISTS scheduled_runs_schedule;
      DROP INDEX IF EXISTS scheduled_runs_status;
    `);
    createSchema(database);
    database.exec(`
      INSERT INTO schedules (
        schedule_id, owner_principal_id, status, current_revision, next_run_at,
        next_occurrence_key, next_occurrence_missing, definition_schema, agent_id,
        kind, expression, expression_version, timezone, misfire_policy,
        overlap_policy, misfire_grace_ms, session_policy, fixed_session_id,
        prompt, workspace, source_binding_json, target_json,
        external_ref_binding_json, revision_created_at, archived_at, created_at, updated_at
      ) SELECT
        schedule_id, owner_principal_id, status, current_revision, next_run_at,
        next_occurrence_key, next_occurrence_missing, definition_schema, agent_id,
        kind, expression, expression_version, timezone, misfire_policy,
        overlap_policy, misfire_grace_ms, session_policy, fixed_session_id,
        prompt, workspace, source_binding_json, target_json,
        external_ref_binding_json, revision_created_at, archived_at, created_at, updated_at
      FROM schedules_v71;

      INSERT INTO scheduled_runs SELECT * FROM scheduled_runs_v71;

      DROP TABLE scheduled_runs_v71;
      DROP TABLE schedules_v71;
    `);
    writeSchemaVersion(database, targetVersion);
    const violations = database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(
        `Local database migration left ${violations.length} foreign key violations`
      );
    }
    database.exec("COMMIT");
    database.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    database.exec("ROLLBACK");
    database.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}
