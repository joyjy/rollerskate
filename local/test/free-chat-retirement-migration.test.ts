import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("schema v72 retires synthetic Chat state exactly once without deleting history", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-free-chat-retirement-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const database = new DatabaseSync(databasePath);
    const at = "2026-09-02T00:00:00.000Z";
    database.exec("PRAGMA foreign_keys = ON");
    database.prepare(`
      INSERT INTO topic_governance (
        topic_id, status, participants_json, strategy_policy_json,
        conversation_policy_json, revision, created_at, updated_at
      ) VALUES (?, 'active', '[]', ?, ?, 1, ?, ?)
    `).run(
      "topic-retirement",
      JSON.stringify({ participantMessageEnabled: true, scheduledEnabled: true }),
      JSON.stringify({ defaultIntent: "continue_recent", themes: [] }),
      at,
      at
    );
    database.prepare(`
      INSERT INTO free_chat_modes (
        mode_id, topic_id, status, revision, state_json, created_at, updated_at
      ) VALUES (?, 'topic-retirement', ?, ?, ?, ?, ?)
    `).run(
      "mode-active",
      "active",
      1,
      JSON.stringify({
        modeId: "mode-active",
        topicId: "topic-retirement",
        status: "active",
        cycleIndex: 3,
        revision: 1,
        marker: "preserve-me"
      }),
      at,
      at
    );
    database.prepare(`
      INSERT INTO free_chat_modes (
        mode_id, topic_id, status, revision, state_json, created_at, updated_at
      ) VALUES (?, 'topic-retirement', 'stopped', 4, ?, ?, ?)
    `).run(
      "mode-historical",
      JSON.stringify({
        modeId: "mode-historical",
        topicId: "topic-retirement",
        status: "stopped",
        cycleIndex: 2,
        revision: 4,
        stopReason: "max_cycles"
      }),
      at,
      at
    );
    database.prepare(`
      INSERT INTO free_chat_mode_receipts (
        receipt_id, mode_id, topic_id, sequence, action, receipt_json, created_at
      ) VALUES (?, ?, 'topic-retirement', 1, 'started', '{}', ?)
    `).run("free-chat:mode-active:1", "mode-active", at);
    for (const event of [
      { id: "evt-manual", strategyId: "manual", externalId: "chat-activation:manual:1" },
      {
        id: "evt-free-chat",
        strategyId: "participant-message",
        externalId: "chat-activation:free-chat:mode-active:3"
      },
      { id: "evt-scheduled", strategyId: "scheduled", externalId: "chat-activation:schedule:1" }
    ]) {
      database.prepare(`
        INSERT INTO events (
          event_id, type, source_kind, source_external_id, payload_json,
          destination_ids_json, destination_snapshots_json, root_event_id,
          causal_hop, created_at
        ) VALUES (?, 'chat.activation', 'handler', ?, ?, '[]', '[]', ?, 0, ?)
      `).run(
        event.id,
        event.externalId,
        JSON.stringify({ topicId: "topic-retirement", strategyId: event.strategyId }),
        event.id,
        at
      );
      database.prepare(`
        INSERT INTO executions (
          execution_id, event_id, handler, status, attempt_count, max_attempts,
          next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, 'chat', ?, 0, 3, ?, ?, ?)
      `).run(
        `exe-${event.id}`,
        event.id,
        event.id === "evt-free-chat" ? "running" : "queued",
        at,
        at,
        at
      );
    }
    database.exec("UPDATE schema_meta SET value = '69' WHERE key = 'schema_version'");
    database.close();

    assert.equal(initializeRuntimeSchema(databasePath).schemaVersion, 72);
    const migrated = new DatabaseSync(databasePath);
    try {
      const mode = migrated.prepare(`
        SELECT status, revision, state_json FROM free_chat_modes WHERE mode_id = 'mode-active'
      `).get() as { status: string; revision: number; state_json: string };
      assert.equal(mode.status, "stopped");
      assert.equal(mode.revision, 2);
      assert.deepEqual(
        pick(JSON.parse(mode.state_json) as Record<string, unknown>, [
          "status", "stopReason", "revision", "marker"
        ]),
        {
          status: "stopped",
          stopReason: "feature_retired",
          revision: 2,
          marker: "preserve-me"
        }
      );
      const retirementReceipts = migrated.prepare(`
        SELECT receipt_json FROM free_chat_mode_receipts
        WHERE mode_id = 'mode-active' AND action = 'stopped'
      `).all() as unknown as Array<{ receipt_json: string }>;
      assert.equal(retirementReceipts.length, 1);
      assert.deepEqual(
        (JSON.parse(retirementReceipts[0]!.receipt_json) as { details: unknown }).details,
        { reason: "feature_retired" }
      );
      assert.deepEqual(executionStatuses(migrated), {
        "evt-free-chat": "cancelled",
        "evt-manual": "cancelled",
        "evt-scheduled": "queued"
      });
      const historical = migrated.prepare(`
        SELECT status, revision, state_json FROM free_chat_modes
        WHERE mode_id = 'mode-historical'
      `).get() as { status: string; revision: number; state_json: string };
      assert.equal(historical.status, "stopped");
      assert.equal(historical.revision, 4);
      assert.equal(
        (JSON.parse(historical.state_json) as { stopReason: string }).stopReason,
        "max_cycles"
      );
    } finally {
      migrated.close();
    }

    initializeRuntimeSchema(databasePath);
    const repeated = new DatabaseSync(databasePath);
    try {
      assert.equal(Number((repeated.prepare(`
        SELECT COUNT(*) AS count FROM free_chat_mode_receipts
        WHERE mode_id = 'mode-active' AND action = 'stopped'
      `).get() as { count: number | bigint }).count), 1);
      assert.equal((repeated.prepare(`
        SELECT revision FROM free_chat_modes WHERE mode_id = 'mode-active'
      `).get() as { revision: number }).revision, 2);
    } finally {
      repeated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function executionStatuses(database: DatabaseSync): Record<string, string> {
  return Object.fromEntries((database.prepare(`
    SELECT event_id, status FROM executions ORDER BY event_id
  `).all() as unknown as Array<{ event_id: string; status: string }>).map(
    ({ event_id, status }) => [event_id, status]
  ));
}

function pick(
  value: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
