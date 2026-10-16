import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RuntimeStore } from "../src/core/runtime/store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("schema v74 preserves existing Deliveries while admitting Vikunja task destinations", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v61-delivery-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const store = new RuntimeStore(databasePath);
    const existing = store.enqueueHostDelivery({
      originId: "host:preserved-delivery",
      destinationId: "dst_019b0000-0000-7000-8000-000000000061",
      kind: "matrix",
      address: { roomId: "!preserved:example.com" },
      payload: { body: "preserve me" },
      at: "2026-08-18T08:00:00.000Z"
    });
    store.close();

    downgradeDeliveriesToV61(databasePath);
    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 80);

    const restored = new RuntimeStore(databasePath);
    try {
      assert.equal(restored.delivery(existing.deliveryId)?.payload.body, "preserve me");
      const vikunja = restored.enqueueHostDelivery({
        originId: "host:vikunja-delivery",
        destinationId: "dst_019b0000-0000-7000-8000-000000000062",
        kind: "vikunja-task",
        address: { taskUrl: "http://127.0.0.1:3456/tasks/42" },
        payload: { schemaVersion: "VikunjaTaskComment@1", body: "done" },
        at: "2026-08-18T08:01:00.000Z"
      });
      assert.equal(vikunja.status, "pending");
    } finally {
      restored.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function downgradeDeliveriesToV61(path: string): void {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      DROP TRIGGER IF EXISTS notice_project_delivery_insert;
      DROP TRIGGER IF EXISTS notice_project_delivery_update;
      DROP INDEX IF EXISTS deliveries_due;
      ALTER TABLE deliveries RENAME TO deliveries_v62_fixture;
      CREATE TABLE deliveries (
        delivery_id TEXT PRIMARY KEY,
        result_event_id TEXT REFERENCES events(event_id),
        origin_kind TEXT NOT NULL CHECK(origin_kind IN ('event', 'host')),
        origin_id TEXT NOT NULL,
        destination_id TEXT NOT NULL,
        destination_kind TEXT NOT NULL CHECK(destination_kind IN (
          'matrix', 'macos-notification', 'server-topic'
        )),
        destination_address_json TEXT NOT NULL CHECK(json_valid(destination_address_json)),
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        status TEXT NOT NULL CHECK(status IN (
          'pending', 'delivering', 'retry_wait', 'delivered', 'failed'
        )),
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
        max_attempts INTEGER NOT NULL CHECK(max_attempts >= 1),
        next_attempt_at TEXT NOT NULL,
        receipt TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(
          (origin_kind = 'event' AND result_event_id = origin_id) OR
          (origin_kind = 'host' AND result_event_id IS NULL)
        ),
        UNIQUE(origin_kind, origin_id, destination_id)
      );
      INSERT INTO deliveries SELECT * FROM deliveries_v62_fixture;
      DROP TABLE deliveries_v62_fixture;
      CREATE INDEX deliveries_due ON deliveries(status, next_attempt_at);
      UPDATE schema_meta SET value = '61' WHERE key = 'schema_version';
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
    database.close();
  }
}
