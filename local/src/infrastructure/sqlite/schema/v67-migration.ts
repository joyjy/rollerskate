import type { DatabaseSync } from "node:sqlite";

import { createSchema } from "./definition.js";
import { tableColumns, tableExists, writeSchemaVersion } from "./introspection.js";

export function assertV67SchemaShape(database: DatabaseSync): void {
  if (!tableExists(database, "subscriptions") ||
    !tableExists(database, "continuous_subscriptions") ||
    !tableColumns(database, "schedules").includes("definition_schema")) {
    throw new Error("Local database schema 67 has an unsupported Subscription shape");
  }
}

export function migrateV67Schema(database: DatabaseSync, targetVersion: number): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      ALTER TABLE subscriptions RENAME TO subscriptions_v67;
      ALTER TABLE continuous_subscriptions RENAME TO continuous_subscriptions_v67;
      DROP INDEX IF EXISTS subscriptions_due;
      DROP INDEX IF EXISTS subscriptions_archive_updated;
      DROP INDEX IF EXISTS continuous_subscriptions_due;
      DROP INDEX IF EXISTS continuous_subscriptions_archive_updated;
    `);
    createSchema(database);
    database.exec(`
      INSERT INTO subscriptions (
        subscription_id, title, owner_agent_id, plugin_path, plugin_id,
        plugin_schema_version, plugin_config_json, policy_json, interval_ms,
        max_wait_ms, max_attempts, attempt_count, definition_schema,
        definition_revision, definition_digest, callback_phase_status,
        terminal_key, terminal_observation_json, status, started_at, deadline_at,
        next_poll_at, latest_error, external_ref_binding_json, source_binding_json,
        agent_run_id, cycle_id, admission_receipt_json, archived_at, created_at, updated_at
      )
      SELECT
        subscription_id, title, owner_agent_id, plugin_path, plugin_id,
        plugin_schema_version, plugin_config_json, policy_json, interval_ms,
        max_wait_ms, max_attempts, attempt_count, 'SubscriptionDefinition@3',
        definition_revision, definition_digest, callback_phase_status,
        terminal_key, terminal_observation_json, status, started_at, deadline_at,
        next_poll_at, latest_error, external_ref_binding_json, NULL,
        NULL, NULL, NULL, archived_at, created_at, updated_at
      FROM subscriptions_v67;

      INSERT INTO continuous_subscriptions (
        subscription_id, title, owner_agent_id, current_revision, definition_schema,
        plugin_path, plugin_id, plugin_config_json, policy_json, interval_ms,
        poll_count, status, next_poll_at, checkpoint_occurrence_key,
        checkpoint_observation_json, pending_occurrence_key, pending_observation_json,
        latest_error, external_ref_binding_json, source_binding_json, agent_run_id,
        pending_cycle_id, pending_admission_receipt_json, archived_at, created_at, updated_at
      )
      SELECT
        subscription_id, title, owner_agent_id, current_revision,
        'ContinuousSubscriptionDefinition@1', plugin_path, plugin_id,
        plugin_config_json, policy_json, interval_ms, poll_count, status,
        next_poll_at, checkpoint_occurrence_key, checkpoint_observation_json,
        pending_occurrence_key, pending_observation_json, latest_error,
        external_ref_binding_json, NULL, NULL, NULL, NULL, archived_at,
        created_at, updated_at
      FROM continuous_subscriptions_v67;

      DROP TABLE subscriptions_v67;
      DROP TABLE continuous_subscriptions_v67;
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
