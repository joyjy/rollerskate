import type { DatabaseSync } from "node:sqlite";

import { withImmediateTransaction } from "../transaction.js";
import { createSchema } from "./definition.js";
import { preV61ProductTables, tableColumns, writeSchemaVersion } from "./introspection.js";
import { V60_TARGET_TABLES as TARGET_TABLES } from "./v44-migration.js";

export function assertV57SchemaShape(database: DatabaseSync): void {
  const actual = preV61ProductTables(database);
  if (actual.length !== TARGET_TABLES.length ||
    TARGET_TABLES.some((table) => !actual.includes(table))) {
    throw new Error("Local database schema 57 is incomplete");
  }
  for (const table of ["schedules", "subscriptions", "continuous_subscriptions"]) {
    if (!tableColumns(database, table).includes("external_ref_binding_json")) {
      throw new Error(`Local database schema 57 is missing ${table}.external_ref_binding_json`);
    }
  }
}

export function migrateV57Schema(database: DatabaseSync, targetVersion: number): void {
  withImmediateTransaction(database, () => {
    createSchema(database);
    writeSchemaVersion(database, targetVersion);
    const violations = database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(`Local database migration left ${violations.length} foreign key violations`);
    }
  });
}
