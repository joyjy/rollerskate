import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("schema v69 adds archive visibility to Schedule and Subscription owners", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v64-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        DROP INDEX schedules_archive_updated;
        DROP INDEX subscriptions_archive_updated;
        DROP INDEX continuous_subscriptions_archive_updated;
        ALTER TABLE schedules DROP COLUMN archived_at;
        ALTER TABLE subscriptions DROP COLUMN archived_at;
        ALTER TABLE continuous_subscriptions DROP COLUMN archived_at;
        UPDATE schema_meta SET value = '64' WHERE key = 'schema_version';
      `);
    } finally {
      legacy.close();
    }

    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 69);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      for (const table of ["schedules", "subscriptions", "continuous_subscriptions"]) {
        const columns = database.prepare(`PRAGMA table_info(${table})`).all() as
          unknown as Array<{ name: string }>;
        assert.equal(columns.some(({ name }) => name === "archived_at"), true);
      }
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
