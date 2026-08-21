import type { DatabaseSync } from "node:sqlite";

import { createSchema } from "./definition.js";
import { tableColumns, tableExists, writeSchemaVersion } from "./introspection.js";

export function assertV62SchemaShape(database: DatabaseSync): void {
  if (!tableExists(database, "agent_runs") || !tableExists(database, "agent_sessions")) {
    throw new Error("Local database schema 62 has an unsupported Agent Run shape");
  }
  const runHasCycle = tableColumns(database, "agent_runs").includes("series_key");
  const sessionHasCycle = tableColumns(database, "agent_sessions").includes("cycle_id");
  if (runHasCycle && !sessionHasCycle) {
    throw new Error("Local database schema 62 has an unsupported Agent Run shape");
  }
}

export function migrateV62Schema(database: DatabaseSync, targetVersion: number): void {
  if (tableColumns(database, "agent_runs").includes("series_key")) {
    database.exec("BEGIN IMMEDIATE");
    try {
      createSchema(database);
      writeSchemaVersion(database, targetVersion);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return;
  }
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      DROP INDEX IF EXISTS agent_runs_status_updated;
      DROP INDEX IF EXISTS agent_runs_active_write_workspace;
      CREATE TABLE agent_runs_v63 (
        run_id TEXT PRIMARY KEY,
        root_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
        owner_request_id TEXT NOT NULL UNIQUE,
        owner_principal_id TEXT NOT NULL,
        steward_agent_id TEXT NOT NULL REFERENCES agents(principal_id),
        series_key TEXT UNIQUE,
        active_cycle_id TEXT,
        mandate_snapshot_json TEXT NOT NULL CHECK(
          json_valid(mandate_snapshot_json) AND length(mandate_snapshot_json) <= 65536
        ),
        workspace_grant_json TEXT CHECK(
          workspace_grant_json IS NULL OR (
            json_valid(workspace_grant_json) AND length(workspace_grant_json) <= 16384
          )
        ),
        orchestration_mode TEXT NOT NULL DEFAULT 'autonomous'
          CHECK(orchestration_mode IN ('autonomous', 'caller')),
        orchestrator_binding_json TEXT CHECK(
          orchestrator_binding_json IS NULL OR (
            json_valid(orchestrator_binding_json) AND length(orchestrator_binding_json) <= 16384
          )
        ),
        status TEXT NOT NULL CHECK(status IN (
          'active', 'waiting', 'awaiting_orchestrator', 'awaiting_source',
          'succeeded', 'failed', 'needs_human', 'cancelled'
        )),
        active_step_id TEXT,
        active_execution_id TEXT REFERENCES executions(execution_id),
        step_count INTEGER NOT NULL CHECK(step_count >= 0),
        max_steps INTEGER NOT NULL CHECK(max_steps BETWEEN 1 AND 1000),
        max_depth INTEGER NOT NULL CHECK(max_depth BETWEEN 0 AND 100),
        deadline_at TEXT,
        checkpoint_json TEXT CHECK(
          checkpoint_json IS NULL OR (
            json_valid(checkpoint_json) AND length(checkpoint_json) <= 65536
          )
        ),
        terminal_summary TEXT,
        cancelled_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(
          (orchestration_mode = 'autonomous' AND orchestrator_binding_json IS NULL)
          OR
          (orchestration_mode = 'caller' AND orchestrator_binding_json IS NOT NULL)
        ),
        CHECK(
          (series_key IS NULL AND active_cycle_id IS NULL)
          OR series_key IS NOT NULL
        ),
        CHECK(
          (
            status IN ('active', 'waiting')
            AND active_step_id IS NOT NULL
            AND active_execution_id IS NOT NULL
            AND checkpoint_json IS NULL
            AND terminal_summary IS NULL
            AND cancelled_at IS NULL
          )
          OR
          (
            status = 'awaiting_orchestrator'
            AND orchestration_mode = 'caller'
            AND active_step_id IS NOT NULL
            AND active_execution_id IS NULL
            AND (checkpoint_json IS NOT NULL OR step_count = 0)
            AND terminal_summary IS NULL
            AND cancelled_at IS NULL
          )
          OR
          (
            status = 'awaiting_source'
            AND series_key IS NOT NULL
            AND active_cycle_id IS NULL
            AND active_step_id IS NULL
            AND active_execution_id IS NULL
            AND checkpoint_json IS NULL
            AND terminal_summary IS NULL
            AND cancelled_at IS NULL
          )
          OR
          (
            status IN ('succeeded', 'failed', 'needs_human')
            AND active_step_id IS NULL
            AND active_execution_id IS NULL
            AND checkpoint_json IS NULL
            AND terminal_summary IS NOT NULL
            AND cancelled_at IS NULL
          )
          OR
          (
            status = 'cancelled'
            AND active_step_id IS NULL
            AND active_execution_id IS NULL
            AND checkpoint_json IS NULL
            AND terminal_summary IS NOT NULL
            AND cancelled_at IS NOT NULL
          )
        )
      );
      INSERT INTO agent_runs_v63 (
        run_id, root_event_id, owner_request_id, owner_principal_id,
        steward_agent_id, series_key, active_cycle_id, mandate_snapshot_json,
        workspace_grant_json, orchestration_mode, orchestrator_binding_json,
        status, active_step_id, active_execution_id, step_count, max_steps,
        max_depth, deadline_at, checkpoint_json, terminal_summary, cancelled_at,
        version, created_at, updated_at
      )
      SELECT
        run_id, root_event_id, owner_request_id, owner_principal_id,
        steward_agent_id, NULL, NULL, mandate_snapshot_json,
        workspace_grant_json, orchestration_mode, orchestrator_binding_json,
        status, active_step_id, active_execution_id, step_count, max_steps,
        max_depth, deadline_at, checkpoint_json, terminal_summary, cancelled_at,
        version, created_at, updated_at
      FROM agent_runs;
      DROP TABLE agent_runs;
      ALTER TABLE agent_runs_v63 RENAME TO agent_runs;
      DROP INDEX IF EXISTS agent_sessions_run_agent;
    `);
    if (!tableColumns(database, "agent_sessions").includes("cycle_id")) {
      database.exec("ALTER TABLE agent_sessions ADD COLUMN cycle_id TEXT");
    }
    createSchema(database);
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
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}
