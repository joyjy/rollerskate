import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("schema v43 atomically compacts a v42 database into 13 product tables", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v43-"));
  const databasePath = join(directory, "runtime.db");
  try {
    const legacy = new DatabaseSync(databasePath);
    createV42Fixture(legacy);
    legacy.close();

    const diagnostics = initializeRuntimeSchema(databasePath);
    const repeated = initializeRuntimeSchema(databasePath);
    assert.equal(diagnostics.schemaVersion, 43);
    assert.deepEqual(repeated, diagnostics);
    assert.deepEqual(diagnostics.tables, [
      "agent_sessions",
      "agents",
      "chat_presence",
      "deliveries",
      "events",
      "executions",
      "local_foundation",
      "notices",
      "reviews",
      "scheduled_runs",
      "schedules",
      "schema_meta",
      "subscriptions"
    ]);

    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const agent = migrated.prepare(`
        SELECT current_session_id, session_generation
        FROM agents
        WHERE principal_id = 'prn_019f0000-0000-7000-8000-000000000002'
      `).get() as {
        current_session_id: string;
        session_generation: number;
      };
      assert.equal(
        agent.current_session_id,
        "ses_019f0000-0000-7000-8000-000000000003"
      );
      assert.equal(agent.session_generation, 2);

      const event = migrated.prepare(`
        SELECT destination_snapshots_json
        FROM events
        WHERE event_id = 'evt_019f0000-0000-7000-8000-000000000010'
      `).get() as { destination_snapshots_json: string };
      assert.deepEqual(JSON.parse(event.destination_snapshots_json), [{
        destinationId: "dst_019f0000-0000-7000-8000-000000000020",
        kind: "macos-notification",
        address: { title: "Preserved destination" },
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:00:00.000Z"
      }]);

      const receipt = migrated.prepare(`
        SELECT receipt_json
        FROM executions
        WHERE event_id = 'evt_019f0000-0000-7000-8000-000000000010'
      `).get() as { receipt_json: string };
      const receiptValue = JSON.parse(receipt.receipt_json) as {
        schema: string;
        receipts: Array<{ agentId: string; outcome: string }>;
      };
      assert.equal(receiptValue.schema, "ChatAttentionReceiptList@1");
      assert.deepEqual(
        receiptValue.receipts.map(({ agentId, outcome }) => ({ agentId, outcome })),
        [{
          agentId: "prn_019f0000-0000-7000-8000-000000000002",
          outcome: "skipped"
        }]
      );

      const notice = migrated.prepare(`
        SELECT title, read_at, acknowledged_at
        FROM notices
        WHERE notice_id = 'ntc1_del_019f0000-0000-7000-8000-000000000030'
      `).get() as {
        title: string;
        read_at: string;
        acknowledged_at: string | null;
      };
      assert.equal(notice.title, "Preserved destination");
      assert.equal(notice.read_at, "2026-07-25T00:03:00.000Z");
      assert.equal(notice.acknowledged_at, null);

      assert.deepEqual(
        migrated.prepare("PRAGMA foreign_key_check").all(),
        []
      );
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v43 preserves already compacted tables still declared as v42", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v43-hybrid-"));
  const databasePath = join(directory, "runtime.db");
  try {
    const legacy = new DatabaseSync(databasePath);
    createV42Fixture(legacy);
    legacy.close();
    initializeRuntimeSchema(databasePath);

    const hybrid = new DatabaseSync(databasePath);
    hybrid.exec(`
      UPDATE schema_meta SET value = '42' WHERE key = 'schema_version';
      CREATE TABLE local_principals (
        principal_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        handle TEXT NOT NULL,
        handle_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE local_agent_profiles (
        principal_id TEXT PRIMARY KEY,
        agent_client TEXT NOT NULL,
        execution_config TEXT NOT NULL
      );
    `);
    hybrid.close();

    const diagnostics = initializeRuntimeSchema(databasePath);
    assert.equal(diagnostics.schemaVersion, 43);
    assert.equal(diagnostics.tables.length, 13);

    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(count(migrated, "local_foundation"), 1);
      assert.equal(count(migrated, "agents"), 1);
      assert.equal(count(migrated, "agent_sessions"), 1);
      assert.equal(count(migrated, "events"), 2);
      assert.equal(count(migrated, "executions"), 2);
      assert.equal(count(migrated, "deliveries"), 1);
      assert.equal(count(migrated, "notices"), 1);
      assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v43 fails closed for newer or incomplete declared schemas", () => {
  for (const [version, expected] of [
    ["44", /newer than supported 43/],
    ["43", /schema 43 is incomplete/]
  ] as const) {
    const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-version-"));
    const databasePath = join(directory, "runtime.db");
    try {
      const database = new DatabaseSync(databasePath);
      database.exec(`
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO schema_meta VALUES ('schema_version', '${version}');
      `);
      database.close();
      assert.throws(() => initializeRuntimeSchema(databasePath), expected);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function count(database: DatabaseSync, table: string): number {
  return Number((database.prepare(
    `SELECT COUNT(*) AS count FROM "${table}"`
  ).get() as { count: number | bigint }).count);
}

function createV42Fixture(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta VALUES ('schema_version', '42');

    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      workspace TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO sessions VALUES (
      'ses_019f0000-0000-7000-8000-000000000003',
      'prn_019f0000-0000-7000-8000-000000000002',
      'codex-runtime-jsonl-v1',
      'provider-v42',
      '/tmp/workspace',
      '2026-07-25T00:00:00.000Z',
      '2026-07-25T00:01:00.000Z'
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
    INSERT INTO local_principals VALUES
      (
        'prn_019f0000-0000-7000-8000-000000000001',
        'owner',
        'owner',
        'owner',
        'active',
        '2026-07-25T00:00:00.000Z',
        '2026-07-25T00:00:00.000Z'
      ),
      (
        'prn_019f0000-0000-7000-8000-000000000002',
        'agent',
        'alice',
        'alice',
        'active',
        '2026-07-25T00:00:00.000Z',
        '2026-07-25T00:01:00.000Z'
      );
    CREATE TABLE local_agent_profiles (
      principal_id TEXT PRIMARY KEY,
      agent_client TEXT NOT NULL,
      execution_config TEXT NOT NULL
    );
    INSERT INTO local_agent_profiles VALUES (
      'prn_019f0000-0000-7000-8000-000000000002',
      'codex',
      '{"launchArgs":[]}'
    );
    CREATE TABLE local_agent_sessions (
      principal_id TEXT PRIMARY KEY,
      current_session_id TEXT,
      generation INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO local_agent_sessions VALUES (
      'prn_019f0000-0000-7000-8000-000000000002',
      'ses_019f0000-0000-7000-8000-000000000003',
      2,
      '2026-07-25T00:01:00.000Z'
    );
    CREATE TABLE local_foundation (
      singleton INTEGER PRIMARY KEY,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      topic_handle TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO local_foundation VALUES (
      1,
      'dev_019f0000-0000-7000-8000-000000000004',
      'fixture-device',
      '/tmp/workspace',
      'top_019f0000-0000-7000-8000-000000000005',
      'local',
      'prn_019f0000-0000-7000-8000-000000000001',
      '2026-07-25T00:00:00.000Z'
    );

    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
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
    INSERT INTO events VALUES
      (
        'evt_019f0000-0000-7000-8000-000000000010',
        'chat.message',
        'cli',
        NULL,
        'prn_019f0000-0000-7000-8000-000000000001',
        NULL,
        NULL,
        NULL,
        NULL,
        '{"topicId":"top_019f0000-0000-7000-8000-000000000005","sender":{"kind":"owner","principalId":"prn_019f0000-0000-7000-8000-000000000001","handleSnapshot":"owner"},"body":"hello"}',
        NULL,
        '["dst_019f0000-0000-7000-8000-000000000020"]',
        'evt_019f0000-0000-7000-8000-000000000010',
        NULL,
        0,
        '2026-07-25T00:00:00.000Z'
      ),
      (
        'evt_019f0000-0000-7000-8000-000000000011',
        'agent.result',
        'handler',
        'exe_019f0000-0000-7000-8000-000000000012',
        'prn_019f0000-0000-7000-8000-000000000002',
        NULL,
        'succeeded',
        'done',
        NULL,
        NULL,
        'ses_019f0000-0000-7000-8000-000000000003',
        '["dst_019f0000-0000-7000-8000-000000000020"]',
        'evt_019f0000-0000-7000-8000-000000000010',
        'evt_019f0000-0000-7000-8000-000000000010',
        1,
        '2026-07-25T00:01:00.000Z'
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
    INSERT INTO executions VALUES
      (
        'exe_019f0000-0000-7000-8000-000000000012',
        'evt_019f0000-0000-7000-8000-000000000010',
        'chat',
        'succeeded',
        1,
        3,
        '2026-07-25T00:00:00.000Z',
        NULL,
        '2026-07-25T00:00:00.000Z',
        '2026-07-25T00:00:00.000Z',
        '2026-07-25T00:00:01.000Z',
        '2026-07-25T00:00:01.000Z'
      ),
      (
        'exe_019f0000-0000-7000-8000-000000000013',
        'evt_019f0000-0000-7000-8000-000000000011',
        'result',
        'succeeded',
        1,
        3,
        '2026-07-25T00:01:00.000Z',
        NULL,
        '2026-07-25T00:01:00.000Z',
        '2026-07-25T00:01:00.000Z',
        '2026-07-25T00:01:01.000Z',
        '2026-07-25T00:01:01.000Z'
      );

    CREATE TABLE destinations (
      destination_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      address_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO destinations VALUES (
      'dst_019f0000-0000-7000-8000-000000000020',
      'macos-notification',
      '{"title":"Preserved destination"}',
      '2026-07-25T00:00:00.000Z',
      '2026-07-25T00:00:00.000Z'
    );
    CREATE TABLE deliveries (
      delivery_id TEXT PRIMARY KEY,
      result_event_id TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      next_attempt_at TEXT NOT NULL,
      receipt TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO deliveries VALUES (
      'del_019f0000-0000-7000-8000-000000000030',
      'evt_019f0000-0000-7000-8000-000000000011',
      'dst_019f0000-0000-7000-8000-000000000020',
      'delivered',
      1,
      1,
      '2026-07-25T00:02:00.000Z',
      'fixture',
      NULL,
      '2026-07-25T00:02:00.000Z',
      '2026-07-25T00:02:01.000Z'
    );

    CREATE TABLE chat_attention_receipts (
      source_message_event_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason TEXT NOT NULL,
      presence_snapshot_json TEXT NOT NULL,
      dispatch_event_id TEXT,
      prompt_resource_id TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(source_message_event_id, agent_id)
    );
    INSERT INTO chat_attention_receipts VALUES (
      'evt_019f0000-0000-7000-8000-000000000010',
      'prn_019f0000-0000-7000-8000-000000000002',
      'skipped',
      'topic-snoozed',
      '{"global":{"scope":"global","mode":"available","wakeKeywords":[]},"topic":{"scope":"topic","mode":"snoozed","until":"2026-07-25T01:00:00.000Z","wakeKeywords":[]}}',
      NULL,
      NULL,
      '2026-07-25T00:00:01.000Z'
    );

    CREATE TABLE notice_index (
      notice_id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      outcome TEXT NOT NULL,
      delivery_status TEXT NOT NULL,
      delivery_error TEXT,
      event_id TEXT NOT NULL,
      destination_id TEXT NOT NULL,
      subscription_id TEXT,
      occurred_at TEXT NOT NULL,
      delivered_at TEXT,
      projection_updated_at TEXT NOT NULL
    );
    INSERT INTO notice_index VALUES (
      'ntc1_del_019f0000-0000-7000-8000-000000000030',
      'delivery',
      'del_019f0000-0000-7000-8000-000000000030',
      'Preserved destination',
      'done',
      'succeeded',
      'delivered',
      NULL,
      'evt_019f0000-0000-7000-8000-000000000011',
      'dst_019f0000-0000-7000-8000-000000000020',
      NULL,
      '2026-07-25T00:01:00.000Z',
      '2026-07-25T00:02:01.000Z',
      '2026-07-25T00:02:01.000Z'
    );
    CREATE TABLE notice_states (
      notice_id TEXT PRIMARY KEY,
      read_at TEXT,
      acknowledged_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO notice_states VALUES (
      'ntc1_del_019f0000-0000-7000-8000-000000000030',
      '2026-07-25T00:03:00.000Z',
      NULL,
      '2026-07-25T00:03:00.000Z',
      '2026-07-25T00:03:00.000Z'
    );
  `);
}
