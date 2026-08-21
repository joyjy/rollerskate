import type { DatabaseSync } from "node:sqlite";

import { withImmediateTransaction } from "../transaction.js";
import { createSchema } from "./definition.js";
import { preV61ProductTables, tableColumns, writeSchemaVersion } from "./introspection.js";
import { V60_TARGET_TABLES as TARGET_TABLES } from "./v44-migration.js";

const BINDING_COLUMN = "external_ref_binding_json";

export function assertV56SchemaShape(database: DatabaseSync): void {
  const actual = preV61ProductTables(database);
  if (actual.length !== TARGET_TABLES.length ||
    TARGET_TABLES.some((table) => !actual.includes(table))) {
    throw new Error("Local database schema 56 is incomplete");
  }
  for (const table of ["schedules", "subscriptions", "continuous_subscriptions"]) {
    if (tableColumns(database, table).includes(BINDING_COLUMN)) {
      throw new Error(`Local database schema 56 has unexpected ${table}.${BINDING_COLUMN}`);
    }
  }
}

export function migrateV56Schema(database: DatabaseSync, targetVersion: number): void {
  withImmediateTransaction(database, () => {
    for (const table of ["schedules", "subscriptions", "continuous_subscriptions"]) {
      database.exec(`
        ALTER TABLE ${table} ADD COLUMN external_ref_binding_json TEXT CHECK(
          external_ref_binding_json IS NULL OR (
            json_valid(external_ref_binding_json) AND length(external_ref_binding_json) <= 16384
          )
        )
      `);
    }
    createSchema(database);
    writeSchemaVersion(database, targetVersion);
    const violations = database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(`Local database migration left ${violations.length} foreign key violations`);
    }
  });
}
