import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runtimeOperationsView } from "../src/application/runtime/query.js";
import { runLocalApp } from "../src/entrypoints/cli/main.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("schema v72 adds bounded Run source binding and cycle occurrence envelope", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v65-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const legacy = new DatabaseSync(databasePath);
    try {
      const current = legacy.prepare(`
        SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agent_runs'
      `).get() as { sql: string };
      const v65Sql = current.sql
        .replace("CREATE TABLE agent_runs", "CREATE TABLE agent_runs_v65_fixture")
        .replace(/,\n\s+source_binding_json TEXT CHECK\([\s\S]*?\n\s+\),\n\s+status TEXT/u,
          ",\n      status TEXT");
      assert.doesNotMatch(v65Sql, /source_binding_json/u);
      legacy.exec("PRAGMA foreign_keys = OFF");
      legacy.exec("BEGIN IMMEDIATE");
      try {
        legacy.exec(`
          ${v65Sql};
          CREATE TABLE schedules_v65_fixture AS
          SELECT schedule_id, owner_principal_id, status, current_revision,
            next_run_at, next_occurrence_key, next_occurrence_missing,
            agent_id, kind, expression, expression_version, timezone,
            misfire_policy, overlap_policy, misfire_grace_ms, session_policy,
            fixed_session_id, prompt, workspace, external_ref_binding_json,
            revision_created_at, archived_at, created_at, updated_at
          FROM schedules;
          CREATE TABLE scheduled_runs_v65_fixture AS
          SELECT run_id, schedule_id, occurrence_key, scheduled_for, schedule_revision,
            definition_snapshot_json, coalesced_through, admitted_at, status,
            event_id, execution_id, session_id, decision_reason,
            created_at, updated_at, completed_at
          FROM scheduled_runs;
          CREATE TABLE subscriptions_v65_fixture AS
          SELECT subscription_id, title, owner_agent_id, plugin_path, plugin_id,
            plugin_schema_version, plugin_config_json, policy_json, interval_ms,
            max_wait_ms, max_attempts, attempt_count, definition_schema,
            definition_revision, definition_digest, callback_phase_status,
            terminal_key, terminal_observation_json, status, started_at, deadline_at,
            next_poll_at, latest_error, external_ref_binding_json, archived_at,
            created_at, updated_at
          FROM subscriptions;
          CREATE TABLE continuous_subscriptions_v65_fixture AS
          SELECT subscription_id, title, owner_agent_id, current_revision,
            plugin_path, plugin_id, plugin_config_json, policy_json, interval_ms,
            poll_count, status, next_poll_at, checkpoint_occurrence_key,
            checkpoint_observation_json, pending_occurrence_key,
            pending_observation_json, latest_error, external_ref_binding_json,
            archived_at, created_at, updated_at
          FROM continuous_subscriptions;
          DROP INDEX agent_run_cycles_run_occurrence;
          ALTER TABLE agent_run_cycles DROP COLUMN source_envelope_json;
          DROP TABLE scheduled_runs;
          DROP TABLE schedules;
          DROP TABLE subscriptions;
          DROP TABLE continuous_subscriptions;
          DROP TABLE agent_runs;
          ALTER TABLE agent_runs_v65_fixture RENAME TO agent_runs;
          ALTER TABLE schedules_v65_fixture RENAME TO schedules;
          ALTER TABLE scheduled_runs_v65_fixture RENAME TO scheduled_runs;
          ALTER TABLE subscriptions_v65_fixture RENAME TO subscriptions;
          ALTER TABLE continuous_subscriptions_v65_fixture
            RENAME TO continuous_subscriptions;
          UPDATE schema_meta SET value = '65' WHERE key = 'schema_version';
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

    const status = runtimeOperationsView(projectRoot, directory, "localhost:4300");
    assert.equal(status.status, "stopped");
    assert.equal(status.schemaVersion, 65);
    let cliStatus = "";
    assert.equal(await runLocalApp(projectRoot, [
      "--runtime", directory, "status"
    ], {}, { write(text) { cliStatus += text; } }), 0);
    assert.match(cliStatus, /Local Runtime: stopped/u);
    const readOnlyCheck = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const schema = readOnlyCheck.prepare(`
        SELECT value FROM schema_meta WHERE key = 'schema_version'
      `).get() as { value: string };
      assert.equal(schema.value, "65");
    } finally {
      readOnlyCheck.close();
    }

    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 72);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const runColumns = database.prepare("PRAGMA table_info(agent_runs)").all() as
        unknown as Array<{ name: string }>;
      const cycleColumns = database.prepare("PRAGMA table_info(agent_run_cycles)").all() as
        unknown as Array<{ name: string }>;
      assert.equal(runColumns.some(({ name }) => name === "source_binding_json"), true);
      assert.equal(cycleColumns.some(({ name }) => name === "source_envelope_json"), true);
      const occurrenceIndex = database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'index' AND name = 'agent_run_cycles_run_occurrence'
      `).get();
      assert.notEqual(occurrenceIndex, undefined);
      const runSql = database.prepare(`
        SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agent_runs'
      `).get() as { sql: string };
      const cycleSql = database.prepare(`
        SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agent_run_cycles'
      `).get() as { sql: string };
      assert.match(runSql.sql, /length\(source_binding_json\) <= 16384/u);
      assert.match(runSql.sql, /series_key IS NOT NULL/u);
      assert.match(cycleSql.sql, /length\(source_envelope_json\) <= 65536/u);
      assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
