import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("schema v72 adds Run-bound one-shot and continuous Subscription receipts", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v67-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec("PRAGMA foreign_keys = OFF");
      legacy.exec("BEGIN IMMEDIATE");
      try {
        legacy.exec(`
          CREATE TABLE subscriptions_v67 AS
          SELECT subscription_id, title, owner_agent_id, plugin_path, plugin_id,
            plugin_schema_version, plugin_config_json, policy_json, interval_ms,
            max_wait_ms, max_attempts, attempt_count, definition_schema,
            definition_revision, definition_digest, callback_phase_status,
            terminal_key, terminal_observation_json, status, started_at, deadline_at,
            next_poll_at, latest_error, external_ref_binding_json, archived_at,
            created_at, updated_at
          FROM subscriptions;
          CREATE TABLE continuous_subscriptions_v67 AS
          SELECT subscription_id, title, owner_agent_id, current_revision,
            plugin_path, plugin_id, plugin_config_json, policy_json, interval_ms,
            poll_count, status, next_poll_at, checkpoint_occurrence_key,
            checkpoint_observation_json, pending_occurrence_key,
            pending_observation_json, latest_error, external_ref_binding_json,
            archived_at, created_at, updated_at
          FROM continuous_subscriptions;
          DROP TABLE subscriptions;
          DROP TABLE continuous_subscriptions;
          ALTER TABLE subscriptions_v67 RENAME TO subscriptions;
          ALTER TABLE continuous_subscriptions_v67 RENAME TO continuous_subscriptions;
          UPDATE schema_meta SET value = '67' WHERE key = 'schema_version';
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
      const oneShot = database.prepare(`
        SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'subscriptions'
      `).get() as { sql: string };
      const continuous = database.prepare(`
        SELECT sql FROM sqlite_schema
        WHERE type = 'table' AND name = 'continuous_subscriptions'
      `).get() as { sql: string };
      assert.match(oneShot.sql, /SubscriptionDefinition@4/u);
      assert.match(oneShot.sql, /SubscriptionDefinition@5/u);
      assert.match(oneShot.sql, /SubscriptionOccurrenceAdmissionReceipt@1/u);
      assert.match(continuous.sql, /ContinuousSubscriptionDefinition@2/u);
      assert.match(continuous.sql, /ContinuousSubscriptionDefinition@3/u);
      assert.match(continuous.sql, /pending_admission_receipt_json/u);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
