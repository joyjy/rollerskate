import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RuntimeStore } from "../src/core/runtime/store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { createLegacySubscriptionCallbacks } from "./support/legacy-schema.js";

const AT = "2026-07-28T08:00:00.000Z";

test("current schema retires legacy Kimi sessions before the read-only adapter upgrade", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-kimi-session-upgrade-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare(`
        INSERT INTO agent_sessions (
          session_id, agent_id, adapter_id, provider_session_id, workspace,
          created_at, updated_at
        ) VALUES (?, ?, 'kimi-code-runtime-jsonl-v1', ?, ?, ?, ?)
      `).run("ses_legacy", "prn_kimi", "provider_legacy", directory, AT, AT);
      database.prepare(`
        INSERT INTO agents (
          principal_id, handle, handle_key, status, agent_client, execution_config,
          current_session_id, created_at, updated_at
        ) VALUES (?, 'kimi', 'kimi', 'active', 'kimi-code', '{"launchArgs":[]}', ?, ?, ?)
      `).run("prn_kimi", "ses_legacy", AT, AT);
    } finally {
      database.close();
    }

    initializeRuntimeSchema(databasePath);
    const migrated = new DatabaseSync(databasePath);
    try {
      assert.equal((migrated.prepare(`
        SELECT current_session_id FROM agents WHERE principal_id = 'prn_kimi'
      `).get() as { current_session_id: string | null }).current_session_id, null);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime startup reconciliation rotates an incompatible current Agent Session", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-agent-session-reconcile-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare(`
        INSERT INTO agent_sessions (
          session_id, agent_id, adapter_id, provider_session_id, workspace,
          created_at, updated_at
        ) VALUES (?, ?, 'kimi-code-runtime-jsonl-v2', ?, ?, ?, ?)
      `).run("ses_previous", "prn_kimi", "provider_previous", directory, AT, AT);
      database.prepare(`
        INSERT INTO agents (
          principal_id, handle, handle_key, status, agent_client, execution_config,
          current_session_id, created_at, updated_at
        ) VALUES (?, 'kimi', 'kimi', 'active', 'kimi-code', '{"launchArgs":[]}', ?, ?, ?)
      `).run("prn_kimi", "ses_previous", AT, AT);
    } finally {
      database.close();
    }

    const runtime = new RuntimeStore(databasePath);
    try {
      assert.equal(runtime.reconcileCurrentLocalAgentSession(
        "prn_kimi",
        "kimi-code-runtime-jsonl-v3:digest",
        directory,
        "2026-07-28T08:01:00.000Z"
      ), true);
      assert.equal(runtime.currentLocalAgentSession("prn_kimi"), undefined);
      const reconciled = new DatabaseSync(databasePath);
      try {
        assert.equal((reconciled.prepare(`
          SELECT session_generation FROM agents WHERE principal_id = 'prn_kimi'
        `).get() as { session_generation: number }).session_generation, 2);
      } finally {
        reconciled.close();
      }
    } finally {
      runtime.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("schema v63 preserves v48 Delivery state and admits server-topic destinations", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v49-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const legacy = new DatabaseSync(databasePath);
    try {
      createLegacySubscriptionCallbacks(legacy);
      legacy.prepare(`
        INSERT INTO deliveries (
          delivery_id, result_event_id, origin_kind, origin_id, destination_id,
          destination_kind, destination_address_json, payload_json, status,
          attempt_count, max_attempts, next_attempt_at, receipt, last_error,
          created_at, updated_at
        ) VALUES (?, NULL, 'host', ?, ?, 'matrix', ?, ?, 'retry_wait',
          2, 5, ?, NULL, 'network', ?, ?)
      `).run(
        "del_019f0000-0000-7000-8000-000000000001",
        "reply-a",
        "dst_019f0000-0000-7000-8000-000000000002",
        JSON.stringify({ roomId: "room-a" }),
        JSON.stringify({ body: "preserve me" }),
        AT,
        AT,
        AT
      );
      legacy.prepare(`UPDATE schema_meta SET value = '48' WHERE key = 'schema_version'`).run();
    } finally {
      legacy.close();
    }

    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 63);
    const migrated = new DatabaseSync(databasePath);
    try {
      assert.deepEqual({ ...migrated.prepare(`
        SELECT origin_kind, origin_id, destination_kind, payload_json, status,
          attempt_count, max_attempts, last_error
        FROM deliveries WHERE delivery_id = ?
      `).get("del_019f0000-0000-7000-8000-000000000001") }, {
        origin_kind: "host",
        origin_id: "reply-a",
        destination_kind: "matrix",
        payload_json: JSON.stringify({ body: "preserve me" }),
        status: "retry_wait",
        attempt_count: 2,
        max_attempts: 5,
        last_error: "network"
      });
      assert.doesNotThrow(() => migrated.prepare(`
        INSERT INTO deliveries (
          delivery_id, result_event_id, origin_kind, origin_id, destination_id,
          destination_kind, destination_address_json, payload_json, status,
          attempt_count, max_attempts, next_attempt_at, created_at, updated_at
        ) VALUES (?, NULL, 'host', ?, ?, 'server-topic', ?, ?, 'pending',
          0, 5, ?, ?, ?)
      `).run(
        "del_019f0000-0000-7000-8000-000000000003",
        "reply-b",
        "dst_019f0000-0000-7000-8000-000000000004",
        JSON.stringify({ topicId: "topic-a", agentId: "agent-a" }),
        JSON.stringify({ body: "publish me" }),
        AT,
        AT,
        AT
      ));
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
