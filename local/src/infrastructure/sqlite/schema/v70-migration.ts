import type { DatabaseSync } from "node:sqlite";

import { createSchema } from "./definition.js";
import { tableColumns, tableExists, writeSchemaVersion } from "./introspection.js";

export function assertV70SchemaShape(database: DatabaseSync): void {
  if (!["schedules", "scheduled_runs", "subscriptions", "continuous_subscriptions"]
    .every((table) => tableExists(database, table))) {
    throw new Error("Local database schema 70 has an unsupported proactive target shape");
  }
  const targetColumns = ["schedules", "subscriptions", "continuous_subscriptions"]
    .map((table) => tableColumns(database, table).includes("target_json"));
  if (targetColumns.some(Boolean) && !targetColumns.every(Boolean)) {
    throw new Error("Local database schema 70 has a partial proactive target shape");
  }
}

export function migrateV70Schema(database: DatabaseSync, targetVersion: number): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    if (tableColumns(database, "schedules").includes("target_json")) {
      createSchema(database);
      writeSchemaVersion(database, targetVersion);
      const violations = database.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error(
          `Local database migration left ${violations.length} foreign key violations`
        );
      }
      database.exec("COMMIT");
      return;
    }
    database.exec(`
      ALTER TABLE schedules RENAME TO schedules_v70;
      ALTER TABLE scheduled_runs RENAME TO scheduled_runs_v70;
      ALTER TABLE subscriptions RENAME TO subscriptions_v70;
      ALTER TABLE continuous_subscriptions RENAME TO continuous_subscriptions_v70;
      DROP INDEX IF EXISTS schedules_due;
      DROP INDEX IF EXISTS schedules_bound_run;
      DROP INDEX IF EXISTS scheduled_runs_schedule;
      DROP INDEX IF EXISTS scheduled_runs_status;
      DROP INDEX IF EXISTS subscriptions_due;
      DROP INDEX IF EXISTS subscriptions_bound_run;
      DROP INDEX IF EXISTS continuous_subscriptions_due;
      DROP INDEX IF EXISTS continuous_subscriptions_bound_run;
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
        prompt, workspace, source_binding_json, NULL,
        external_ref_binding_json, revision_created_at, archived_at, created_at, updated_at
      FROM schedules_v70;

      INSERT INTO scheduled_runs SELECT * FROM scheduled_runs_v70;

      INSERT INTO subscriptions (
        subscription_id, title, owner_agent_id, plugin_path, plugin_id,
        plugin_schema_version, plugin_config_json, policy_json, interval_ms,
        max_wait_ms, max_attempts, attempt_count, definition_schema,
        definition_revision, definition_digest, callback_phase_status,
        terminal_key, terminal_observation_json, status, started_at, deadline_at,
        next_poll_at, latest_error, external_ref_binding_json, source_binding_json,
        target_json, agent_run_id, cycle_id, admission_receipt_json, archived_at,
        created_at, updated_at
      ) SELECT
        subscription_id, title, owner_agent_id, plugin_path, plugin_id,
        plugin_schema_version, plugin_config_json, policy_json, interval_ms,
        max_wait_ms, max_attempts, attempt_count, definition_schema,
        definition_revision, definition_digest, callback_phase_status,
        terminal_key, terminal_observation_json, status, started_at, deadline_at,
        next_poll_at, latest_error, external_ref_binding_json, source_binding_json,
        NULL, agent_run_id, cycle_id, admission_receipt_json, archived_at,
        created_at, updated_at
      FROM subscriptions_v70;

      INSERT INTO continuous_subscriptions (
        subscription_id, title, owner_agent_id, current_revision, definition_schema,
        plugin_path, plugin_id, plugin_config_json, policy_json, interval_ms,
        poll_count, status, next_poll_at, checkpoint_occurrence_key,
        checkpoint_observation_json, pending_occurrence_key, pending_observation_json,
        latest_error, external_ref_binding_json, source_binding_json, target_json,
        agent_run_id, pending_cycle_id, pending_admission_receipt_json, archived_at,
        created_at, updated_at
      ) SELECT
        subscription_id, title, owner_agent_id, current_revision, definition_schema,
        plugin_path, plugin_id, plugin_config_json, policy_json, interval_ms,
        poll_count, status, next_poll_at, checkpoint_occurrence_key,
        checkpoint_observation_json, pending_occurrence_key, pending_observation_json,
        latest_error, external_ref_binding_json, source_binding_json, NULL,
        agent_run_id, pending_cycle_id, pending_admission_receipt_json, archived_at,
        created_at, updated_at
      FROM continuous_subscriptions_v70;

      DROP TABLE scheduled_runs_v70;
      DROP TABLE schedules_v70;
      DROP TABLE subscriptions_v70;
      DROP TABLE continuous_subscriptions_v70;
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
