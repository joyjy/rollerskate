#!/usr/bin/env node

import { resolve } from "node:path";

import { initializeRuntimeSchema } from "../application/runtime-schema.js";

export function migrateLocalDatabase(argv = process.argv.slice(2)): number {
  const [databasePath, ...extra] = argv;
  if (databasePath === undefined || databasePath.trim() === "" || extra.length > 0) {
    process.stderr.write("Usage: rollerskate-local-migrate <database-path>\n");
    return 2;
  }

  const absolutePath = resolve(databasePath);
  const diagnostics = initializeRuntimeSchema(absolutePath);
  process.stdout.write(`${JSON.stringify({
    database: absolutePath,
    schemaVersion: diagnostics.schemaVersion
  })}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = migrateLocalDatabase();
}
