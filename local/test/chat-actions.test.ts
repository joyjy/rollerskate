import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { addLocalAgent } from "../src/application/agent/control.js";
import { localChatView, postLocalChatMessage } from "../src/application/chat/control.js";
import { ChatHandler } from "../src/application/chat/handler.js";
import { callChatTool, createChatToolContext } from "../src/application/chat/tool-policy.js";
import { admitChatWorkReturns } from "../src/application/chat/work-return.js";
import { cancelStewardRun } from "../src/application/steward/control.js";
import { TopicGovernanceAdmissionPolicy } from "../src/application/topic/admission.js";
import { chatPromptResourceId } from "../src/core/chat/model.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";

test("Owner Chat tools admit once, share UI evidence, and return to the exact idle Session", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-actions-"));
  const options = { runtimeDirectory };
  const alice = addLocalAgent(repoRoot, "alice", "codex", options);
  const bob = addLocalAgent(repoRoot, "bob", "codex", options);
  addLocalAgent(repoRoot, "codex", "codex", options);
  const database = openRuntimeDatabase(join(runtimeDirectory, "runtime.db"));
  const runtime = new RuntimeStore(database);
  const chat = new LocalChatStore(database);
  const at = () => new Date().toISOString();
  function dispatch(body: string, agent = alice) {
    const message = postLocalChatMessage(repoRoot, body, options).message;
    const execution = runtime.claimDueExecutions(100, at()).find(item => item.eventId === message.eventId)!;
    const event = runtime.admitChatAttention(execution.executionId, [{
      plan: { agentId: agent.principalId, handle: agent.handle, outcome: "dispatch", reason: "direct-mention",
        presenceSnapshot: { global: {scope:"global",mode:"available",wakeKeywords:[]}, topic: {scope:"topic",mode:"available",wakeKeywords:[]} } },
      prompt:"fixture",promptResourceId:chatPromptResourceId
    }], at())[0]!;
    const agentExecution = runtime.claimDueExecutions(100, at()).find(item => item.eventId === event.eventId)!;
    return { message, event, execution: agentExecution,
      context: createChatToolContext({repoRoot,runtimeDirectory,dispatchEventId:event.eventId}) };
  }
  function complete(turn: ReturnType<typeof dispatch>, providerSessionId = "alice-session") {
    runtime.completeExecution(turn.execution.executionId, {
      adapterId:"fixture",workspace:repoRoot,providerSessionId,
      chatDecision:{schema:"ChatDecision@2",speech:{action:"silent",reason:"awaiting work"},presence:{scope:"topic",mode:"available",wakeKeywords:[]}}
    },at());
  }
  const returns = () => admitChatWorkReturns({repoRoot,runtimeDirectory,database,runtime},at());
  try {
    const first = dispatch("@alice 请研究持续会话的边界并报告结论。");
    assert.throws(() => callChatTool(first.context,"start_chat_run",{desiredEffect:"none",objective:"replace mandate"}), /malformed/);
    assert.equal((callChatTool(first.context,"start_chat_run",{desiredEffect:"read",workspacePath:repoRoot}) as {status:string}).status,"needs_authorization");
    const exhausted = {...first.context,returnedBytes:1_048_575};
    assert.throws(() => callChatTool(exhausted,"start_chat_run",{desiredEffect:"none"}),/budget/);
    const accepted = callChatTool(first.context,"start_chat_run",{desiredEffect:"none"}) as {runId:string;status:string;authoritySourceEventId:string};
    assert.equal(accepted.status,"accepted");
    assert.equal(accepted.authoritySourceEventId,first.message.eventId);
    assert.ok(first.context.returnedBytes > 0);
    const duplicate = callChatTool(first.context,"start_chat_run",{desiredEffect:"none"}) as typeof accepted;
    assert.equal(duplicate.runId,accepted.runId);
    assert.equal(duplicate.status,"duplicate");
    const card = localChatView(repoRoot,options).messages.items.find(item=>item.eventId===first.message.eventId)!.works![0];
    assert.deepEqual(card,(callChatTool(first.context,"get_run",{runId:accepted.runId}) as {work:unknown}).work);
    assert.deepEqual(returns().eventIds,[]); // no provider Session until the first turn settles
    complete(first);
    const busy = dispatch("@alice 取消刚才的研究任务。");
    const args = {runId:accepted.runId,expectedVersion:card!.version,action:"cancel"};
    assert.throws(() => callChatTool(busy.context,"control_chat_run",{...args,expectedVersion:999}),/version changed/);
    assert.throws(() => callChatTool(busy.context,"control_chat_run",{...args,runId:"run_unknown"}),/outside/);
    assert.throws(() => callChatTool(busy.context,"control_chat_run",{...args,action:"retry_orchestrator"}),/not awaiting/);
    assert.equal((callChatTool(busy.context,"control_chat_run",args) as {status:string}).status,"cancelled");
    assert.throws(() => callChatTool(busy.context,"control_chat_run",args),/version changed/);
    assert.deepEqual(returns().eventIds,[]);
    complete(busy);
    const admitted = returns().eventIds;
    assert.equal(admitted.length,1);
    assert.deepEqual(returns().eventIds,[]);
    const activation = runtime.event(admitted[0]!);
    assert.equal(activation?.type,"chat.activation");
    assert.equal(activation?.sessionId,runtime.currentLocalAgentSession(alice.principalId)?.sessionId);
    const execution = runtime.claimDueExecutions(100,at()).find(item=>item.eventId===admitted[0])!;
    const ids = new ChatHandler({store:runtime,chat,listAgents:()=>[alice]}).handle(execution,at());
    assert.equal(ids.length,1);
    const returnedDispatch = runtime.event(ids[0]!);
    assert.equal(returnedDispatch?.sessionId,activation?.sessionId);
    assert.equal(returnedDispatch?.type,"chat.dispatch");
    if (returnedDispatch?.type !== "chat.dispatch") return;
    assert.match(returnedDispatch.prompt,new RegExp(accepted.runId));
    assert.match(returnedDispatch.prompt,/start_chat_run/);
    const returnExecution = runtime.claimDueExecutions(100,at()).find(item=>item.eventId===returnedDispatch.eventId)!;
    const resultContext = createChatToolContext({repoRoot,runtimeDirectory,dispatchEventId:returnedDispatch.eventId});
    assert.equal((callChatTool(resultContext,"start_chat_run",{desiredEffect:"none"}) as {status:string}).status,"needs_authorization");
    // A fresh Runtime handle sees the durable return marker, not process memory.
    const reopened = openRuntimeDatabase(join(runtimeDirectory,"runtime.db"));
    const recovered = new RuntimeStore(reopened);
    try { assert.deepEqual(admitChatWorkReturns({repoRoot,runtimeDirectory,database:reopened,runtime:recovered}).eventIds,[]); }
    finally { recovered.close();reopened.close(); }
    runtime.reconcileCurrentLocalAgentSession(alice.principalId,"rotated",repoRoot,at());
    const policy = new TopicGovernanceAdmissionPolicy({runtime,listAgents:()=>[alice],getGovernance:()=>undefined});
    assert.equal(policy.canInvoke(returnedDispatch,at()).outcome,"skip");
    // Complete the already-running fixture turn only to release it for the next
    // admission probe; production's invoke guard rejects this rotated binding.
    runtime.cancelRunningAgentExecution(returnExecution.executionId, "fixture cleanup", at());
    for (let i=0;i<20;i++) {
      const blocked = dispatch(`@bob 研究第 ${i} 项`,bob);
      const run = callChatTool(blocked.context,"start_chat_run",{desiredEffect:"none"}) as {runId:string};
      cancelStewardRun(repoRoot,run.runId,runtimeDirectory);
    }
    const last = dispatch("@alice 研究最后一项");
    const lastRun = callChatTool(last.context,"start_chat_run",{desiredEffect:"none"}) as {runId:string};
    complete(last,"alice-new-session");
    cancelStewardRun(repoRoot,lastRun.runId,runtimeDirectory);
    const page = returns();
    assert.deepEqual(page.eventIds,[]);
    assert.ok(page.nextCursor);
    const next = admitChatWorkReturns({repoRoot,runtimeDirectory,database,runtime,after:page.nextCursor!});
    assert.equal(next.eventIds.length,1); // blocked early candidates cannot starve later work

  } finally {
    chat.close();runtime.close();database.close();rmSync(runtimeDirectory,{recursive:true,force:true});
  }
});
