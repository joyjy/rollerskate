import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runMonitorChatNoticeStates } from
  "../src/application/chat/run-monitor-return.js";
import { RuntimeStore } from "../src/core/runtime/store.js";

const SUBSCRIPTION_ID = "sub_run_0123456789abcdef0123456789abcdef";

test("a completed responsible turn with silent speech remains blocked", () => {
  const fixture = setup();
  try {
    insertNotice(fixture.database, "silent", { speechAction: "silent" });
    assert.deepEqual(states(fixture), [
      { status: "blocked", count: 1, reason: "return_produced_no_visible_reply" }
    ]);
  } finally { fixture.close(); }
});

test("a visible reply with failed host Delivery is a failed return", () => {
  const fixture = setup();
  try {
    insertNotice(fixture.database, "reply-failed", {
      speechAction: "reply", replyDeliveryStatus: "failed"
    });
    assert.deepEqual(states(fixture), [
      { status: "failed", count: 1, reason: "responsible_return_failed" }
    ]);
  } finally { fixture.close(); }
});

test("a failed early return remains visible after more than 100 later successful turns", () => {
  const fixture = setup();
  try {
    insertNotice(fixture.database, "000-early-failure", {
      speechAction: "reply", replyDeliveryStatus: "failed"
    });
    fixture.database.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 1; index <= 120; index += 1) {
        insertNotice(fixture.database, String(index).padStart(3, "0"), {
          speechAction: "reply", replyDeliveryStatus: "delivered"
        });
      }
      fixture.database.exec("COMMIT");
    } catch (error) {
      fixture.database.exec("ROLLBACK");
      throw error;
    }
    const result = states(fixture);
    assert.deepEqual(result.find(({ status }) => status === "failed"),
      { status: "failed", count: 1, reason: "responsible_return_failed" });
    assert.deepEqual(result.find(({ status }) => status === "turn_completed"),
      { status: "turn_completed", count: 120, reason: null });
  } finally { fixture.close(); }
});

function setup() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT,
      source_kind TEXT, source_external_id TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE executions (event_id TEXT PRIMARY KEY, status TEXT NOT NULL, receipt_json TEXT);
    CREATE TABLE deliveries (origin_id TEXT NOT NULL, status TEXT NOT NULL);
  `);
  const runtime = new RuntimeStore(database, { migrate: false });
  return {database, runtime, close() {runtime.close(); database.close();}};
}

function states(fixture: ReturnType<typeof setup>) {
  return runMonitorChatNoticeStates(fixture.database, fixture.runtime,
    "dispatch-for-original-owner-session", SUBSCRIPTION_ID)
    .map(({ status, count, reason }) => ({ status, count, reason }));
}

function insertNotice(database: DatabaseSync, suffix: string, input: {
  speechAction: "silent" | "reply";
  replyDeliveryStatus?: "delivered" | "failed";
}) {
  const activationId = `activation-${suffix}`;
  const childId = `child-${suffix}`;
  const replyId = `reply-${suffix}`;
  database.prepare(`INSERT INTO events
    (event_id, type, source_kind, source_external_id, created_at)
    VALUES (?, 'chat.activation', 'handler', ?, ?)`)
    .run(activationId, `chat-activation:run-subscription:${SUBSCRIPTION_ID}:state:${suffix}`,
      `2026-10-16T03:${suffix === "000-early-failure" ? "00" : "01"}:00.000Z`);
  database.prepare("INSERT INTO executions (event_id, status) VALUES (?, 'succeeded')")
    .run(activationId);
  database.prepare(`INSERT INTO events
    (event_id, type, payload_json, created_at)
    VALUES (?, 'chat.dispatch', ?, '2026-10-16T03:02:00.000Z')`)
    .run(childId, JSON.stringify({sourceAttentionEventId:activationId}));
  database.prepare(`INSERT INTO executions (event_id, status, receipt_json)
    VALUES (?, 'succeeded', ?)`)
    .run(childId, JSON.stringify({speechAction:input.speechAction,
      ...(input.speechAction === "reply" ? {replyEventId:replyId} : {})}));
  if (input.speechAction === "reply") {
    database.prepare(`INSERT INTO events (event_id, type, created_at)
      VALUES (?, 'chat.message', '2026-10-16T03:03:00.000Z')`).run(replyId);
    if (input.replyDeliveryStatus !== undefined) {
      database.prepare("INSERT INTO deliveries (origin_id, status) VALUES (?, ?)")
        .run(replyId, input.replyDeliveryStatus);
    }
  }
}
