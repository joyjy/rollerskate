import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { addLocalAgent } from "../src/application/agent/control.js";
import { postLocalChatMessage } from "../src/application/chat/control.js";
import { ChatHandler } from "../src/application/chat/handler.js";
import { ChatRotation } from "../src/application/chat/rotation.js";
import { loadChatMentionPromptResource, loadChatPromptResource,
  type ChatPromptContext, type ChatPromptTaskClaim } from "../src/application/chat/prompt.js";
import { chatMentionPromptResourceId } from "../src/core/chat/model.js";
import type { ChatDispatchEvent } from "../src/core/event/model.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";

function fixture(run: (f: ReturnType<typeof createFixture>) => void, withThirdAgent = false): void {
  const f = createFixture(withThirdAgent);
  try { run(f); } finally { f.close(); }
}

function createFixture(withThirdAgent = false) {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-chat-rotation-"));
  let openedDatabase: DatabaseSync | undefined;
  try {
  const repo = join(directory, "repo");
  const runtimeDirectory = join(directory, "runtime");
  mkdirSync(repo);
  const options = { runtimeDirectory };
  const alice = addLocalAgent(repo, "alice", "codex", options);
  const bob = addLocalAgent(repo, "bob", "codex", options);
  const carol = withThirdAgent ? addLocalAgent(repo, "carol", "codex", options) : undefined;
  const agents = [alice, bob, ...(carol === undefined ? [] : [carol])];
  const database = new DatabaseSync(join(runtimeDirectory, "runtime.db"));
  openedDatabase = database;
  const runtime = new RuntimeStore(database, { migrate: false });
  const chat = new LocalChatStore(database);
  let milliseconds = Date.parse("2026-09-16T00:00:00.000Z");
  const now = () => new Date(milliseconds += 100).toISOString();
  const shuffle = (ids: readonly string[]) => agents.map((agent) => agent.principalId)
    .filter((id) => ids.includes(id));
  const claims = new Map<string, readonly Omit<ChatPromptTaskClaim, "sourceMessageEventId">[]>();
  const claimQueries: string[] = [];
  const contexts: ChatPromptContext[] = [];
  const listTaskClaims = (messageId: string) => {
    claimQueries.push(messageId);
    return claims.get(messageId) ?? [];
  };
  const capture = (resource: ReturnType<typeof loadChatPromptResource>) => ({
    ...resource,
    render(context: ChatPromptContext) { contexts.push(context); return resource.render(context); }
  });
  const prompt = capture(loadChatPromptResource());
  const mentionPrompt = capture(loadChatMentionPromptResource());
  let rotation = new ChatRotation(database, runtime, shuffle);
  let handler = new ChatHandler({ store: runtime, chat, listAgents: () => agents,
    scheduler: rotation, listTaskClaims, prompt, mentionPrompt });
  function ingest() {
    const at = now();
    for (const execution of runtime.claimDueExecutions(100, at,
      ({due}) => due.filter((item) => item.handler === "chat"))) {
      handler.handle(execution, at);
    }
  }
  function advance() {
    const ids = rotation.advance(handler, now());
    assert.ok(ids.length <= 1, "one Topic admits at most one turn per advance");
    return ids.map((id) => {
      const event = runtime.event(id);
      assert.equal(event?.type, "chat.dispatch");
      return event as ChatDispatchEvent;
    });
  }
  function claim(dispatch: ChatDispatchEvent) {
    const execution = runtime.claimDueExecutions(1, now(), ({due}) =>
      due.filter((item) => item.eventId === dispatch.eventId))[0];
    assert.ok(execution, "dispatch is newly queued and claimable");
    return execution;
  }
  function finish(dispatch: ChatDispatchEvent, reply?: string) {
    const execution = runtime.executionForEvent(dispatch.eventId);
    assert.ok(execution);
    const active = execution.status === "running" ? execution : claim(dispatch);
    runtime.completeExecution(active.executionId, {
      adapterId: "fixture-rotation",
      workspace: join(runtimeDirectory, "workspace"),
      providerSessionId: `provider-${dispatch.agentId}`,
      chatDecision: {
        schema: dispatch.promptResourceId === chatMentionPromptResourceId
          ? "ChatMentionDecision@1" : "ChatDecision@1",
        speech: reply === undefined ? { action: "silent", reason: "Nothing new to add." }
          : { action: "reply", body: reply },
        presence: { scope: "topic", mode: "available", wakeKeywords: [] }
      }
    }, now());
  }
  return {
    alice, bob, carol, database, runtime, chat, now, ingest, advance, claim, finish,
    claims, claimQueries, contexts,
    post(body: string) {
      return postLocalChatMessage(repo, body, { ...options, now: () => new Date(now()) }).message;
    },
    reopen() {
      rotation = new ChatRotation(database, runtime, shuffle);
      handler = new ChatHandler({ store: runtime, chat, listAgents: () => agents,
        scheduler: rotation, listTaskClaims, prompt, mentionPrompt });
    },
    close() { runtime.close(); chat.close(); database.close(); rmSync(directory, {recursive: true, force: true}); }
  };
  } catch (error) {
    openedDatabase?.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

test("rotation merges an Owner burst into shared dispatches while both message rings advance", () => fixture((f) => {
  const first = f.post("First detail: use the green fixture.");
  const second = f.post("Second detail: verify the blue result.");
  f.ingest();
  const a = f.advance()[0]!;
  assert.equal(a.agentId, f.alice.principalId);
  assert.match(a.prompt, /First detail: use the green fixture/);
  assert.match(a.prompt, /Second detail: verify the blue result/);
  assert.deepEqual(f.advance(), []);
  for (const source of [first, second]) {
    assert.equal(f.runtime.chatAttentionReceipts(source.eventId)
      .find(({agentId}) => agentId === f.alice.principalId)?.dispatchEventId, a.eventId);
    assert.equal(f.chat.readProgressForMessages([source.eventId]).get(source.eventId)?.total, 2);
  }
  f.finish(a);
  for (const source of [first, second]) {
    assert.equal(f.chat.readProgressForMessages([source.eventId]).get(source.eventId)?.read, 1);
  }
  const b = f.advance()[0]!;
  assert.equal(b.agentId, f.bob.principalId);
  f.finish(b);
  assert.deepEqual(f.advance(), []);
  for (const source of [first, second]) {
    assert.equal(f.runtime.chatAttentionReceipts(source.eventId)
      .find(({agentId}) => agentId === f.bob.principalId)?.dispatchEventId, b.eventId);
    assert.equal(f.chat.readProgressForMessages([source.eventId]).get(source.eventId)?.read, 2);
  }
  f.chat.rebuildProjection();
  assert.deepEqual([first, second].map((source) =>
    f.chat.readProgressForMessages([source.eventId]).get(source.eventId)?.read), [2, 2]);
}));

test("an Owner supplement while Alice runs survives her older silent completion", () => fixture((f) => {
  f.post("Original request."); f.ingest();
  const a = f.advance()[0]!;
  f.claim(a);
  const supplement = f.post("New constraint arrived while Alice was running."); f.ingest();
  assert.deepEqual(f.advance(), []);
  f.finish(a);
  const b = f.advance()[0]!;
  assert.equal(b.agentId, f.bob.principalId);
  assert.match(b.prompt, /New constraint arrived/);
  f.finish(b);
  const againA = f.advance()[0]!;
  assert.equal(againA.agentId, f.alice.principalId);
  assert.notEqual(againA.eventId, a.eventId);
  assert.match(againA.prompt, /New constraint arrived/);
  f.finish(againA);
  assert.deepEqual(f.advance(), []);
  assert.equal(f.chat.readProgressForMessages([supplement.eventId]).get(supplement.eventId)?.read, 2);
}));

test("a reply reaches the next Agent without waking its speaker again", () => fixture((f) => {
  f.post("Discuss this fixture."); f.ingest();
  const a = f.advance()[0]!;
  f.finish(a, "Alice found a distinct fact for Bob.");
  assert.deepEqual(f.advance(), [], "queued reply ingress must be consumed before another turn");
  f.ingest();
  const b = f.advance()[0]!;
  assert.equal(b.agentId, f.bob.principalId);
  assert.match(b.prompt, /Alice found a distinct fact for Bob/);
  f.finish(b);
  assert.deepEqual(f.advance(), []);
}));

test("Alice revisits an unseen Owner supplement even when her own reply is the latest source", () => fixture((f) => {
  f.post("Original context."); f.ingest();
  const a = f.advance()[0]!; f.claim(a);
  const supplement = f.post("Supplement must reach Alice in a later turn."); f.ingest();
  f.finish(a, "Alice replied from the original context."); f.ingest();
  const b = f.advance()[0]!; f.finish(b);
  const againA = f.advance()[0]!;
  assert.equal(againA.agentId, f.alice.principalId);
  assert.match(againA.prompt, /Supplement must reach Alice/);
  assert.equal(f.runtime.event(againA.sourceAttentionEventId)?.type, "chat.message");
  f.finish(againA);
  assert.deepEqual(f.advance(), []);
  assert.equal(f.chat.readProgressForMessages([supplement.eventId]).get(supplement.eventId)?.read, 2);
}));

test("reconstructing the rotation retains queued and running dispatch identity", () => fixture((f) => {
  f.post("Restart-safe discussion."); f.ingest();
  const a = f.advance()[0]!;
  f.reopen(); assert.deepEqual(f.advance(), []);
  f.claim(a); f.reopen(); assert.deepEqual(f.advance(), []);
  f.finish(a);
  const b = f.advance()[0]!;
  assert.equal(b.agentId, f.bob.principalId);
  f.finish(b); f.reopen(); assert.deepEqual(f.advance(), []);
}));

test("exhausting the discussion budget creates one visible notice and no ninth invocation", () => fixture((f) => {
  const source = f.post("Keep contributing while there is budget."); f.ingest();
  for (let count = 0; count < 8; count += 1) {
    const dispatch = f.advance()[0];
    assert.ok(dispatch, `turn ${count + 1} is admitted`);
    f.finish(dispatch, `Distinct contribution ${count + 1}.`); f.ingest();
  }
  assert.deepEqual(f.advance(), []);
  assert.deepEqual(f.advance(), []);
  const notices = f.runtime.chatMessages(source.topicId).filter((message) =>
    message.sender.kind === "system" && /上限/.test(message.body));
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.body, /不代表所有 Agent 都决定不发言/);
}));

test("an invocation failure stays failed in its message ring rather than counting as silence", () => fixture((f) => {
  const source = f.post("One Agent will fail."); f.ingest();
  const a = f.advance()[0]!;
  const execution = f.claim(a);
  f.runtime.failExecution(execution.executionId, "fixture provider unavailable", f.now(), 1_000, {retry: "never"});
  const b = f.advance()[0]!;
  assert.equal(b.agentId, f.bob.principalId); f.finish(b);
  assert.deepEqual(f.advance(), []);
  const progress = f.chat.readProgressForMessages([source.eventId]).get(source.eventId)!;
  assert.equal(progress.read, 1);
  assert.equal(progress.agents.find(({agentId}) => agentId === f.alice.principalId)?.state, "failed");
  assert.equal(f.runtime.chatDecisionReceipt(a.eventId), undefined);
}));


test("pending keyword attention keeps its Owner authority while seeing later messages", () => fixture((f) => {
  const original = f.post("URGENT: inspect the original request.");
  f.runtime.setChatPresence(f.bob.principalId, original.topicId,
    {scope: "topic", mode: "snoozed", until: "2026-09-17T00:00:00.000Z", wakeKeywords: ["URGENT"]}, f.now());
  f.ingest();
  const a = f.advance()[0]!; f.claim(a);
  const supplement = f.post("A later supplement without the keyword."); f.ingest();
  assert.equal(f.runtime.chatAttentionReceipts(supplement.eventId)
    .find(({agentId}) => agentId === f.bob.principalId)?.reason, "topic-snoozed");
  f.finish(a, "Alice contributed a finding."); f.ingest();
  const b = f.advance()[0]!;
  assert.equal(b.agentId, f.bob.principalId);
  assert.equal(b.sourceMessageEventId, original.eventId);
  assert.match(b.prompt, /A later supplement/);
  assert.match(b.prompt, /Alice contributed a finding/);
  f.finish(b);
  assert.equal(f.chat.readProgressForMessages([original.eventId]).get(original.eventId)?.read, 2);
}));

test("multiple mentions rotate only their participants and later free chat restores the full roster", () => fixture((f) => {
  const source = f.post("@alice @bob divide the two tasks between you.");
  assert.equal(source.targets?.length, 2);
  f.ingest();
  assert.equal(f.runtime.events().filter((event) => event.type === "chat.dispatch").length, 0);
  const alice = f.advance()[0]!;
  assert.equal(alice.agentId, f.alice.principalId);
  assert.equal(alice.promptResourceId, chatMentionPromptResourceId);
  assert.deepEqual(f.advance(), []);
  f.claim(alice);
  assert.deepEqual(f.advance(), [], "Bob waits for Alice's Chat turn to finish");
  f.finish(alice, "Alice claims the first task; Bob can take the second.");
  f.ingest();
  const bob = f.advance()[0]!;
  assert.equal(bob.agentId, f.bob.principalId);
  assert.equal(bob.sourceMessageEventId, source.eventId);
  assert.match(bob.prompt, /Alice claims the first task/);
  f.finish(bob, "Bob claims only the second task.");
  f.ingest();
  const aliceAgain = f.advance()[0]!;
  assert.equal(aliceAgain.agentId, f.alice.principalId);
  assert.match(aliceAgain.prompt, /Bob claims only the second task/);
  f.finish(aliceAgain);
  assert.deepEqual(f.advance(), []);
  assert.ok(f.runtime.events().filter((event) => event.type === "chat.dispatch")
    .every((event) => event.agentId !== f.carol!.principalId));
  const progress = f.chat.readProgressForMessages([source.eventId]).get(source.eventId)!;
  assert.equal(progress.read, 2);
  assert.equal(progress.agents.find(({agentId}) => agentId === f.carol!.principalId)?.state, "unread");

  const free = f.post("Now everyone can discuss the shared result.");
  f.ingest();
  const seen: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const dispatch = f.advance()[0]!;
    seen.push(dispatch.agentId);
    f.finish(dispatch);
  }
  assert.deepEqual(seen, [f.alice.principalId, f.bob.principalId, f.carol!.principalId]);
  assert.deepEqual(f.advance(), []);
  assert.equal(f.chat.readProgressForMessages([free.eventId]).get(free.eventId)?.read, 3);
}, true));

