import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runtimeStatus } from "../src/application/runtime/control.js";
import { addLocalAgent, localRuntimeSnapshot } from "../src/application/agent/control.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { RuntimeStore } from "../src/core/runtime/store.js";

test("runtime schema rejects unsupported direct migration instead of dropping old work", () => {
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

    assert.throws(
      () => initializeRuntimeSchema(databasePath),
      /schema 20 cannot migrate directly to 44/
    );
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    const rows = preserved.prepare("SELECT * FROM deliveries").all() as unknown as
      Array<{ delivery_id: string; work_id: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.delivery_id, "legacy-delivery");
    assert.equal(rows[0]?.work_id, "legacy-work");
    preserved.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skip("superseded v39 direct migration fixture", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-schema-v40-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v40-runtime-"));
  const databasePath = join(runtimeDirectory, "runtime.db");
  const at = "2026-07-25T12:00:00.000Z";
  try {
    const agent = addLocalAgent(repo, "alice", "kimi-code", {
      runtimeDirectory,
      now: () => new Date(at)
    }, ["--model", "kimi"]);
    const runtime = new RuntimeStore(databasePath);
    let requestEventId: string;
    let deliveryId: string;
    try {
      const destination = runtime.putDestination({
        kind: "macos-notification",
        address: { title: "Preserve me" },
        at
      });
      const request = runtime.appendEvent({
        type: "agent.request",
        source: { kind: "cli" },
        agentId: agent.principalId,
        prompt: "preserve request",
        destinationIds: [destination.destinationId],
        createdAt: at
      });
      requestEventId = request.event.eventId;
      const running = runtime.claimDueExecutions(1, at)[0]!;
      runtime.completeExecution(running.executionId, {
        adapterId: "kimi-code-v1",
        workspace: join(runtimeDirectory, "workspace"),
        providerSessionId: "provider-v39",
        output: "preserve result"
      }, at);
      const resultExecution = runtime.claimDueExecutions(1, at)[0]!;
      runtime.completeResultExecution(resultExecution.executionId, at);
      deliveryId = runtime.claimDueDeliveries(1, at)[0]!.deliveryId;
    } finally {
      runtime.close();
    }

    const v39 = new DatabaseSync(databasePath);
    try {
      v39.exec(`
        PRAGMA foreign_keys = OFF;
        DROP INDEX executions_due;
        CREATE TABLE executions_v39 (
          execution_id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
          handler TEXT NOT NULL CHECK(handler IN ('agent', 'result', 'review')),
          status TEXT NOT NULL CHECK(status IN ('queued','running','retry_wait','succeeded','failed')),
          attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
          max_attempts INTEGER NOT NULL CHECK(max_attempts >= 1),
          next_attempt_at TEXT NOT NULL,
          last_error TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          updated_at TEXT NOT NULL
        );
        INSERT INTO executions_v39 SELECT * FROM executions;
        DROP TABLE executions;
        ALTER TABLE executions_v39 RENAME TO executions;
        CREATE INDEX executions_due ON executions(status, next_attempt_at);
        UPDATE schema_meta SET value = '39' WHERE key = 'schema_version';
        PRAGMA foreign_keys = ON;
      `);
    } finally {
      v39.close();
    }

    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 42);
    const migrated = new RuntimeStore(databasePath);
    try {
      assert.equal(migrated.event(requestEventId)?.type, "agent.request");
      assert.equal(migrated.executionForEvent(requestEventId)?.status, "succeeded");
      assert.equal(migrated.delivery(deliveryId)?.status, "delivering");
      assert.equal(migrated.destination(migrated.delivery(deliveryId)!.destinationId)?.kind,
        "macos-notification");
      const preserved = localRuntimeSnapshot(repo, { runtimeDirectory }).agents[0]!;
      assert.equal(preserved.principalId, agent.principalId);
      assert.equal(preserved.client, "kimi-code");
      assert.deepEqual(preserved.executionConfig.launchArgs, ["--model", "kimi"]);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test.skip("superseded v35 direct migration fixture", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-subscription-fire-"));
  try {
    const databasePath = join(directory, "runtime.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(adapter_id, provider_session_id)
      );
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN (
          'agent.request', 'subscription.fire', 'agent.result', 'chat.message', 'chat.dispatch'
        )),
        source_kind TEXT NOT NULL CHECK(source_kind IN ('cli', 'subscription', 'matrix', 'server', 'handler')),
        source_external_id TEXT,
        agent_id TEXT,
        prompt TEXT,
        outcome TEXT CHECK(outcome IN ('succeeded', 'failed')),
        output TEXT,
        error TEXT,
        payload_json TEXT,
        session_id TEXT REFERENCES sessions(session_id),
        destination_ids_json TEXT NOT NULL,
        root_event_id TEXT NOT NULL,
        parent_event_id TEXT,
        causal_hop INTEGER NOT NULL CHECK(causal_hop >= 0),
        created_at TEXT NOT NULL,
        CHECK(
          (type IN ('agent.request', 'subscription.fire') AND agent_id IS NOT NULL
            AND prompt IS NOT NULL AND outcome IS NULL AND output IS NULL
            AND error IS NULL AND payload_json IS NULL)
          OR
          (type = 'agent.result' AND agent_id IS NOT NULL AND prompt IS NULL
            AND outcome IS NOT NULL AND payload_json IS NULL
            AND ((outcome = 'succeeded' AND output IS NOT NULL AND error IS NULL)
              OR (outcome = 'failed' AND output IS NULL AND error IS NOT NULL)))
          OR
          (type = 'chat.message' AND prompt IS NULL AND outcome IS NULL
            AND output IS NULL AND error IS NULL AND payload_json IS NOT NULL)
          OR
          (type = 'chat.dispatch' AND agent_id IS NOT NULL AND prompt IS NOT NULL
            AND outcome IS NULL AND output IS NULL AND error IS NULL
            AND payload_json IS NOT NULL)
        ),
        UNIQUE(source_kind, source_external_id)
      );
      INSERT INTO sessions VALUES (
        'ses_019f0000-0000-7000-8000-000000000001',
        'prn_019f0000-0000-7000-8000-000000000001',
        'fake-agent-v1', 'provider-1', '/workspace',
        '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z'
      );
      INSERT INTO events VALUES (
        'evt_019f0000-0000-7000-8000-000000000001',
        'subscription.fire', 'subscription', 'sub_legacy',
        'prn_019f0000-0000-7000-8000-000000000001', 'legacy prompt',
        NULL, NULL, NULL, NULL,
        'ses_019f0000-0000-7000-8000-000000000001', '[]',
        'evt_019f0000-0000-7000-8000-000000000001', NULL, 0,
        '2026-07-24T00:00:00.000Z'
      );
    `);
    legacy.close();

    const runtime = new RuntimeStore(databasePath);
    try {
      const event = runtime.event("evt_019f0000-0000-7000-8000-000000000001");
      assert.equal(event?.type, "subscription.fire");
      assert.equal(event?.type === "subscription.fire" ? event.observation : "wrong", undefined);
    } finally {
      runtime.close();
    }

    const migrated = new DatabaseSync(databasePath);
    try {
      migrated.prepare(`
        INSERT INTO events (
          event_id, type, source_kind, source_external_id, agent_id, prompt,
          payload_json, session_id, destination_ids_json, root_event_id,
          parent_event_id, causal_hop, created_at
        ) VALUES (?, 'subscription.fire', 'subscription', ?, ?, ?, ?, ?, '[]', ?, NULL, 0, ?)
      `).run(
        "evt_019f0000-0000-7000-8000-000000000002",
        "sub_current",
        "prn_019f0000-0000-7000-8000-000000000001",
        "current prompt",
        JSON.stringify({
          version: "pipeline-1:success",
          facts: { status: "success" },
          terminal: "success",
          summary: "Pipeline passed"
        }),
        "ses_019f0000-0000-7000-8000-000000000001",
        "evt_019f0000-0000-7000-8000-000000000002",
        "2026-07-24T00:01:00.000Z"
      );
    } finally {
      migrated.close();
    }

    const restored = new RuntimeStore(databasePath);
    try {
      const event = restored.event("evt_019f0000-0000-7000-8000-000000000002");
      assert.deepEqual(event?.type === "subscription.fire" ? event.observation : undefined, {
        version: "pipeline-1:success",
        facts: { status: "success" },
        terminal: "success",
        summary: "Pipeline passed"
      });
    } finally {
      restored.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skip("superseded v17 direct migration fixture", () => {
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

    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 42);
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

test.skip("superseded v33 direct migration fixture", () => {
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

    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 42);
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
