import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { addLocalAgent } from "../src/application/agent/control.js";
import { postLocalChatMessage, rotateLocalAgentSession } from "../src/application/chat/control.js";
import { withChatHistoryContinuation } from "../src/application/chat/agent-continuation.js";
import { ChatHandler } from "../src/application/chat/handler.js";
import { callChatTool, createChatToolContext } from "../src/application/chat/tool-policy.js";
import { chatRunRecoveryToolRequirement, inspectChatRunRecovery, confirmChatRunRecovery, isChatRunRecoveryActivation, requestChatRunRecovery } from "../src/application/chat/run-recovery.js";
import { TopicGovernanceAdmissionPolicy } from "../src/application/topic/admission.js";
import { chatPromptResourceId } from "../src/core/chat/model.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { AgentRunStore } from "../src/infrastructure/sqlite/agent-run-store.js";
import { TopicGovernanceStore } from "../src/infrastructure/sqlite/topic-governance-store.js";
import { StewardModule } from "../src/application/steward/module.js";
import { AgentHandler, ResultHandler } from "../src/core/runtime/handlers.js";

const KIMI_POLICY_OBSERVATION = {client:"kimi-code",controls:{prompt:true,outputFormat:"stream-json",agentFile:"bundled-read-only",auto:true,yolo:false},
  hook:{state:"enforced",helperDigest:"a".repeat(64)}} as const;

