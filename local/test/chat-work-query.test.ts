import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { addLocalAgent } from "../src/application/agent/control.js";
import { localChatView, postLocalChatMessage } from "../src/application/chat/control.js";
import { callChatReadTool, createChatReadToolContext } from "../src/application/chat/read-tool-policy.js";
import { confirmLocalChatRunProposal } from "../src/application/chat/run-proposal-control.js";
import { listChatWork } from "../src/application/chat/work-query.js";
import { chatPromptResourceId } from "../src/core/chat/model.js";
import { materializeLocalTopicGovernance, removeLocalTopicParticipant } from "../src/application/topic/governance-control.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { parseChatDecisionReceipt } from "../src/core/runtime/store/codec.js";
import type { LocalAgent } from "../src/modules/foundation/model.js";

test("Chat discovers exact session work with bounded cursors and shared card evidence", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-work-"));
  const options = { runtimeDirectory };
  const alice = addLocalAgent(repoRoot, "alice", "codex", options);
  const bob = addLocalAgent(repoRoot, "bob", "codex", options);
  addLocalAgent(repoRoot, "codex", "codex", options);
  const database = openRuntimeDatabase(join(runtimeDirectory, "runtime.db"));
  const runtime = new RuntimeStore(database);
  let clock = 0;
  function dispatch(agent: LocalAgent) {
    const at = new Date(Date.UTC(2026, 8, 10, 0, 0, clock++)).toISOString();
    const message = postLocalChatMessage(repoRoot, `@${agent.handle} inspect this`, {
      ...options, now: () => new Date(at)
    }).message;
    const chat = runtime.claimDueExecutions(100, at).find((item) => item.eventId === message.eventId)!;
    const event = runtime.admitChatAttention(chat.executionId, [{
      plan: {
        agentId: agent.principalId, handle: agent.handle,
        outcome: "dispatch", reason: "direct-mention",
        presenceSnapshot: {
          global: { scope: "global", mode: "available", wakeKeywords: [] },
          topic: { scope: "topic", mode: "available", wakeKeywords: [] }
        }
      }, prompt: "fixture", promptResourceId: chatPromptResourceId
    }], at)[0]!;
    const execution = runtime.claimDueExecutions(100, at).find((item) => item.eventId === event.eventId)!;
    return { message, event, execution, at };
  }
  function propose(agent: LocalAgent) {
    const turn = dispatch(agent);
    runtime.completeExecution(turn.execution.executionId, {
      adapterId: "fixture", workspace: repoRoot, providerSessionId: agent.handle,
      chatDecision: {
        schema: "ChatDecision@2",
        speech: { action: "propose_run", proposal: {
          schema: "ChatRunProposalDraft@1", goal: "Inspect fixture",
          scope: { include: ["Inspect fixture"], exclude: [] },
          acceptance: ["Report findings"], desiredEffect: "none"
        } }, presence: { scope: "topic", mode: "available", wakeKeywords: [] }
      }
    }, turn.at);
    const proposal = localChatView(repoRoot, options).messages.items
      .find((message) => message.eventId === turn.message.eventId)!.runProposals![0]!;
    const started = confirmLocalChatRunProposal(repoRoot, turn.message.eventId,
      turn.event.eventId, proposal.revision, { ...options, now: () => new Date(turn.at) });
    return { ...turn, runId: started.run.runId };
  }
  try {
    const first = propose(alice);
    assert.equal(first.event.sessionId, undefined);
    const receipt = parseChatDecisionReceipt(runtime.executionReceiptJson(first.execution.executionId));
    assert.equal(receipt?.sessionId, runtime.currentLocalAgentSession(alice.principalId)?.sessionId);
    const second = propose(alice);
    const foreign = propose(bob);
    const queryTurn = dispatch(alice);
    const context = createChatReadToolContext({ repoRoot, runtimeDirectory,
      dispatchEventId: queryTurn.event.eventId });
    const page = callChatReadTool(context, "list_chat_work", { limit: 1 }) as ReturnType<typeof listChatWork>;
    assert.equal(page.scope.agentId, alice.principalId);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.runId, second.runId);
    assert.equal(page.hasEarlier, true);
    const earlier = callChatReadTool(context, "list_chat_work", {
      limit: 1, beforeDispatchEventId: page.beforeDispatchEventId
    }) as ReturnType<typeof listChatWork>;
    assert.equal(earlier.items[0]!.runId, first.runId);
    assert.equal(earlier.hasEarlier, false);
    assert.equal(earlier.items[0]!.originatingSessionId, receipt!.sessionId);
    assert.throws(() => callChatReadTool(context, "list_chat_work", {
      beforeDispatchEventId: foreign.event.eventId
    }), /outside the current scope/);
    assert.throws(() => callChatReadTool(context, "list_chat_work", { agentId: bob.principalId }), /argument/i);
    assert.throws(() => callChatReadTool(context, "list_chat_work", { limit: 21 }), /limit/);
    const card = localChatView(repoRoot, options).messages.items
      .find((message) => message.eventId === second.message.eventId)!.runProposals![0]!.linkedRun;
    const detail = callChatReadTool(context, "get_run", { runId: second.runId }) as { work: unknown };
    assert.deepEqual(card, detail.work);
    assert.equal(page.items[0]!.status, card!.status);
    assert.equal(page.items[0]!.terminal, false);
    assert.equal(page.items[0]!.state, "started");
    assert.throws(() => listChatWork({ repoRoot, runtimeDirectory }, { limit: 10 }), /unavailable/);
    assert.throws(() => listChatWork({ repoRoot, runtimeDirectory,
      dispatchEventId: first.event.eventId }, { limit: 10 }), /unavailable/);
    // Historical receipts lack the completion Session. Only an exact dispatch
    // Session can recover that relation; first-turn history must remain unknown.
    for (const turn of [first, second]) {
      const raw = JSON.parse(runtime.executionReceiptJson(turn.execution.executionId)!);
      delete raw.sessionId;
      database.prepare("UPDATE executions SET receipt_json = ? WHERE execution_id = ?")
        .run(JSON.stringify(raw), turn.execution.executionId);
    }
    const legacy = listChatWork(context, { limit: 10 });
    assert.deepEqual(legacy.items.map((item) => item.runId), [second.runId]);
    runtime.reconcileCurrentLocalAgentSession(alice.principalId, "other", repoRoot, queryTurn.at);
    assert.throws(() => callChatReadTool(context, "list_chat_work", {}), /no longer active/);
    // A fresh first turn cannot inherit the old session's accepted work.
    const fresh = dispatch(alice);
    assert.deepEqual(listChatWork({ repoRoot, runtimeDirectory,
      dispatchEventId: fresh.event.eventId }, { limit: 10 }).items, []);
    const governance = materializeLocalTopicGovernance(repoRoot, runtimeDirectory);
    removeLocalTopicParticipant(repoRoot, alice.principalId, governance.governance.revision, options);
    assert.throws(() => listChatWork({ repoRoot, runtimeDirectory,
      dispatchEventId: fresh.event.eventId }, { limit: 10 }), /no longer active/);
  } finally {
    runtime.close();
    database.close();
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});
