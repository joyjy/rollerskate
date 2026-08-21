import type { DatabaseSync } from "node:sqlite";

import { createSchema } from "./definition.js";
import {
  tableColumns,
  tableExists,
  writeSchemaVersion
} from "./introspection.js";

const DELIVERY_COLUMNS = [
  "delivery_id", "result_event_id", "origin_kind", "origin_id",
  "destination_id", "destination_kind", "destination_address_json",
  "payload_json", "status", "attempt_count", "max_attempts",
  "next_attempt_at", "receipt", "last_error", "created_at", "updated_at"
] as const;

export function assertV61SchemaShape(database: DatabaseSync): void {
  const sql = tableSql(database, "deliveries");
  if (!tableExists(database, "agent_run_decisions") ||
    !["orchestration_mode", "orchestrator_binding_json", "checkpoint_json"].every(
      (column) => tableColumns(database, "agent_runs").includes(column)
    ) ||
    JSON.stringify(tableColumns(database, "deliveries")) !== JSON.stringify(DELIVERY_COLUMNS) ||
    !sql.includes("server-topic")) {
    throw new Error("Local database schema 61 has an unsupported Delivery shape");
  }
}

export function migrateV61Schema(database: DatabaseSync, targetVersion: number): void {
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!hasInitialStewardRunShape(database)) {
      rebuildAgentRuns(database);
    }
    if (!hasVikunjaTaskDeliveryKind(database)) {
      database.exec(`
        DROP TRIGGER IF EXISTS notice_project_delivery_insert;
        DROP TRIGGER IF EXISTS notice_project_delivery_update;
        DROP INDEX IF EXISTS deliveries_due;
        ALTER TABLE deliveries RENAME TO deliveries_v61;
      `);
    }
    createSchema(database);
    if (tableExists(database, "deliveries_v61")) {
      database.exec(`
        INSERT INTO deliveries (${DELIVERY_COLUMNS.join(", ")})
        SELECT ${DELIVERY_COLUMNS.join(", ")}
        FROM deliveries_v61;
        DROP TABLE deliveries_v61;
      `);
    }
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

export function hasVikunjaTaskDeliveryKind(database: DatabaseSync): boolean {
  return tableSql(database, "deliveries").includes("vikunja-task");
}

export function hasInitialStewardRunShape(database: DatabaseSync): boolean {
  const sql = tableSql(database, "agent_runs");
  return sql.includes("step_count >= 0") &&
    sql.includes("checkpoint_json IS NOT NULL OR step_count = 0");
}

function rebuildAgentRuns(database: DatabaseSync): void {
  database.exec(`
    DROP INDEX IF EXISTS agent_runs_status_updated;
    DROP INDEX IF EXISTS agent_runs_active_write_workspace;
    CREATE TABLE agent_runs_v62 (
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
          json_valid(orchestrator_binding_json) AND length(orchestrator_binding_json) <= 16384
        )
      ),
      status TEXT NOT NULL CHECK(status IN (
        'active', 'waiting', 'awaiting_orchestrator',
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
    INSERT INTO agent_runs_v62 (
      run_id, root_event_id, owner_request_id, owner_principal_id,
      steward_agent_id, mandate_snapshot_json, workspace_grant_json,
      orchestration_mode, orchestrator_binding_json, status, active_step_id,
      active_execution_id, step_count, max_steps, max_depth, deadline_at,
      checkpoint_json, terminal_summary, cancelled_at, version, created_at, updated_at
    )
    SELECT
      run_id, root_event_id, owner_request_id, owner_principal_id,
      steward_agent_id, mandate_snapshot_json, workspace_grant_json,
      orchestration_mode, orchestrator_binding_json, status, active_step_id,
      active_execution_id, step_count, max_steps, max_depth, deadline_at,
      checkpoint_json, terminal_summary, cancelled_at, version, created_at, updated_at
    FROM agent_runs;
    DROP TABLE agent_runs;
    ALTER TABLE agent_runs_v62 RENAME TO agent_runs;
  `);
}

function tableSql(database: DatabaseSync, table: string): string {
  const row = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table) as { readonly sql: string } | undefined;
  return row?.sql ?? "";
}
