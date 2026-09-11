import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { migrateLocalDatabase } from "../src/infrastructure/sqlite/schema/index.js";
import { writeSchemaVersion } from "../src/infrastructure/sqlite/schema/introspection.js";

test("v74 migration preserves pending and terminal Delivery identities, receipts and retry budgets", () => {
  const database = new DatabaseSync(":memory:");
  try {
    migrateLocalDatabase(database);
    const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'").get() as { sql: string };
    database.exec(`
      DROP TRIGGER notice_project_delivery_insert;
      DROP TRIGGER notice_project_delivery_update;
      DROP INDEX deliveries_due;
      ALTER TABLE deliveries RENAME TO deliveries_new;
    `);
    database.exec(row.sql.replace(", 'codex-desktop'", ""));
    database.exec("DROP TABLE deliveries_new");
    for (const status of ["pending", "delivered", "failed"]) {
      database.prepare(`INSERT INTO deliveries (
        delivery_id, origin_kind, origin_id, destination_id, destination_kind,
        destination_address_json, payload_json, status, attempt_count, max_attempts,
        next_attempt_at, receipt, last_error, created_at, updated_at
      ) VALUES (?, 'host', ?, ?, 'matrix', '{}', '{}', ?, 1, 5, '2026-09-11', ?, ?, '2026-09-11', '2026-09-11')`)
        .run(`del-${status}`, `origin-${status}`, `dst-${status}`, status, status === "delivered" ? "old-receipt" : null,
          status === "failed" ? "old-error" : null);
    }
    writeSchemaVersion(database, 74);
    const before = database.prepare("SELECT * FROM deliveries ORDER BY delivery_id").all();
    migrateLocalDatabase(database);
    assert.deepEqual(database.prepare("SELECT * FROM deliveries ORDER BY delivery_id").all(), before);
    assert.equal((database.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value, "75");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    migrateLocalDatabase(database);
    assert.deepEqual(database.prepare("SELECT * FROM deliveries ORDER BY delivery_id").all(), before);
  } finally { database.close(); }
});
