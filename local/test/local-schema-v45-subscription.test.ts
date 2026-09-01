import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RuntimeStore } from "../src/core/runtime/store.js";
import { LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("schema v69 drops v44 SubscriptionDefinition@2 data and legacy Review", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-v52-from-v44-"));
  const databasePath = join(directory, "runtime.db");
  const legacySubscriptionId = "sub_019f0000-0000-7000-8000-000000000044";
  try {
    const foundation = new LocalFoundationStore(databasePath);
    const owner = foundation.addAgent("alice", "codex");
    foundation.close();
    const runtime = new RuntimeStore(databasePath);
    const seeded = runtime.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "v44-session" },
      agentId: owner.principalId,
      prompt: "seed",
      createdAt: "2026-07-27T00:00:00.000Z"
    });
    const claimed = runtime.claimDueExecutions(1, "2026-07-27T00:00:00.000Z")[0]!;
    const result = runtime.completeExecution(claimed.executionId, {
      adapterId: "codex-runtime-jsonl-v1",
      workspace: "/workspace",
      providerSessionId: "provider-v44",
      output: "seeded"
    }, "2026-07-27T00:00:01.000Z")!;
    const fire = runtime.appendEvent({
      type: "subscription.fire",
      source: { kind: "subscription", externalId: legacySubscriptionId },
      agentId: owner.principalId,
      prompt: "Continue the original task.",
      observation: {
        version: "v44",
        facts: { result: "done" },
        terminal: "success"
      },
      createdAt: "2026-07-27T00:01:00.000Z"
    });
    runtime.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      DROP TABLE proactive_callback_occurrences;
      DROP TABLE proactive_callback_definitions;
      DROP TABLE continuous_subscriptions;
      DROP TABLE IF EXISTS subscription_callbacks;
      DROP TABLE subscriptions;
      CREATE TABLE subscriptions (
        subscription_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        owner_agent_id TEXT NOT NULL REFERENCES agents(principal_id),
        plugin_path TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        plugin_schema_version INTEGER NOT NULL CHECK(plugin_schema_version = 1),
        plugin_config_json TEXT NOT NULL CHECK(json_valid(plugin_config_json)),
        policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
        interval_ms INTEGER NOT NULL,
        max_wait_ms INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        callback_provider_session_id TEXT NOT NULL,
        callback_adapter_id TEXT NOT NULL,
        callback_workspace TEXT NOT NULL,
        callback_session_id TEXT REFERENCES agent_sessions(session_id),
        callback_prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        next_poll_at TEXT NOT NULL,
        latest_error TEXT,
        fire_event_id TEXT UNIQUE REFERENCES events(event_id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE reviews (
        root_event_id TEXT PRIMARY KEY,
        phase TEXT NOT NULL
      );
      INSERT INTO reviews VALUES ('evt_legacy_review', 'terminal');
      UPDATE schema_meta SET value = '44' WHERE key = 'schema_version';
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    legacy.prepare(`
      INSERT INTO subscriptions (
        subscription_id, title, owner_agent_id, plugin_path, plugin_id,
        plugin_schema_version, plugin_config_json, policy_json, interval_ms,
        max_wait_ms, max_attempts, attempt_count, callback_provider_session_id,
        callback_adapter_id, callback_workspace, callback_session_id,
        callback_prompt, status, started_at, deadline_at, next_poll_at,
        latest_error, fire_event_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, '{}', '{}', 1000, 60000, 60, 0,
        ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      legacySubscriptionId,
      "Discarded v44 subscription",
      owner.principalId,
      "/workspace/probe.ts",
      "v44-probe",
      "provider-v44",
      "codex-runtime-jsonl-v1",
      "/workspace",
      result.sessionId!,
      "Continue the original task.",
      "2026-07-27T00:01:00.000Z",
      "2026-07-27T00:02:00.000Z",
      "2026-07-27T00:01:01.000Z",
      fire.event.eventId,
      "2026-07-27T00:01:00.000Z",
      "2026-07-27T00:01:00.000Z"
    );
    legacy.close();

    const diagnostics = initializeRuntimeSchema(databasePath);
    assert.equal(diagnostics.schemaVersion, 69);
    assert.equal(diagnostics.tables.length, 29);
    assert.ok(!diagnostics.tables.includes("reviews"));

    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(
        (migrated.prepare("SELECT COUNT(*) AS count FROM subscriptions").get() as {
          count: number;
        }).count,
        0
      );
      assert.throws(
        () => migrated.prepare("SELECT COUNT(*) FROM subscription_callbacks").get(),
        /no such table/
      );
      assert.ok(migrated.prepare(
        "SELECT 1 FROM events WHERE event_id = ?"
      ).get(seeded.event.eventId));
      assert.equal(migrated.prepare(
        "SELECT 1 FROM events WHERE root_event_id = ?"
      ).get(fire.event.eventId), undefined);
      assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
