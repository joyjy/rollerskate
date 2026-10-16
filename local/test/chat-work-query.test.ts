import { RunAdmissionStore } from "../src/infrastructure/files/run-admission-store.js";
import { deterministicRunId, workDigest, type DeterministicRunIntent } from "../src/modules/run/intent.js";
import { localId } from "../src/core/id.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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
    assert.deepEqual({...card,returnState:{status:"awaiting_result"}}, detail.work);
    assert.equal(page.items[0]!.status, card!.status);
    assert.equal(page.items[0]!.terminal, false);
    assert.equal(page.items[0]!.state, "started");
    assert.throws(() => callChatReadTool(context, "get_run", {runId:foreign.runId}), /query failed/);
    const admissions = new RunAdmissionStore(runtimeDirectory);
    const reserve = (requestId:string, dispatchEventId:string, kind:"command"|"observe") => {
      const intent:DeterministicRunIntent = {schemaVersion:"RunIntent@2",requestId,title:"api_key=private-value",maxWaitMilliseconds:1000,
        resultDestinationRef:`rs-chat:${dispatchEventId}`,work:kind === "command"
          ? {kind,executable:"private-command",args:["private-argument"],cwd:runtimeDirectory}
          : {kind,mode:"until",sourceRef:"plugin:private@1",input:{secret:"private-input"}}};
      const runId = deterministicRunId(requestId);
      admissions.reserve({schemaVersion:"RunAdmission@1",runId,sourceId:localId("sub"),createdAt:second.at,
        intent,intentDigest:workDigest(intent),planDigest:`sha256:${"0".repeat(64)}`});
      return runId;
    };
    const command = reserve("command",second.event.eventId,"command");
    const observation = reserve("observation",second.event.eventId,"observe");
    const foreignObservation = reserve("foreign",foreign.event.eventId,"observe");
    const seen:string[] = [];
    let cursor:{beforeDispatchEventId?:string;beforeRunId?:string} = {};
    for (;;) {
      const part = listChatWork(context,{limit:1,...cursor});
      seen.push(...part.items.map(item=>item.runId));
      if (!part.hasEarlier) break;
      cursor = {beforeDispatchEventId:part.beforeDispatchEventId!,beforeRunId:part.beforeRunId!};
    }
    assert.equal(new Set(seen).size,4);
    assert.deepEqual(new Set(seen),new Set([first.runId,second.runId,command,observation]));
    assert.throws(() => listChatWork(context,{limit:1,beforeDispatchEventId:second.event.eventId,beforeRunId:foreignObservation}), /outside/);
    const commandAdmission = admissions.read(command);
    const commandDirectory = join(runtimeDirectory,"commands",command);
    mkdirSync(commandDirectory,{recursive:true});
    writeFileSync(join(commandDirectory,"request.json"),JSON.stringify({schemaVersion:"ShellCommandRequest@2",commandId:command,
      subscriptionId:commandAdmission.sourceId,argv:["private-argument"]}));
    writeFileSync(join(commandDirectory,"receipt.json"),JSON.stringify({schemaVersion:"ShellCommandReceipt@1",commandId:command,
      state:"completed",startedAt:second.at,completedAt:second.at,outcome:"success",exitCode:0,signal:null}));
    const deterministic = callChatReadTool(context,"get_run",{runId:command}) as {work:{kind:string;status:string};execution:{state:string;outcome:string}};
    assert.equal(deterministic.work.kind,"command");
    assert.equal(deterministic.work.status,"succeeded");
    assert.equal(deterministic.execution.state,"completed");
    assert.equal(deterministic.execution.outcome,"success");
    assert.equal((callChatReadTool(context,"get_run",{runId:observation}) as {work:{status:string}}).work.status,"unknown");
    assert.doesNotMatch(JSON.stringify(deterministic),/private-value|private-command|private-argument|private-input|admission.json/);
    assert.throws(() => callChatReadTool(context,"get_run",{runId:foreignObservation}), /query failed/);
    const originalPayload = (database.prepare("SELECT payload_json FROM events WHERE event_id = ?").get(second.event.eventId) as {payload_json:string}).payload_json;
    database.prepare("UPDATE events SET payload_json = ? WHERE event_id = ?")
      .run(JSON.stringify({...JSON.parse(originalPayload),topicId:"topic_other"}),second.event.eventId);
    assert.throws(() => callChatReadTool(context,"get_run",{runId:command}), /query failed/);
    assert.equal(listChatWork(context,{limit:10}).items.some(item=>item.runId===command),false);
    database.prepare("UPDATE events SET payload_json = ? WHERE event_id = ?").run(originalPayload,second.event.eventId);

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
    assert.deepEqual(new Set(legacy.items.map((item) => item.runId)), new Set([second.runId,command,observation]));
    runtime.reconcileCurrentLocalAgentSession(alice.principalId, "other", repoRoot, queryTurn.at);
    assert.throws(() => callChatReadTool(context, "list_chat_work", {}), /no longer active/);
    assert.throws(() => callChatReadTool(context,"get_run",{runId:command}), /query failed/);
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
