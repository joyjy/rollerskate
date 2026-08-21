import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runtimeStatus } from "../src/application/runtime/control.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("runtime schema rejects unsupported direct migration without dropping old work", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-"));
  try {
    const databasePath = join(directory, "runtime.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '20');
      CREATE TABLE deliveries (
        delivery_id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL
      );
      INSERT INTO deliveries (delivery_id, work_id)
      VALUES ('legacy-delivery', 'legacy-work');
    `);
    legacy.close();

    assert.throws(
      () => initializeRuntimeSchema(databasePath),
      /schema 20 cannot migrate directly to 63/
    );
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.deepEqual(
        { ...preserved.prepare("SELECT * FROM deliveries").get() },
        { delivery_id: "legacy-delivery", work_id: "legacy-work" }
      );
    } finally {
      preserved.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime status remains readable before an incompatible schema is migrated", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-pre-migration-status-"));
  try {
    const database = new DatabaseSync(join(directory, "runtime.db"));
    database.exec(`
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        prompt TEXT NOT NULL
      );
    `);
    database.close();

    assert.equal(runtimeStatus(directory, directory).activity, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
