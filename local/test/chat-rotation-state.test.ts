import assert from "node:assert/strict";
import test from "node:test";
import {
  chatRotationStatus,
  completeChatRotationTurn,
  createChatRotationState,
  offerChatRotationMessage,
  parseChatRotationState,
  startChatRotationTurn,
  type ChatRotationState
} from "../src/application/chat/rotation-state.js";

function owner(state: ChatRotationState, order = ["a", "b", "c"]) {
  return offerChatRotationMessage(state, { ownerOrder: order });
}

function finished(state: ChatRotationState, outcome: "completed" | "failed" = "completed") {
  const started = startChatRotationTurn(state)!;
  return { agent: started.turn.agentId, state: completeChatRotationTurn(started.state, started.turn, outcome) };
}

test("rotation runs serially in the Owner order and finishes after every Agent is silent", () => {
  let state = owner(createChatRotationState(["a", "b", "c"], { turnBudget: 8 }), ["c", "a", "b"]);
  const first = startChatRotationTurn(state)!;
  assert.equal(startChatRotationTurn(first.state), undefined);
  state = completeChatRotationTurn(first.state, first.turn, "completed");
  const second = finished(state);
  const third = finished(second.state);
  assert.deepEqual([first.turn.agentId, second.agent, third.agent], ["c", "a", "b"]);
  assert.equal(chatRotationStatus(third.state), "quiescent");
});

test("Owner bursts preserve the current round and merge one later evaluation using the latest order", () => {
  const original = owner(createChatRotationState(["a", "b", "c"], { turnBudget: 8 }));
  const active = startChatRotationTurn(original)!;
  let state = owner(active.state, ["c", "b", "a"]);
  state = owner(state, ["b", "a", "c"]);
  assert.deepEqual(state.currentQueue, ["b", "c"]);
  assert.deepEqual(state.nextPending, ["a"]);
  state = completeChatRotationTurn(state, active.turn, "completed");
  assert.deepEqual(state.evaluated, [{ agentId: "a", revision: 1 }]);
  const second = finished(state);
  const third = finished(second.state);
  const fourth = finished(third.state);
  assert.deepEqual([second.agent, third.agent, fourth.agent], ["b", "c", "a"]);
  assert.equal(fourth.state.turnsStarted, 4);
  assert.equal(chatRotationStatus(fourth.state), "quiescent");
  assert.ok(fourth.state.evaluated.every(({ revision }) => revision === 3));
});

test("Agent speech requeues processed peers once and never wakes its own speaker", () => {
  let state = owner(createChatRotationState(["a", "b", "c"], { turnBudget: 8 }));
  state = finished(state).state;
  const b = startChatRotationTurn(state)!;
  state = offerChatRotationMessage(b.state, { senderAgentId: "b" });
  state = offerChatRotationMessage(state, { senderAgentId: "b" });
  assert.deepEqual(state.currentQueue, ["c"]);
  assert.deepEqual(state.nextPending, ["a"]);
  state = completeChatRotationTurn(state, b.turn, "completed");
  const c = finished(state);
  const a = finished(c.state);
  assert.deepEqual([c.agent, a.agent], ["c", "a"]);
  assert.equal(chatRotationStatus(a.state), "quiescent");
});

test("an active speaker cannot erase a pending Owner supplement by publishing its older answer", () => {
  const a = startChatRotationTurn(owner(createChatRotationState(["a", "b", "c"], { turnBudget: 8 })))!;
  let state = owner(a.state);
  state = offerChatRotationMessage(state, { senderAgentId: "a" });
  state = completeChatRotationTurn(state, a.turn, "completed");
  assert.deepEqual(state.nextPending, ["a"]);
  assert.equal(state.evaluated[0]?.revision, 1);
});

