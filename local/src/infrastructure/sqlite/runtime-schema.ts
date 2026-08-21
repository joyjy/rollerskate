import type { DatabaseSync } from "node:sqlite";

import { migrateLocalDatabase } from "./schema/index.js";

/**
 * Runtime callers keep this capability-oriented entry point; the physical Local
 * database schema has one owner in schema/index.ts.
 */
export function migrateRuntimeDatabase(database: DatabaseSync): void {
  migrateLocalDatabase(database);
}
