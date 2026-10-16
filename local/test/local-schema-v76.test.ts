import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  migrateLocalDatabase,
  rebuildChatMessageProjection
} from "../src/infrastructure/sqlite/schema/index.js";
import { writeSchemaVersion } from "../src/infrastructure/sqlite/schema/introspection.js";

test("schema v76 adds empty Chat rotation state without replaying Chat history", () => {
  const database = new DatabaseSync(":memory:");
  try {
    migrateLocalDatabase(database);
    seedSharedDispatchReceipts(database);
    database.exec("DROP TABLE chat_rotations");
    writeSchemaVersion(database, 75);

    migrateLocalDatabase(database);

    assert.equal(schemaVersion(database), "80");
    assert.equal(count(database, "chat_rotations"), 0);
    assert.equal(count(database, "events"), 3);
    assert.throws(() => database.prepare(`
      INSERT INTO chat_rotations (topic_id, state_json, updated_at)
      VALUES ('topic-1', 'not-json', '2026-09-15T00:00:00.000Z')
    `).run(), /CHECK constraint failed/);
    assert.throws(() => database.prepare(`
      INSERT INTO chat_rotations (topic_id, state_json, updated_at)
      VALUES ('topic-oversize', ?, '2026-09-15T00:00:00.000Z')
    `).run(`"${"x".repeat(262143)}"`), /CHECK constraint failed/);
    database.prepare(`
      INSERT INTO chat_rotations (topic_id, state_json, updated_at)
      VALUES (?, ?, ?)
    `).run(
      "topic-1",
      JSON.stringify({
        sourceEventId: "message-1",
        state: "waiting",
        dispatchEventId: "dispatch-1",
        ownerEventIds: ["message-1", "message-2"]
      }),
      "2026-09-15T00:00:00.000Z"
    );

    rebuildChatMessageProjection(database);
    assert.equal(count(database, "chat_rotations"), 1);
  } finally {
    database.close();
  }
});

test("schema v76 dispatch progress refreshes every message that references the dispatch", () => {
  const database = new DatabaseSync(":memory:");
  try {
    migrateLocalDatabase(database);
    seedSharedDispatchReceipts(database);

    database.prepare(`
      UPDATE executions
      SET status = 'succeeded', updated_at = '2026-09-15T00:00:01.000Z'
      WHERE event_id = 'dispatch-1'
    `).run();

    for (const eventId of ["message-1", "message-2"]) {
      const progress = JSON.parse((database.prepare(`
        SELECT read_progress_json FROM chat_messages WHERE event_id = ?
      `).get(eventId) as { read_progress_json: string }).read_progress_json) as {
        read: number;
        agents: Array<{ state: string }>;
      };
      assert.equal(progress.read, 1);
      assert.equal(progress.agents.at(0)?.state, "read");
    }
  } finally {
    database.close();
  }
});

function seedSharedDispatchReceipts(database: DatabaseSync): void {
  for (const eventId of ["message-1", "message-2"]) {
    database.prepare(`
      INSERT INTO events (
        event_id, type, source_kind, payload_json, destination_ids_json,
        destination_snapshots_json, root_event_id, causal_hop, created_at
      ) VALUES (?, 'chat.message', 'cli', ?, '[]', '[]', ?, 0, '2026-09-15T00:00:00.000Z')
    `).run(eventId, JSON.stringify({
      topicId: "topic-1",
      sender: { kind: "owner", handleSnapshot: "Owner" },
      body: eventId,
      target: null
    }), eventId);
    database.prepare(`
      UPDATE chat_messages
      SET attention_json = ?
      WHERE event_id = ?
    `).run(JSON.stringify({
      schema: "ChatAttentionReceiptList@1",
      receipts: [{
        sourceMessageEventId: eventId,
        agentId: "agent-1",
        handleSnapshot: "Agent 1",
        outcome: "dispatched",
        reason: "direct-mention",
        presenceSnapshot: {
          global: { scope: "global", mode: "available", wakeKeywords: [] },
          topic: { scope: "topic", mode: "available", wakeKeywords: [] }
        },
        dispatchEventId: "dispatch-1",
        createdAt: "2026-09-15T00:00:00.000Z"
      }]
    }), eventId);
  }
  database.prepare(`
    INSERT INTO events (
      event_id, type, source_kind, agent_id, prompt, payload_json,
      destination_ids_json, destination_snapshots_json, root_event_id,
      parent_event_id, causal_hop, created_at
    ) VALUES (
      'dispatch-1', 'chat.dispatch', 'handler', 'agent-1', 'reply',
      '{"sourceMessageEventId":"message-1"}', '[]', '[]', 'message-1',
      'message-1', 1, '2026-09-15T00:00:00.000Z'
    )
  `).run();
  database.prepare(`
    INSERT INTO executions (
      execution_id, event_id, handler, status, attempt_count, max_attempts,
      next_attempt_at, created_at, updated_at
    ) VALUES (
      'execution-1', 'dispatch-1', 'agent', 'queued', 0, 1,
      '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z',
      '2026-09-15T00:00:00.000Z'
    )
  `).run();
}

function count(database: DatabaseSync, table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number | bigint;
  }).count);
}

function schemaVersion(database: DatabaseSync): string {
  return (database.prepare(`
    SELECT value FROM schema_meta WHERE key = 'schema_version'
  `).get() as { value: string }).value;
}