test("new eligible Agents join the next round without rearranging waiting peers", () => {
  const a = startChatRotationTurn(owner(createChatRotationState(["a", "b", "c"], { turnBudget: 8 })))!;
  let state = owner(a.state, ["d", "c", "a", "b"]);
  state = completeChatRotationTurn(state, a.turn, "completed");
  state = finished(finished(state).state).state;
  const d = finished(state);
  const againA = finished(d.state);
  assert.deepEqual([d.agent, againA.agent], ["d", "a"]);
});

test("failure is distinguishable from silence and stale completion cannot release another turn", () => {
  const state = owner(createChatRotationState(["a"], { turnBudget: 8 }), ["a"]);
  const a = startChatRotationTurn(state)!;
  const failed = completeChatRotationTurn(a.state, a.turn, "failed");
  assert.equal(chatRotationStatus(failed), "blocked");
  assert.equal(failed.evaluated.length, 0);
  assert.throws(() => completeChatRotationTurn(failed, a.turn, "completed"), /active turn changed/);
});

test("budget exhaustion preserves pending work and an active burst does not replenish the budget", () => {
  const a = startChatRotationTurn(owner(createChatRotationState(["a", "b", "c"], { turnBudget: 1 })))!;
  const state = completeChatRotationTurn(owner(a.state), a.turn, "completed");
  assert.equal(chatRotationStatus(state), "budget_exhausted");
  assert.equal(startChatRotationTurn(state), undefined);
  const reopened = owner(state);
  assert.equal(reopened.turnsStarted, 0);
  assert.equal(chatRotationStatus(reopened), "ready");
});

test("durable rotation state roundtrips the active snapshot and newer Owner content", () => {
  const a = startChatRotationTurn(owner(createChatRotationState(["a", "b", "c"], { turnBudget: 8 })))!;
  const state = owner(a.state, ["c", "b", "a"]);
  const parsed = parseChatRotationState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(parsed, state);
  assert.deepEqual(completeChatRotationTurn(parsed, a.turn, "completed").nextPending, ["a"]);
});

test("durable rotation state rejects malformed fields and queue or snapshot references", () => {
  const state = startChatRotationTurn(owner(createChatRotationState(["a", "b", "c"], { turnBudget: 8 })))!.state;
  const malformed: unknown[] = [
    null, [], {...state, schema: "ChatRotationState@2"},
    {...state, agentIds: ["a", "a"]}, {...state, agentIds: [123]},
    {...state, agentIds: Array.from({length: 65}, (_, i) => `agent-${i}`)},
    {...state, agentIds: ["x".repeat(257)]}, {...state, revision: "1"},
    {...state, revision: -1}, {...state, revision: 1.5},
    {...state, turnsStarted: 65}, {...state, turnBudget: 0},
    {...state, active: {...state.active!, sequence: 2}},
    {...state, active: {...state.active!, revision: 2}},
    {...state, currentQueue: ["absent"]}, {...state, nextOrder: ["a", "b"]},
    {...state, nextPending: ["b"]},
    {...state, evaluated: [{agentId: "a", revision: 2}]},
    {...state, evaluated: [{agentId: "absent", revision: 1}]},
    {...state, evaluated: [{agentId: "a", revision: 1}, {agentId: "a", revision: 1}]},
    {...state, failedAgents: [false]}
  ];
  for (const value of malformed) assert.throws(() => parseChatRotationState(value), /Chat rotation/);
});

test("roster changes retain an already active token while dropping retired evaluation references", () => {
  let state = finished(owner(createChatRotationState(["a", "b", "c"], { turnBudget: 8 }))).state;
  const b = startChatRotationTurn(state)!;
  state = owner(b.state, ["c"]);
  assert.deepEqual(state.evaluated, []);
  assert.deepEqual(parseChatRotationState(JSON.parse(JSON.stringify(state))), state);
  assert.deepEqual(completeChatRotationTurn(state, b.turn, "completed").evaluated, []);
  assert.deepEqual(completeChatRotationTurn(state, b.turn, "failed").failedAgents, []);
});
