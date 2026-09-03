import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("schema v72 adds durable external workflow execution and migration receipts", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v71-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        DROP TABLE external_workflow_executions;
        DROP TABLE proactive_source_migration_receipts;
        UPDATE schema_meta SET value = '71' WHERE key = 'schema_version';
      `);
    } finally {
      legacy.close();
    }
    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 72);
    const current = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(hasTable(current, "external_workflow_executions"), true);
      assert.equal(hasTable(current, "proactive_source_migration_receipts"), true);
      assert.equal(hasIndex(current, "external_workflow_executions_due"), true);
      assert.deepEqual(current.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      current.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function hasTable(database: DatabaseSync, name: string): boolean {
  return database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(name) !== undefined;
}

function hasIndex(database: DatabaseSync, name: string): boolean {
  return database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?"
  ).get(name) !== undefined;
}
