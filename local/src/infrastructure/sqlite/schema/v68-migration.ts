import type { DatabaseSync } from "node:sqlite";

import { createSchema } from "./definition.js";
import { tableColumns, tableExists, writeSchemaVersion } from "./introspection.js";

export function assertV68SchemaShape(database: DatabaseSync): void {
  if (!["agent_runs", "agent_run_cycles", "agent_run_decisions", "schedules",
    "scheduled_runs", "subscriptions", "continuous_subscriptions"].every(
    (table) => tableExists(database, table)
  ) || !tableColumns(database, "agent_runs").includes("source_binding_json") ||
    !tableColumns(database, "agent_run_cycles").includes("source_envelope_json") ||
    !tableColumns(database, "subscriptions").includes("admission_receipt_json") ||
    !tableColumns(database, "continuous_subscriptions").includes(
      "pending_admission_receipt_json"
    )) {
    throw new Error("Local database schema 68 is incomplete");
  }
}

export function migrateV68Schema(database: DatabaseSync, targetVersion: number): void {
  database.exec("BEGIN IMMEDIATE");
  try {
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
  }
}