test("a single mention retains direct attention admission", () => fixture((f) => {
  const source = f.post("@alice take the one task.");
  f.ingest();
  const dispatch = f.runtime.events().find((event) => event.type === "chat.dispatch");
  assert.equal(dispatch?.type, "chat.dispatch");
  assert.equal(dispatch?.agentId, f.alice.principalId);
  assert.deepEqual(f.advance(), []);
  assert.equal(f.runtime.chatAttentionReceipts(source.eventId)
    .find(({agentId}) => agentId === f.bob.principalId)?.reason, "not-target");
}));

test("multiple mentions after budget exhaustion do not revive unmentioned pending participants", () => fixture((f) => {
  f.post("Everyone can contribute to the old discussion."); f.ingest();
  for (let i = 0; i < 8; i += 1) {
    const dispatch = f.advance()[0]!;
    f.finish(dispatch, `Old discussion contribution ${i + 1}.`); f.ingest();
  }
  assert.deepEqual(f.advance(), []);
  f.post("@alice @bob start a fresh focused discussion."); f.ingest();
  const seen: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const dispatch = f.advance()[0]!;
    seen.push(dispatch.agentId);
    f.finish(dispatch);
  }
  assert.deepEqual(seen, [f.alice.principalId, f.bob.principalId]);
  assert.deepEqual(f.advance(), []);
}, true));

