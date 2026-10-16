import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { chatDispatchTaskClaims, chatTaskClaims, existingChatTask } from "../src/application/chat/responsibility.js";
import { chatRunOriginSql, chatRunRequestId, chatRunTaskSourceMessageId, chatRunTaskSpan, chatTaskSpan } from "../src/application/chat/work-origin.js";

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE events (event_id TEXT PRIMARY KEY, type TEXT, agent_id TEXT, payload_json TEXT);
    CREATE TABLE agent_runs (run_id TEXT PRIMARY KEY, owner_request_id TEXT, status TEXT, created_at TEXT);
  `);
  const event = (id: string, type: string, payload: unknown) => database.prepare(
    "INSERT INTO events VALUES (?, ?, 'agent-a', ?)"
  ).run(id, type, JSON.stringify(payload));
  event("owner-original", "chat.message", {body: "检查 service-a；检查 rollerskate"});
  event("owner-reminder", "chat.message", {body: "我没看到提案"});
  event("dispatch-original", "chat.dispatch", {sourceMessageEventId: "owner-original"});
  event("dispatch-reminder", "chat.dispatch", {sourceMessageEventId: "owner-reminder"});
  // Event IDs containing underscores must still match literally, without SQL LIKE semantics.
  event("dispatch_reminder", "chat.dispatch", {sourceMessageEventId: "owner-reminder"});
  const run = (id: string, requestId: string) => database.prepare(
    "INSERT INTO agent_runs VALUES (?, ?, 'succeeded', '2026-09-15')"
  ).run(id, requestId);
  return {database, run};
}

test("independent task sources deduplicate against the original Owner while retaining the callback dispatch", () => {
  const {database, run} = fixture();
  try {
    const first = chatTaskSpan("检查 service-a；检查 rollerskate", "检查 service-a")!;
    const second = chatTaskSpan("检查 service-a；检查 rollerskate", "检查 rollerskate")!;
    const requestId = chatRunRequestId("owner-reminder", "dispatch-reminder", first, "owner-original");
    assert.equal(chatRunTaskSourceMessageId(requestId), "owner-original");
    assert.deepEqual(chatRunTaskSpan(requestId), first);
    run("run-a", requestId);
    run("run-b", chatRunRequestId("owner-reminder", "dispatch-reminder", second, "owner-original"));

    assert.deepEqual(chatTaskClaims(database, "owner-original").map(claim => claim.taskQuote), ["检查 service-a", "检查 rollerskate"]);
    assert.deepEqual(chatTaskClaims(database, "owner-reminder"), []);
    assert.equal(existingChatTask(database, "owner-original", {start: first.start + 1, end: first.end})?.runId, "run-a");
    assert.equal(existingChatTask(database, "owner-original", second)?.runId, "run-b");
    assert.equal(existingChatTask(database, "owner-original")?.runId, "run-a", "a whole-message task conflicts with scoped claims");
    const callbacks = chatDispatchTaskClaims(database, "dispatch-reminder");
    assert.equal(callbacks.length, 2);
    assert.ok(callbacks.every(claim => claim.taskSourceMessageEventId === "owner-original" && claim.dispatchEventId === "dispatch-reminder"));
    assert.deepEqual(chatDispatchTaskClaims(database, "dispatch-original"), []);
    assert.deepEqual(chatDispatchTaskClaims(database, "dispatch_reminder"), []);
    const resumable = database.prepare(`SELECT dispatch.event_id FROM agent_runs run
      JOIN events dispatch ON dispatch.type = 'chat.dispatch' AND ${chatRunOriginSql("dispatch", true)}
      WHERE run.run_id = 'run-a'`).all();
    assert.deepEqual(resumable.map(row => row.event_id), ["dispatch-reminder"]);
  } finally { database.close(); }
});

test("legacy whole-message and scoped task origins retain their identities and deduplication", () => {
  const {database, run} = fixture();
  try {
    const task = {start: 0, end: 9};
    const wholeId = chatRunRequestId("owner-original", "dispatch-original");
    const scopedId = chatRunRequestId("owner-original", "dispatch-original", task);
    assert.equal(wholeId, "chat-execute:owner-original:dispatch-original");
    assert.equal(scopedId, "chat-execute:owner-original:dispatch-original:task-v1:0:9");
    assert.equal(chatRunRequestId("owner-original", "dispatch-original", task, "owner-original"), scopedId);
    assert.equal(chatRunTaskSourceMessageId(scopedId), undefined);
    assert.throws(() => chatRunRequestId("owner-reminder", "dispatch-reminder", undefined, "owner-original"), /task span/);
    run("legacy", "chat-work:owner-original:dispatch-original");
    assert.equal(existingChatTask(database, "owner-original", task)?.runId, "legacy");
    assert.equal(chatDispatchTaskClaims(database, "dispatch-original")[0]?.taskSourceMessageEventId, "owner-original");
    const resumable = database.prepare(`SELECT run.run_id FROM agent_runs run
      JOIN events dispatch ON dispatch.type = 'chat.dispatch' AND ${chatRunOriginSql("dispatch", true)}`).all();
    assert.equal(resumable.length, 0, "legacy proposals do not acquire callback authority");
  } finally { database.close(); }
});

test("origin lookup uses the dispatch primary key and still rejects mismatched source authority", () => {
  const {database, run} = fixture();
  try {
    run("wrong-source", "chat-execute:owner-original:dispatch-reminder");
    run("wrong-prefix", "other:owner-reminder:dispatch-reminder");
    run("valid", chatRunRequestId("owner-reminder", "dispatch-reminder"));
    const query = `SELECT run.run_id FROM agent_runs run JOIN events dispatch
      ON dispatch.type = 'chat.dispatch' AND ${chatRunOriginSql("dispatch", true)}`;
    assert.deepEqual(database.prepare(query).all().map(row => row.run_id), ["valid"]);
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${query}`).all();
    assert.ok(plan.some(row => /SEARCH dispatch USING INDEX .*\(event_id=\?\)/u.test(String(row.detail))),
      "history growth must not multiply Runs by all dispatch payloads");
  } finally { database.close(); }
});
