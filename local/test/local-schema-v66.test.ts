import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("schema v72 adds Run-bound Schedule definitions and occurrence receipts", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v66-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec("PRAGMA foreign_keys = OFF");
      legacy.exec("BEGIN IMMEDIATE");
      try {
        legacy.exec(`
          CREATE TABLE schedules_v66 AS
          SELECT schedule_id, owner_principal_id, status, current_revision,
            next_run_at, next_occurrence_key, next_occurrence_missing,
            agent_id, kind, expression, expression_version, timezone,
            misfire_policy, overlap_policy, misfire_grace_ms, session_policy,
            fixed_session_id, prompt, workspace, external_ref_binding_json,
            revision_created_at, archived_at, created_at, updated_at
          FROM schedules;
          CREATE TABLE scheduled_runs_v66 AS
          SELECT run_id, schedule_id, occurrence_key, scheduled_for, schedule_revision,
            definition_snapshot_json, coalesced_through, admitted_at, status,
            event_id, execution_id, session_id, decision_reason,
            created_at, updated_at, completed_at
          FROM scheduled_runs;
          CREATE TABLE subscriptions_v66 AS
          SELECT subscription_id, title, owner_agent_id, plugin_path, plugin_id,
            plugin_schema_version, plugin_config_json, policy_json, interval_ms,
            max_wait_ms, max_attempts, attempt_count, definition_schema,
            definition_revision, definition_digest, callback_phase_status,
            terminal_key, terminal_observation_json, status, started_at, deadline_at,
            next_poll_at, latest_error, external_ref_binding_json, archived_at,
            created_at, updated_at
          FROM subscriptions;
          CREATE TABLE continuous_subscriptions_v66 AS
          SELECT subscription_id, title, owner_agent_id, current_revision,
            plugin_path, plugin_id, plugin_config_json, policy_json, interval_ms,
            poll_count, status, next_poll_at, checkpoint_occurrence_key,
            checkpoint_observation_json, pending_occurrence_key,
            pending_observation_json, latest_error, external_ref_binding_json,
            archived_at, created_at, updated_at
          FROM continuous_subscriptions;
          DROP TABLE scheduled_runs;
          DROP TABLE schedules;
          DROP TABLE subscriptions;
          DROP TABLE continuous_subscriptions;
          ALTER TABLE schedules_v66 RENAME TO schedules;
          ALTER TABLE scheduled_runs_v66 RENAME TO scheduled_runs;
          ALTER TABLE subscriptions_v66 RENAME TO subscriptions;
          ALTER TABLE continuous_subscriptions_v66 RENAME TO continuous_subscriptions;
          UPDATE schema_meta SET value = '66' WHERE key = 'schema_version';
        `);
        legacy.exec("COMMIT");
      } catch (error) {
        legacy.exec("ROLLBACK");
        throw error;
      } finally {
        legacy.exec("PRAGMA foreign_keys = ON");
      }
    } finally {
      legacy.close();
    }

    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 72);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const scheduleColumns = database.prepare("PRAGMA table_info(schedules)").all() as
        unknown as Array<{ name: string }>;
      const occurrenceColumns = database.prepare("PRAGMA table_info(scheduled_runs)").all() as
        unknown as Array<{ name: string }>;
      assert.equal(scheduleColumns.some(({ name }) => name === "definition_schema"), true);
      assert.equal(scheduleColumns.some(({ name }) => name === "source_binding_json"), true);
      assert.equal(scheduleColumns.some(({ name }) => name === "target_json"), true);
      assert.equal(occurrenceColumns.some(({ name }) => name === "agent_run_id"), true);
      assert.equal(occurrenceColumns.some(({ name }) => name === "cycle_id"), true);
      assert.equal(
        occurrenceColumns.some(({ name }) => name === "admission_receipt_json"),
        true
      );
      const scheduleSql = database.prepare(`
        SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'schedules'
      `).get() as { sql: string };
      const occurrenceSql = database.prepare(`
        SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'scheduled_runs'
      `).get() as { sql: string };
      assert.match(scheduleSql.sql, /ScheduleRevision@2/u);
      assert.match(scheduleSql.sql, /ScheduleRevision@3/u);
      assert.match(scheduleSql.sql, /RunSourceBinding@1/u);
      assert.match(occurrenceSql.sql, /ScheduleOccurrenceAdmissionReceipt@1/u);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
