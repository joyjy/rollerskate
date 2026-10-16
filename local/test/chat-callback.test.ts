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

import { chatCallbackAction, CHAT_CALLBACK_ACTION, chatReturnState } from "../src/application/chat/callback.js";
import { DeterministicApplicationActionRegistry } from "../src/application/proactive/action-registry.js";
test("Chat callback preserves origin, waits for idle, survives restart and distinguishes Agent completion", () => {
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
    const first = dispatch("@alice 等命令结束，核验后报告。");
    const registry = new DeterministicApplicationActionRegistry(database,[chatCallbackAction]);
    const target = registry.compileTarget(CHAT_CALLBACK_ACTION,{dispatchEventId:first.event.eventId,title:"Read-only command"});
    const input = {target,source:{kind:"subscription" as const,id:"sub_callback",definitionRevision:"SubscriptionDefinition@5:1"},
      occurrenceKey:"terminal",observation:{terminal:"failure",facts:{status:"unknown",reason:"Command outcome unknown",log:"bulk-evidence-".repeat(400)},sourceRevision:"exact-v1"},at:at()};
    const receipt = runtime.withImmediateTransaction(()=>registry.executeInTransaction(input));
    assert.equal(receipt.status,"succeeded");
    assert.deepEqual(runtime.withImmediateTransaction(()=>registry.executeInTransaction(input)),receipt);
    const state = () => chatReturnState(database,runtime,first.event.eventId,`chat-callback-return:${receipt.receiptId}`);
    assert.equal(state().status,"waiting_origin");
    assert.deepEqual(returns().eventIds,[]);
    complete(first);
    const busy = dispatch("@alice 先处理另一条消息");
    assert.equal(state().status,"waiting_agent");
    assert.deepEqual(returns().eventIds,[]);
    complete(busy);
    const ids = returns().eventIds;
    assert.equal(ids.length,1);
    assert.equal(state().status,"admitted");
    const notice = runtime.event(ids[0]!)!;
    assert.equal(notice.type,"chat.activation");
    const serialized = JSON.stringify(notice);
    assert.ok(serialized.includes("failure / unknown"));
    assert.ok(serialized.includes("Command outcome unknown"));
    assert.ok(serialized.includes(receipt.receiptId));
    assert.ok(!serialized.includes("bulk-evidence"));
    const reopened = openRuntimeDatabase(join(runtimeDirectory,"runtime.db"));
    const recovered = new RuntimeStore(reopened);
    try { assert.deepEqual(admitChatWorkReturns({repoRoot,runtimeDirectory,database:reopened,runtime:recovered}).eventIds,[]); }
    finally {recovered.close();reopened.close();}
    const activation = runtime.claimDueExecutions(100,at()).find(item=>item.eventId===ids[0])!;
    const [childId] = new ChatHandler({store:runtime,chat,listAgents:()=>[alice]}).handle(activation,at());
    assert.equal(state().status,"agent_pending");
    const child = runtime.claimDueExecutions(100,at()).find(item=>item.eventId===childId)!;
    const context = createChatToolContext({repoRoot,runtimeDirectory,dispatchEventId:childId!});
    const readback = callChatTool(context,"get_chat_callback",{receiptId:receipt.receiptId}) as {receipt:typeof receipt};
    assert.deepEqual(readback.receipt.output,receipt.output);
    runtime.completeExecution(child.executionId,{adapterId:"fixture",workspace:repoRoot,providerSessionId:"alice-session",
      chatDecision:{schema:"ChatDecision@2",speech:{action:"silent",reason:"verified result"},presence:{scope:"topic",mode:"available",wakeKeywords:[]}}},at());
    assert.equal(state().status,"turn_completed");
    assert.equal((state() as {taskAcceptance?:string}).taskAcceptance,"unverified");
    const failedReceipt = runtime.withImmediateTransaction(()=>registry.executeInTransaction({...input,occurrenceKey:"second-result"}));
    const [failureActivationId] = returns().eventIds;
    const failureActivation = runtime.claimDueExecutions(100,at()).find(item=>item.eventId===failureActivationId)!;
    const [failureDispatchId] = new ChatHandler({store:runtime,chat,listAgents:()=>[alice]}).handle(failureActivation,at());
    const failureExecution = runtime.claimDueExecutions(100,at()).find(item=>item.eventId===failureDispatchId)!;
    runtime.failExecution(failureExecution.executionId,"provider unavailable",at(),1);
    const failureState = chatReturnState(database,runtime,first.event.eventId,`chat-callback-return:${failedReceipt.receiptId}`);
    assert.equal(failureState.status,"failed");
    assert.equal("reason" in failureState && failureState.reason,"responsible_turn_failed");
    assert.deepEqual(returns().eventIds,[]); // Failure stays visible; never resubmit the work or return.
    const other = dispatch("@bob 测试隔离",bob);
    assert.throws(()=>callChatTool(other.context,"get_chat_callback",{receiptId:receipt.receiptId}),/outside/);
    runtime.reconcileCurrentLocalAgentSession(alice.principalId,"rotated",repoRoot,at());
    assert.deepEqual(chatReturnState(database,runtime,first.event.eventId),{status:"blocked",reason:"session_changed"});
    const rotated = dispatch("@alice 查看旧回执");
    assert.throws(()=>callChatTool(rotated.context,"get_chat_callback",{receiptId:receipt.receiptId}),/Session/);
    assert.deepEqual(returns().eventIds,[]);
  } finally {chat.close();runtime.close();database.close();rmSync(runtimeDirectory,{recursive:true,force:true});}
});
