import type { DatabaseSync } from "node:sqlite";

import { createSchema } from "./definition.js";
import {
  rowCount,
  tableColumns,
  tableExists,
  writeSchemaVersion
} from "./introspection.js";

export function assertV60SchemaShape(database: DatabaseSync): void {
  const columns = tableExists(database, "agent_runs")
    ? tableColumns(database, "agent_runs")
    : [];
  const callerColumns = [
    "orchestration_mode", "orchestrator_binding_json", "checkpoint_json"
  ];
  const hasCallerColumns = callerColumns.every((column) => columns.includes(column));
  const hasPartialCallerColumns = callerColumns.some((column) => columns.includes(column));
  if (columns.length === 0 || hasPartialCallerColumns !== hasCallerColumns ||
    (tableExists(database, "agent_run_decisions") &&
      rowCount(database, "agent_run_decisions") > 0)) {
    throw new Error("Local database schema 60 has an unsupported Agent Run shape");
  }
}

export function migrateV60Schema(database: DatabaseSync, targetVersion: number): void {
  if (tableColumns(database, "agent_runs").includes("orchestration_mode")) {
    database.exec("BEGIN IMMEDIATE");
    try {
      createSchema(database);
      writeSchemaVersion(database, targetVersion);
      database.exec("COMMIT");
      return;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE agent_runs_v60 (
        run_id TEXT PRIMARY KEY,
        root_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
        owner_request_id TEXT NOT NULL UNIQUE,
        owner_principal_id TEXT NOT NULL,
        steward_agent_id TEXT NOT NULL REFERENCES agents(principal_id),
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
            json_valid(orchestrator_binding_json)
            AND length(orchestrator_binding_json) <= 16384
          )
        ),
        status TEXT NOT NULL CHECK(status IN (
          'active', 'waiting', 'awaiting_orchestrator',
          'succeeded', 'failed', 'needs_human', 'cancelled'
        )),
        active_step_id TEXT,
        active_execution_id TEXT REFERENCES executions(execution_id),
        step_count INTEGER NOT NULL CHECK(step_count >= 1),
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
            AND checkpoint_json IS NOT NULL
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
    `);
    database.exec(`
      INSERT INTO agent_runs_v60 (
        run_id, root_event_id, owner_request_id, owner_principal_id,
        steward_agent_id, mandate_snapshot_json, workspace_grant_json,
        status, active_step_id, active_execution_id, step_count,
        max_steps, max_depth, deadline_at, terminal_summary, cancelled_at,
        version, created_at, updated_at
      )
      SELECT
        run_id, root_event_id, owner_request_id, owner_principal_id,
        steward_agent_id, mandate_snapshot_json, workspace_grant_json,
        status, active_step_id, active_execution_id, step_count,
        max_steps, max_depth, deadline_at, terminal_summary, cancelled_at,
        version, created_at, updated_at
      FROM agent_runs;
    `);
    database.exec("DROP TABLE agent_runs");
    database.exec("ALTER TABLE agent_runs_v60 RENAME TO agent_runs");
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
