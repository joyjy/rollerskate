import type { DatabaseSync } from "node:sqlite";

import { createSchema } from "./definition.js";
import { tableColumns, tableExists, writeSchemaVersion } from "./introspection.js";

const ARCHIVABLE_TABLES = [
  "schedules",
  "subscriptions",
  "continuous_subscriptions"
] as const;

export function assertV64SchemaShape(database: DatabaseSync): void {
  if (!tableExists(database, "agent_runs") ||
    !tableColumns(database, "agent_runs").includes("archived_at")) {
    throw new Error("Local database schema 64 has an unsupported Agent Run archive shape");
  }
  for (const table of ARCHIVABLE_TABLES) {
    if (!tableExists(database, table)) {
      throw new Error(`Local database schema 64 is missing ${table}`);
    }
  }
}

export function migrateV64Schema(database: DatabaseSync, targetVersion: number): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const table of ARCHIVABLE_TABLES) {
      if (!tableColumns(database, table).includes("archived_at")) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN archived_at TEXT`);
      }
    }
    createSchema(database);
    writeSchemaVersion(database, targetVersion);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