test("Chat agent prepares a scoped recovery; Owner confirms exact revision once on the original Run", async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-recovery-"));
  const options = {runtimeDirectory};
  const alice = addLocalAgent(repoRoot,"alice","codex",options);
  const bob = addLocalAgent(repoRoot,"bob","codex",options);
  const codex = addLocalAgent(repoRoot,"codex","codex",options);
  const database = openRuntimeDatabase(join(runtimeDirectory,"runtime.db"));
  const runtime = new RuntimeStore(database);
  const chat = new LocalChatStore(join(runtimeDirectory,"runtime.db"));
  const runs = new AgentRunStore(database);
  const governance = new TopicGovernanceStore(join(runtimeDirectory,"runtime.db"));
  const at = () => new Date().toISOString();
  function dispatch(agent = alice) {
    const message = postLocalChatMessage(repoRoot,`@${agent.handle} 请准备方案，不要自动执行。`,options).message;
    const attention = runtime.claimDueExecutions(100,at()).find(x=>x.eventId===message.eventId)!;
    const event = runtime.admitChatAttention(attention.executionId,[{plan:{agentId:agent.principalId,handle:agent.handle,outcome:"dispatch",reason:"direct-mention",
      presenceSnapshot:{global:{scope:"global",mode:"available",wakeKeywords:[]},topic:{scope:"topic",mode:"available",wakeKeywords:[]}}},prompt:"fixture",promptResourceId:chatPromptResourceId}],at())[0]!;
    const execution = runtime.claimDueExecutions(100,at()).find(x=>x.eventId===event.eventId)!;
    return {event,execution,context:createChatToolContext({repoRoot,runtimeDirectory,dispatchEventId:event.eventId})};
  }
  try {
    const turn = dispatch();
    const started = callChatTool(turn.context,"start_chat_run",{desiredEffect:"none"}) as {runId:string};
    runtime.completeExecution(turn.execution.executionId,{adapterId:"fixture",workspace:repoRoot,providerSessionId:"alice-session",
      chatDecision:{schema:"ChatDecision@2",speech:{action:"silent",reason:"waiting"},presence:{scope:"topic",mode:"available",wakeKeywords:[]}}},at());
    const manifest = new StewardModule({runs,runtime}).manifest();
    const agent = new AgentHandler({store:runtime,executionGuards:manifest.executionGuards,adapters:new Map([[runs.requireProjection(started.runId).stewardAgentId,
      {adapterId:"invalid-decision",workspace:repoRoot,async invoke(){return {providerSessionId:"steward",outcome:{kind:"message" as const,body:"invalid decision"}};}}]])});
    const result = new ResultHandler(runtime,manifest.resultContinuations);
    for (let i=0;i<2;i++) {
      const execution = runtime.claimDueExecutions(100,at()).find(x=>x.handler==="agent");
      assert.ok(execution); await agent.handle(execution,at());
      const settled = runtime.claimDueExecutions(100,at()).find(x=>x.handler==="result");
      assert.ok(settled); result.handle(settled,at());
    }
    const run = runs.requireProjection(started.runId);
    const originalSessionId = runtime.chatDecisionReceipt(turn.event.eventId)?.sessionId;
    assert.ok(originalSessionId);
    rotateLocalAgentSession(repoRoot,alice.principalId,options);
    const unrelatedTurn = dispatch();
    runtime.completeExecution(unrelatedTurn.execution.executionId,{adapterId:"fixture",workspace:repoRoot,providerSessionId:"alice-other-session",
      chatDecision:{schema:"ChatDecision@2",speech:{action:"silent",reason:"unrelated"},presence:{scope:"topic",mode:"available",wakeKeywords:[]}}},at());
    assert.notEqual(runtime.currentLocalAgentSession(alice.principalId)?.sessionId,originalSessionId);
    const requested = requestChatRunRecovery(repoRoot,run.runId,"recovery-1",runtimeDirectory);
    assert.equal(requested.status,"accepted");
    const recoveryActivation = runtime.event(requested.activationEventId);
    assert.equal(recoveryActivation?.type,"chat.activation");
    if (recoveryActivation?.type === "chat.activation") {
      assert.equal(recoveryActivation.reason,"work_result");
      assert.equal(recoveryActivation.strategyId,"work-result");
      assert.equal(recoveryActivation.sessionId,undefined);
    }
    assert.equal(requestChatRunRecovery(repoRoot,run.runId,"recovery-1",runtimeDirectory).status,"duplicate");
    assert.equal(runs.requireProjection(run.runId).version,run.version);
    assert.equal(runs.decisions(run.runId).length,0);
    const activation = runtime.claimDueExecutions(100,at()).find(x=>x.eventId===requested.activationEventId)!;
    const admissionPolicy = new TopicGovernanceAdmissionPolicy({runtime,listAgents:()=>[alice,bob,codex],
      getGovernance:(topicId)=>governance.get(topicId),allowHistoricalSession:isChatRunRecoveryActivation});
    const recoveryDispatchIds = new ChatHandler({store:runtime,chat,listAgents:()=>[alice,bob,codex],admissionPolicy}).handle(activation,at());
    assert.equal(recoveryDispatchIds.length,1);
    assert.equal(runtime.executionForEvent(requested.activationEventId)?.status,"succeeded");
    const recoveryEvent = runtime.event(recoveryDispatchIds[0]!);
    assert.equal(recoveryEvent?.type,"chat.dispatch");
    if (recoveryEvent?.type !== "chat.dispatch") throw new Error("Recovery activation did not dispatch its responsible Agent");
    const recoveryExecution = runtime.claimDueExecutions(100,at()).find(x=>x.eventId===recoveryEvent.eventId)!;
    assert.equal(recoveryEvent.sessionId,runtime.currentLocalAgentSession(alice.principalId)?.sessionId);
    assert.notEqual(recoveryEvent.sessionId,originalSessionId);
    const recoveryTurn = {event:recoveryEvent,execution:recoveryExecution,
      context:createChatToolContext({repoRoot,runtimeDirectory,dispatchEventId:recoveryEvent.eventId})};
    const decision = {schemaVersion:"RunDecision@1",action:"needs_human",expectedRunVersion:run.version,rationale:"Owner review still required",checkedAcceptance:[]};
    let recoveryCalls = 0;
    const recoveryAdapter = withChatHistoryContinuation({adapterId:"fixture",workspace:repoRoot,providerPolicy:KIMI_POLICY_OBSERVATION,
      async invoke(input) {
        recoveryCalls += 1;
        if (recoveryCalls === 1) return {providerSessionId:"alice-other-session",outcome:{kind:"message" as const,body:JSON.stringify({schema:"ChatDecision@2",
          speech:{action:"reply",body:"I prepared the proposal."},presence:{scope:"topic",mode:"available",wakeKeywords:[]}})}};
        assert.equal(input.providerSessionId,"alice-other-session");
        if (recoveryCalls === 2) {
          assert.match(input.event.prompt,/requested recovery proposal was not recorded/);
          return {providerSessionId:"alice-other-session",outcome:{kind:"message" as const,body:JSON.stringify({schema:"ChatToolRequest@1",
            tool:"prepare_chat_run_recovery",arguments:{runId:run.runId,decision}})}};
        }
        assert.match(input.event.prompt,/"status":"prepared"/);
        return {providerSessionId:"alice-other-session",outcome:{kind:"message" as const,body:JSON.stringify({schema:"ChatDecision@2",
          speech:{action:"silent",reason:"proposal prepared"},presence:{scope:"topic",mode:"available",wakeKeywords:[]}})}};
      }}, {chatHistory:()=>{throw new Error("Chat history was not requested");},clientHistory:()=>{throw new Error("Client history was not requested");},
        chatTools:()=>recoveryTurn.context,requiredChatTool:(event)=>chatRunRecoveryToolRequirement(runtime,event)});
    await new AgentHandler({store:runtime,adapters:new Map([[alice.principalId,recoveryAdapter]])}).handle(recoveryExecution,at());
    assert.equal(recoveryCalls,3);
    assert.equal(runs.requireProjection(run.runId).version,run.version);
    assert.equal(runs.decisions(run.runId).length,0);
    const visible = inspectChatRunRecovery(repoRoot,run.runId,runtimeDirectory).proposal;
    assert.ok(visible);
    const prepared = {revision:visible.revision};
    assert.match(visible!.effect,/needs_human/);
    const proposalPath = join(runtimeDirectory,"run-recovery",`${run.runId}.json`);
    const parkedProposalPath = `${proposalPath}.parked`;
    renameSync(proposalPath,parkedProposalPath);
    assert.deepEqual(inspectChatRunRecovery(repoRoot,run.runId,runtimeDirectory).request,
      {state:"failed",error:"responsible_agent_finished_without_preparing_recovery"});
    renameSync(parkedProposalPath,proposalPath);
    const adjustment = requestChatRunRecovery(repoRoot,run.runId,"recovery-2",runtimeDirectory);
    const adjustmentActivation = runtime.claimDueExecutions(100,at()).find(x=>x.eventId===adjustment.activationEventId)!;
    const adjustmentDispatchId = new ChatHandler({store:runtime,chat,listAgents:()=>[alice,bob,codex],admissionPolicy}).handle(adjustmentActivation,at())[0]!;
    const adjustmentExecution = runtime.claimDueExecutions(100,at()).find(x=>x.eventId===adjustmentDispatchId)!;
    const adjustmentContext = createChatToolContext({repoRoot,runtimeDirectory,dispatchEventId:adjustmentDispatchId});
    assert.equal((callChatTool(adjustmentContext,"get_run",{runId:run.runId}) as {work:{runId:string}}).work.runId,run.runId);
    assert.throws(()=>callChatTool(adjustmentContext,"prepare_chat_run_recovery",{runId:run.runId,decision:{...decision,expectedRunVersion:999}}),/expected version/);
    const revised = callChatTool(adjustmentContext,"prepare_chat_run_recovery",{runId:run.runId,decision:{...decision,rationale:"Revised review"}}) as {revision:string};
    assert.equal(adjustmentExecution.status,"running");
    assert.throws(()=>confirmChatRunRecovery(repoRoot,run.runId,prepared.revision,runtimeDirectory),/proposal changed/);
    const accepted = confirmChatRunRecovery(repoRoot,run.runId,revised.revision,runtimeDirectory);
    assert.equal(accepted.status,"accepted"); assert.equal(accepted.run.runId,run.runId);
    assert.equal(confirmChatRunRecovery(repoRoot,run.runId,revised.revision,runtimeDirectory).status,"duplicate");
    assert.equal(runs.decisions(run.runId).length,1);
    assert.equal(inspectChatRunRecovery(repoRoot,run.runId,runtimeDirectory).proposal,null);
    const foreign = dispatch(bob);
    assert.throws(()=>callChatTool(foreign.context,"prepare_chat_run_recovery",{runId:run.runId,decision}),/outside/);
  } finally { governance.close();runs.close();chat.close();runtime.close();database.close();rmSync(runtimeDirectory,{recursive:true,force:true}); }
});
