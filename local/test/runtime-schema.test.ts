import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runtimeStatus } from "../src/application/loop-control.js";
import { initializeRuntimeSchema } from "../src/application/runtime-schema.js";

test("runtime schema cleanly cuts over an incompatible work outbox and initializes idempotently", () => {
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
      INSERT INTO deliveries (delivery_id, work_id) VALUES ('legacy-delivery', 'legacy-work');
    `);
    legacy.close();

    const first = initializeRuntimeSchema(databasePath);
    const second = initializeRuntimeSchema(databasePath);
    assert.equal(first.schemaVersion, 31);
    assert.equal(second.schemaVersion, 31);
    assert.equal(first.journalMode, "wal");
    assert.deepEqual(second.tables, first.tables);
    for (const table of [
      "events",
      "executions",
      "sessions",
      "destinations",
      "deliveries",
      "local_device_registration",
      "local_agents",
      "poll_subscriptions"
    ]) {
      assert.ok(first.tables.includes(table), `missing table: ${table}`);
    }
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const columns = database.prepare("PRAGMA table_info(local_agents)").all() as unknown as
        Array<{ name: string }>;
      assert.ok(columns.some((column) => column.name === "agent_client"));
      const deliveryColumns = database.prepare("PRAGMA table_info(deliveries)").all() as unknown as
        Array<{ name: string }>;
      assert.ok(deliveryColumns.some((column) => column.name === "result_event_id"));
      assert.ok(!first.tables.includes("results"));
      assert.ok(!deliveryColumns.some((column) => column.name === "work_id"));
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime schema preserves legacy Agents and defaults their client to Codex", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-agent-client-schema-"));
  try {
    const databasePath = join(directory, "runtime.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '17');
      CREATE TABLE local_agents (
        agent_id TEXT NOT NULL UNIQUE,
        name TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        placement_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        credential_id TEXT,
        workspace_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        last_verified_at TEXT
      );
      INSERT INTO local_agents (
        agent_id, name, status, placement_id, device_id, generation,
        workspace_path, created_at
      ) VALUES (
        'agent-1', 'alice', 'active', 'placement-1', 'device-1', 1,
        '/tmp/alice', '2026-07-20T00:00:00.000Z'
      );
    `);
    legacy.close();

    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 31);
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal((migrated.prepare(`
        SELECT agent_client FROM local_agents WHERE name = 'alice'
      `).get() as { agent_client: string }).agent_client, "codex");
    } finally {
      migrated.close();
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
