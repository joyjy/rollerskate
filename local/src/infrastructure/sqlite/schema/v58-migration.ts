import type { DatabaseSync } from "node:sqlite";

import { withImmediateTransaction } from "../transaction.js";
import { createSchema } from "./definition.js";
import { preV61ProductTables, tableColumns, writeSchemaVersion } from "./introspection.js";
import { V60_TARGET_TABLES as TARGET_TABLES } from "./v44-migration.js";

export const LEGACY_V58_RELEASE_CANDIDATE_TABLES = [
  "release_candidate_runtime",
  "release_candidates",
  "release_candidate_messages"
] as const;

export const LEGACY_RELEASE_CANDIDATE_TABLES = [
  ...LEGACY_V58_RELEASE_CANDIDATE_TABLES,
  "release_candidate_effects"
] as const;

export function assertV58SchemaShape(database: DatabaseSync): void {
  const actual = preV61ProductTables(database);
  const expected = [...TARGET_TABLES, ...LEGACY_V58_RELEASE_CANDIDATE_TABLES];
  if (actual.length !== expected.length ||
    expected.some((table) => !actual.includes(table)) ||
    actual.includes("release_candidate_effects")) {
    throw new Error("Local database schema 58 is incomplete");
  }
  if (!tableColumns(database, "release_candidate_runtime")
    .includes("bootstrap_until_cursor")) {
    throw new Error(
      "Local database schema 58 is missing release_candidate_runtime.bootstrap_until_cursor"
    );
  }
}

export function hasSupportedLegacyReleaseCandidateTables(
  database: DatabaseSync,
  actual: readonly string[]
): boolean {
  const legacy = actual.filter((table) =>
    LEGACY_RELEASE_CANDIDATE_TABLES.some((candidate) => candidate === table));
  if (legacy.length === 0) return true;
  if (legacy.length !== LEGACY_V58_RELEASE_CANDIDATE_TABLES.length &&
    legacy.length !== LEGACY_RELEASE_CANDIDATE_TABLES.length) return false;
  if (LEGACY_V58_RELEASE_CANDIDATE_TABLES.some((table) => !legacy.includes(table))) return false;
  return tableColumns(database, "release_candidate_runtime")
    .includes("bootstrap_until_cursor");
}

export function migrateV58Schema(database: DatabaseSync, targetVersion: number): void {
  withImmediateTransaction(database, () => {
    createSchema(database);
    writeSchemaVersion(database, targetVersion);
    const violations = database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length > 0) {
      throw new Error(`Local database migration left ${violations.length} foreign key violations`);
    }
  });
}
