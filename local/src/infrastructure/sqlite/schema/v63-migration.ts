import type { DatabaseSync } from "node:sqlite";

import { createSchema } from "./definition.js";
import { tableColumns, tableExists, writeSchemaVersion } from "./introspection.js";

export function assertV63SchemaShape(database: DatabaseSync): void {
  if (!tableExists(database, "agent_runs") ||
    !tableColumns(database, "agent_runs").includes("series_key")) {
    throw new Error("Local database schema 63 has an unsupported Agent Run shape");
  }
}

export function migrateV63Schema(database: DatabaseSync, targetVersion: number): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!tableColumns(database, "agent_runs").includes("archived_at")) {
      database.exec("ALTER TABLE agent_runs ADD COLUMN archived_at TEXT");
    }
    createSchema(database);
    writeSchemaVersion(database, targetVersion);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
