import type { DatabaseSync } from "node:sqlite";

import { tableColumns, tableExists, writeSchemaVersion } from "./introspection.js";

export function assertV65SchemaShape(database: DatabaseSync): void {
  if (!tableExists(database, "agent_runs") ||
    !tableExists(database, "agent_run_cycles") ||
    !tableColumns(database, "agent_runs").includes("archived_at")) {
    throw new Error("Local database schema 65 has an unsupported Agent Run shape");
  }
}

export function migrateV65Schema(database: DatabaseSync, targetVersion: number): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!tableColumns(database, "agent_runs").includes("source_binding_json")) {
      database.exec(`
        ALTER TABLE agent_runs ADD COLUMN source_binding_json TEXT CHECK(
          source_binding_json IS NULL OR (
            json_valid(source_binding_json)
            AND length(source_binding_json) <= 16384
            AND series_key IS NOT NULL
          )
        )
      `);
    }
    if (!tableColumns(database, "agent_run_cycles").includes("source_envelope_json")) {
      database.exec(`
        ALTER TABLE agent_run_cycles ADD COLUMN source_envelope_json TEXT CHECK(
          source_envelope_json IS NULL OR (
            json_valid(source_envelope_json)
            AND length(source_envelope_json) <= 65536
          )
        )
      `);
    }
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS agent_run_cycles_run_occurrence
        ON agent_run_cycles(
          run_id,
          json_extract(source_envelope_json, '$.occurrenceKey')
        )
        WHERE source_envelope_json IS NOT NULL
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
