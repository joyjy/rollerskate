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
    assert.equal(first.schemaVersion, 34);
    assert.equal(second.schemaVersion, 34);
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
      "local_principals",
      "local_agent_profiles",
      "local_foundation",
      "server_connections",
      "server_device_bindings",
      "server_agent_bindings",
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

    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 34);
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

test("schema v33 preserves Local Chat history while renaming Room facts to Topic", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-chat-schema-"));
  try {
    const databasePath = join(directory, "runtime.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '32');
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('agent.request', 'subscription.fire', 'agent.result',
          'room.message', 'room.dispatch')),
        source_kind TEXT NOT NULL,
        source_external_id TEXT,
        agent_id TEXT,
        prompt TEXT,
        outcome TEXT,
        output TEXT,
        error TEXT,
        payload_json TEXT,
        session_id TEXT,
        destination_ids_json TEXT NOT NULL,
        root_event_id TEXT NOT NULL,
        parent_event_id TEXT,
        causal_hop INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE executions (
        execution_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        handler TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO events (
        event_id, type, source_kind, source_external_id, agent_id, prompt,
        outcome, output, error, payload_json, session_id, destination_ids_json,
        root_event_id, parent_event_id, causal_hop, created_at
      ) VALUES (
        'evt_019b0000-0000-7000-8000-000000000001',
        'room.message', 'cli', NULL, 'prn_owner', NULL,
        NULL, NULL, NULL,
        '{"roomId":"rom_legacy","sender":{"kind":"owner","principalId":"prn_owner","handleSnapshot":"owner"},"body":"preserve me"}',
        NULL, '[]', 'evt_019b0000-0000-7000-8000-000000000001', NULL, 0,
        '2026-07-24T00:00:00.000Z'
      );
      INSERT INTO executions (
        execution_id, event_id, handler, status, attempt_count, max_attempts,
        next_attempt_at, created_at, updated_at
      ) VALUES (
        'exe_legacy', 'evt_019b0000-0000-7000-8000-000000000001',
        'result', 'succeeded', 1, 3,
        '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z',
        '2026-07-24T00:00:00.000Z'
      );
      CREATE TABLE local_principals (
        principal_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        handle TEXT NOT NULL,
        handle_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO local_principals VALUES (
        'prn_owner', 'owner', 'owner', 'owner', 'active',
        '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z'
      );
      CREATE TABLE local_foundation (
        singleton INTEGER PRIMARY KEY,
        device_id TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        room_id TEXT NOT NULL UNIQUE,
        room_handle TEXT NOT NULL UNIQUE,
        owner_principal_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      INSERT INTO local_foundation VALUES (
        1, 'dev_legacy', 'legacy-device', '/tmp/legacy-workspace',
        'rom_legacy', 'local', 'prn_owner', '2026-07-24T00:00:00.000Z'
      );
      CREATE TABLE local_room_dispatches (
        source_message_event_id TEXT PRIMARY KEY,
        dispatch_event_id TEXT NOT NULL UNIQUE,
        target_principal_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE local_room_prompts (
        source_message_event_id TEXT PRIMARY KEY,
        prompt_event_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `);
    legacy.close();

    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 34);
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const event = migrated.prepare(`
        SELECT type, payload_json FROM events
        WHERE event_id = 'evt_019b0000-0000-7000-8000-000000000001'
      `).get() as { type: string; payload_json: string };
      assert.equal(event.type, "chat.message");
      assert.deepEqual(JSON.parse(event.payload_json), {
        sender: {
          kind: "owner",
          principalId: "prn_owner",
          handleSnapshot: "owner"
        },
        body: "preserve me",
        topicId: "rom_legacy"
      });
      const foundationColumns = (migrated.prepare(`
        PRAGMA table_info(local_foundation)
      `).all() as unknown as Array<{ name: string }>).map(({ name }) => name);
      assert.ok(foundationColumns.includes("topic_id"));
      assert.ok(!foundationColumns.includes("room_id"));
      const tables = (migrated.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `).all() as unknown as Array<{ name: string }>).map(({ name }) => name);
      assert.ok(tables.includes("local_chat_dispatches"));
      assert.ok(tables.includes("local_chat_prompts"));
      assert.ok(!tables.includes("local_room_dispatches"));
      assert.ok(!tables.includes("local_room_prompts"));
      assert.equal((migrated.prepare(`
        SELECT COUNT(*) AS count FROM executions WHERE execution_id = 'exe_legacy'
      `).get() as { count: number }).count, 1);
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
