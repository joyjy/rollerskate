import type { DatabaseSync } from "node:sqlite";

import { migrateLocalDatabase } from "./local-schema.js";

/**
 * Runtime callers keep this capability-oriented entry point; the physical Local
 * database schema has one owner in local-schema.ts.
 */
export function migrateRuntimeDatabase(database: DatabaseSync): void {
  migrateLocalDatabase(database);
}
