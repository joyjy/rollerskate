import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("schema v72 adds durable legacy trigger migration receipts", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v68-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        DROP TABLE legacy_trigger_migration_receipts;
        UPDATE schema_meta SET value = '68' WHERE key = 'schema_version';
      `);
    } finally {
      legacy.close();
    }
    const diagnostics = initializeRuntimeSchema(databasePath);
    assert.equal(diagnostics.schemaVersion, 72);
    const current = new DatabaseSync(databasePath);
    try {
      const table = current.prepare(`
        SELECT 1 AS present FROM sqlite_master
        WHERE type = 'table' AND name = 'legacy_trigger_migration_receipts'
      `).get() as { present: number } | undefined;
      assert.equal(table?.present, 1);
    } finally {
      current.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
