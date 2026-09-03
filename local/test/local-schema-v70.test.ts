import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("schema v72 adds unified proactive targets and deterministic action receipts", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v70-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
      for (const table of [
        "scheduled_runs",
        "schedules",
        "subscriptions",
        "continuous_subscriptions"
      ] as const) {
        if (table === "scheduled_runs") continue;
        rebuildWithoutTarget(legacy, table);
      }
      legacy.exec(`
        DROP TABLE deterministic_action_receipts;
        UPDATE schema_meta SET value = '70' WHERE key = 'schema_version';
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
    } finally {
      legacy.close();
    }
    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 72);
    const current = new DatabaseSync(databasePath, { readOnly: true });
    try {
      for (const table of ["schedules", "subscriptions", "continuous_subscriptions"]) {
        assert.equal(columns(current, table).includes("target_json"), true);
      }
      assert.equal(columns(current, "deterministic_action_receipts").includes("receipt_json"), true);
      assert.deepEqual(current.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      current.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function rebuildWithoutTarget(database: DatabaseSync, table: string): void {
  const selected = columns(database, table).filter((column) => column !== "target_json");
  const legacy = `${table}_v70`;
  database.exec(`
    CREATE TABLE ${legacy} AS SELECT ${selected.join(", ")} FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE ${legacy} RENAME TO ${table};
  `);
}

function columns(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as unknown as
    Array<{ name: string }>).map(({ name }) => name);
}
