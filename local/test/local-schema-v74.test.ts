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
    database.exec(`
      DROP TRIGGER chat_message_project_read_progress_dispatch;
      CREATE TRIGGER chat_message_project_read_progress_dispatch
      AFTER UPDATE OF status, receipt_json ON executions
      WHEN EXISTS (
        SELECT 1 FROM events
        WHERE event_id = NEW.event_id AND type = 'chat.dispatch'
      )
      BEGIN
        UPDATE chat_messages
        SET read_progress_json = (
            SELECT progress_json
            FROM chat_message_read_progress_v1
            WHERE event_id = json_extract(
              (SELECT payload_json FROM events WHERE event_id = NEW.event_id),
              '$.sourceMessageEventId'
            )
          ),
          projected_at = NEW.updated_at
        WHERE event_id = json_extract(
          (SELECT payload_json FROM events WHERE event_id = NEW.event_id),
          '$.sourceMessageEventId'
        );
      END;
    `);
    const before = database.prepare("SELECT * FROM deliveries ORDER BY delivery_id").all();
    migrateLocalDatabase(database);
    assert.deepEqual(database.prepare("SELECT * FROM deliveries ORDER BY delivery_id").all(), before);
    assert.equal((database.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value, "80");
    const trigger = database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'chat_message_project_read_progress_dispatch'
    `).get() as { sql: string };
    assert.match(trigger.sql, /json_each\(chat_messages\.attention_json, '\$\.receipts'\)/);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    migrateLocalDatabase(database);
    assert.deepEqual(database.prepare("SELECT * FROM deliveries ORDER BY delivery_id").all(), before);
  } finally { database.close(); }
});
