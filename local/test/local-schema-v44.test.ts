import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

const PRODUCT_TABLES = [
  "agent_run_cycles",
  "agent_run_decisions",
  "agent_runs",
  "agent_sessions",
  "agents",
  "channel_follows",
  "channel_send_receipts",
  "chat_messages",
  "chat_presence",
  "continuous_subscriptions",
  "deliveries",
  "events",
  "executions",
  "free_chat_mode_receipts",
  "free_chat_modes",
  "interactive_channel_bindings",
  "local_foundation",
  "notices",
  "proactive_callback_definitions",
  "proactive_callback_occurrences",
  "scheduled_runs",
  "schedules",
  "schema_meta",
  "subscriptions",
  "topic_activation_schedule_receipts",
  "topic_activation_schedules",
  "topic_governance",
  "topic_governance_control_receipts"
] as const;

test("schema v63 creates the single post-v0.3.11 schema without legacy Review", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v50-"));
  const databasePath = join(directory, "runtime.db");
  try {
    const diagnostics = initializeRuntimeSchema(databasePath);
    assert.equal(diagnostics.schemaVersion, 63);
    assert.deepEqual(diagnostics.tables, PRODUCT_TABLES);

    const database = new DatabaseSync(databasePath);
    try {
      assert.throws(() => database.prepare(`
        INSERT INTO events (
          event_id, type, source_kind, destination_ids_json,
          destination_snapshots_json, root_event_id, causal_hop, created_at
        ) VALUES (
          'evt_019f0000-0000-7000-8000-000000000001', 'review.requested',
          'cli', '[]', '[]', 'evt_019f0000-0000-7000-8000-000000000001', 0,
          '2026-07-30T00:00:00.000Z'
        )
      `).run(), /CHECK constraint failed/);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v63 upgrades a complete v52 database", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v52-"));
  const databasePath = join(directory, "runtime.db");
  try {
    const foundation = bootstrapLocalFoundation(
      runtimePaths(directory, directory),
      "2026-07-31T08:00:00.000Z"
    );
    const foundationStore = new LocalFoundationStore(databasePath);
    const agent = foundationStore.addAgent(
      "alice",
      "codex",
      "2026-07-31T08:00:01.000Z"
    );
    foundationStore.close();
    const database = new DatabaseSync(databasePath);
    database.prepare(
      "UPDATE schema_meta SET value = '52' WHERE key = 'schema_version'"
    ).run();
    database.close();
    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 63);
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = migrated.prepare(`
        SELECT participants_json, revision
        FROM topic_governance
        WHERE topic_id = ?
      `).get(foundation.topicId) as {
        participants_json: string;
        revision: number;
      };
      assert.equal(row.revision, 1);
      const participants = JSON.parse(row.participants_json) as [{
        agentId: string;
        status: string;
        joinedAt: string;
        governanceRevision: number;
      }];
      assert.equal(participants[0].agentId, agent.principalId);
      assert.equal(participants[0].status, "active");
      assert.match(participants[0].joinedAt, /^20/);
      assert.equal(participants[0].governanceRevision, 1);
      assert.equal(count(migrated, "topic_governance_control_receipts"), 1);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v63 rejects pre-v44 product data without modifying it", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-pre-v44-"));
  const databasePath = join(directory, "runtime.db");
  try {
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta VALUES ('schema_version', '43');
      CREATE TABLE deliveries (delivery_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO deliveries VALUES ('legacy-delivery', 'preserve-on-rejection');
    `);
    database.close();

    assert.throws(
      () => initializeRuntimeSchema(databasePath),
      /schema 43 cannot migrate directly to 63/
    );
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.deepEqual(
        { ...preserved.prepare("SELECT * FROM deliveries").get() },
        { delivery_id: "legacy-delivery", payload: "preserve-on-rejection" }
      );
    } finally {
      preserved.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v63 drops an entire legacy Review Event chain from v44", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v44-review-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      DROP TRIGGER IF EXISTS chat_message_project_event_insert;
      DROP TRIGGER IF EXISTS chat_message_project_read_progress_attention;
      DROP TRIGGER IF EXISTS chat_message_project_read_progress_dispatch;
      DROP VIEW IF EXISTS chat_message_read_progress_v1;
      ALTER TABLE events RENAME TO events_v50;
      ALTER TABLE executions RENAME TO executions_v50;
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
        destination_snapshots_json TEXT NOT NULL,
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
        receipt_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO events VALUES (
        'evt_review_root', 'review.requested', 'cli', 'legacy-review',
        NULL, NULL, NULL, NULL, NULL, '{}', NULL, '[]', '[]',
        'evt_review_root', NULL, 0, '2026-07-30T00:00:00.000Z'
      );
      INSERT INTO events VALUES (
        'evt_review_child', 'agent.request', 'handler', 'legacy-review-child',
        'prn_review_agent', 'review', NULL, NULL, NULL, '{}', NULL, '[]', '[]',
        'evt_review_root', 'evt_review_root', 1, '2026-07-30T00:00:01.000Z'
      );
      INSERT INTO executions VALUES (
        'exe_review_root', 'evt_review_root', 'review', 'succeeded', 1, 3,
        '2026-07-30T00:00:00.000Z', NULL, NULL,
        '2026-07-30T00:00:00.000Z', '2026-07-30T00:00:00.000Z',
        '2026-07-30T00:00:01.000Z', '2026-07-30T00:00:01.000Z'
      );
      INSERT INTO executions VALUES (
        'exe_review_child', 'evt_review_child', 'agent', 'succeeded', 1, 3,
        '2026-07-30T00:00:01.000Z', NULL, NULL,
        '2026-07-30T00:00:01.000Z', '2026-07-30T00:00:01.000Z',
        '2026-07-30T00:00:02.000Z', '2026-07-30T00:00:02.000Z'
      );
      CREATE TABLE reviews (root_event_id TEXT PRIMARY KEY, phase TEXT NOT NULL);
      INSERT INTO reviews VALUES ('evt_review_root', 'terminal');
      DROP TABLE events_v50;
      DROP TABLE executions_v50;
      DROP TABLE IF EXISTS subscription_callbacks;
      DROP TABLE continuous_subscriptions;
      DROP TABLE proactive_callback_occurrences;
      DROP TABLE proactive_callback_definitions;
      UPDATE schema_meta SET value = '44' WHERE key = 'schema_version';
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    database.close();

    const diagnostics = initializeRuntimeSchema(databasePath);
    assert.equal(diagnostics.schemaVersion, 63);
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(count(migrated, "events"), 0);
      assert.equal(count(migrated, "executions"), 0);
      assert.ok(!diagnostics.tables.includes("reviews"));
      assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v63 upgrades v56 with optional ExternalRef trigger bindings", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v56-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const previous = new DatabaseSync(databasePath);
    for (const table of ["schedules", "subscriptions", "continuous_subscriptions"]) {
      previous.exec(`ALTER TABLE ${table} DROP COLUMN external_ref_binding_json`);
    }
    previous.prepare(
      "UPDATE schema_meta SET value = '56' WHERE key = 'schema_version'"
    ).run();
    previous.close();

    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 63);
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      for (const table of ["schedules", "subscriptions", "continuous_subscriptions"]) {
        const columns = (migrated.prepare(`PRAGMA table_info(${table})`).all() as unknown as
          Array<{ name: string }>).map(({ name }) => name);
        assert.ok(columns.includes("external_ref_binding_json"));
      }
      assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v63 upgrades v57 without introducing business tables", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v57-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const previous = new DatabaseSync(databasePath);
    previous.prepare(
      "UPDATE schema_meta SET value = '57' WHERE key = 'schema_version'"
    ).run();
    previous.close();

    const diagnostics = initializeRuntimeSchema(databasePath);
    assert.equal(diagnostics.schemaVersion, 63);
    assert.deepEqual(diagnostics.tables, PRODUCT_TABLES);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v63 preserves legacy v58 Candidate tables without extending them", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v58-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const previous = new DatabaseSync(databasePath);
    previous.exec(`
      CREATE TABLE release_candidate_runtime (
        singleton INTEGER PRIMARY KEY,
        lark_cursor INTEGER NOT NULL,
        bootstrap_until_cursor INTEGER,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE release_candidates (
        candidate_id TEXT PRIMARY KEY,
        marker TEXT NOT NULL
      );
      CREATE TABLE release_candidate_messages (
        message_id TEXT PRIMARY KEY,
        marker TEXT NOT NULL
      );
      INSERT INTO release_candidate_runtime VALUES (
        1, 164273, 164273, '2026-08-13T00:00:00.000Z'
      );
      INSERT INTO release_candidates VALUES ('candidate-legacy', 'preserve');
      UPDATE schema_meta SET value = '58' WHERE key = 'schema_version';
    `);
    previous.close();

    const diagnostics = initializeRuntimeSchema(databasePath);
    assert.equal(diagnostics.schemaVersion, 63);
    assert.deepEqual(
      diagnostics.tables.filter((table) => !table.startsWith("release_candidate")),
      PRODUCT_TABLES
    );
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(count(preserved, "release_candidates"), 1);
      assert.ok(!diagnostics.tables.includes("release_candidate_effects"));
    } finally {
      preserved.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v63 tolerates complete legacy Candidate tombstones", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v60-legacy-candidate-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE release_candidate_runtime (
        singleton INTEGER PRIMARY KEY,
        lark_cursor INTEGER NOT NULL,
        bootstrap_until_cursor INTEGER,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE release_candidates (candidate_id TEXT PRIMARY KEY);
      CREATE TABLE release_candidate_messages (message_id TEXT PRIMARY KEY);
      CREATE TABLE release_candidate_effects (effect_id TEXT PRIMARY KEY);
      INSERT INTO release_candidate_runtime VALUES (
        1, 164273, 164273, '2026-08-13T00:00:00.000Z'
      );
      INSERT INTO release_candidates VALUES ('candidate-legacy');
    `);
    database.close();

    const diagnostics = initializeRuntimeSchema(databasePath);
    assert.equal(diagnostics.schemaVersion, 63);
    const preserved = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(count(preserved, "release_candidates"), 1);
    } finally {
      preserved.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v63 fails closed for newer and incomplete current schemas", () => {
  for (const [version, expected] of [
    ["64", /newer than supported 63/],
    ["63", /schema 63 is incomplete/]
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
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
    count: number | bigint;
  }).count);
}