test("four Owner tasks expose admitted claims to the second participant and later reply turns", () => fixture((f) => {
  const tasks = ["Inspect the API.", "Inspect the UI.", "Inspect the tests.", "Inspect the documentation."];
  const source = f.post(`@alice @bob ${tasks.join(" ")}`);
  f.ingest();
  assert.deepEqual(f.claimQueries, [], "ingestion does not preload mutable task claims");
  const a = f.advance()[0]!;
  assert.deepEqual(f.contexts.at(-1)?.taskClaims, []);
  f.claim(a);
  const firstClaim = {runId: "run_fixture_api", dispatchEventId: a.eventId,
    agentId: f.alice.principalId, status: "active", taskQuote: tasks[0]!};
  f.claims.set(source.eventId, [firstClaim]);
  f.finish(a, "API Run admitted; three independent tasks remain."); f.ingest();
  const b = f.advance()[0]!;
  assert.deepEqual(f.contexts.at(-1)?.taskClaims, [{...firstClaim, sourceMessageEventId: source.eventId}]);
  assert.equal(f.contexts.at(-1)?.latestMessage?.eventId, source.eventId);
  assert.match(b.prompt, /three independent tasks remain/);
  assert.match(b.prompt, /"taskQuote": "Inspect the API\."/);
  const allClaims = [firstClaim, ...tasks.slice(1).map((taskQuote, index) => ({
    runId: `run_fixture_task_${index + 2}`, dispatchEventId: b.eventId,
    agentId: f.bob.principalId, status: "active", taskQuote
  }))];
  f.claims.set(source.eventId, allClaims);
  f.finish(b, "The remaining three tasks now each have their own admitted Run."); f.ingest();
  const againA = f.advance()[0]!;
  assert.equal(f.contexts.at(-1)?.latestMessage?.sender.kind, "agent");
  assert.deepEqual(f.contexts.at(-1)?.taskClaims,
    allClaims.map((claim) => ({...claim, sourceMessageEventId: source.eventId})));
  assert.equal(f.contexts.at(-1)?.taskClaims?.length, 4, "task count is independent of Agent count");
  f.finish(againA); assert.deepEqual(f.advance(), []);
}));

test("task-claim prompt snapshots are bounded and disclose truncation", () => fixture((f) => {
  const source = f.post("Inspect the many independent tasks.");
  f.claims.set(source.eventId, Array.from({length: 65}, (_, index) => ({
    runId: `run_fixture_${index}`, dispatchEventId: `evt_fixture_${index}`,
    agentId: f.alice.principalId, status: "active", taskQuote: `Task ${index}.`
  })));
  f.ingest(); f.advance();
  assert.equal(f.contexts.at(-1)?.taskClaims?.length, 64);
  assert.equal(f.contexts.at(-1)?.taskClaimsTruncated, true);
}));
