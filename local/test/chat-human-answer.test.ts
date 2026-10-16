import { answerStewardRunFromConsole } from "../src/application/chat/human-control.js";
import { withConsoleStewardApi } from "./helpers/console-steward-api.js";
import { answerRunHumanInTransaction } from "../src/application/steward/human-input.js";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname,join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { addLocalAgent, suspendLocalAgent } from "../src/application/agent/control.js";
import { postLocalChatMessage } from "../src/application/chat/control.js";
import { ChatHandler } from "../src/application/chat/handler.js";
import { callChatTool,createChatToolContext } from "../src/application/chat/tool-policy.js";
import { admitChatWorkReturns } from "../src/application/chat/work-return.js";
import { inspectStewardWork } from "../src/application/steward/work-query.js";
import { StewardModule } from "../src/application/steward/module.js";
import { AgentHandler,ResultHandler,type RuntimeAgentAdapter } from "../src/core/runtime/handlers.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { AgentRunStore } from "../src/infrastructure/sqlite/agent-run-store.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { chatPromptResourceId } from "../src/core/chat/model.js";

for (const scenario of ["resume","initial","terminal","cancel","expire","suspend","lost-session","console","console-rollback","console-cancel"] as const) test(`Chat human answer ${scenario} preserves the exact Run checkpoint`,async()=>{
  const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");
  const runtimeDirectory=mkdtempSync(join(tmpdir(),"rs-human-answer-"));
  const options={runtimeDirectory};
  const lead=addLocalAgent(repoRoot,"codex","codex",options);
  const participants = [lead,...(scenario.startsWith("console") ? [addLocalAgent(repoRoot,"bystander","codex",options)] : [])];
  let database=openRuntimeDatabase(join(runtimeDirectory,"runtime.db"));
  let runtime=new RuntimeStore(database),runs=new AgentRunStore(database),chat=new LocalChatStore(database);
  const now=()=>new Date().toISOString();
  let chatHandler=new ChatHandler({store:runtime,chat,listAgents:()=>participants});
  function ownerTurn(body:string) {
    const message=postLocalChatMessage(repoRoot,body,options).message;
    const attention=runtime.claimDueExecutions(100,now()).find(e=>e.eventId===message.eventId)!;
    const event=runtime.admitChatAttention(attention.executionId,[{plan:{agentId:lead.principalId,handle:lead.handle,outcome:"dispatch",reason:"direct-mention",
      presenceSnapshot:{global:{scope:"global",mode:"available",wakeKeywords:[]},topic:{scope:"topic",mode:"available",wakeKeywords:[]}}},prompt:"fixture",promptResourceId:chatPromptResourceId}],now())[0]!;
    const execution=runtime.claimDueExecutions(100,now()).find(e=>e.eventId===event.eventId)!;
    return {event,execution,context:createChatToolContext({repoRoot,runtimeDirectory,dispatchEventId:event.eventId})};
  }
  function finishChat(executionId:string,body?:string) {
    return runtime.completeExecution(executionId,{adapterId:"chat-fixture",workspace:repoRoot,providerSessionId:"parent-chat",
      chatDecision:{schema:"ChatDecision@2",speech:body===undefined?{action:"silent",reason:"waiting"}:{action:"reply",body},presence:{scope:"topic",mode:"available",wakeKeywords:[]}}},now());
  }
  let runId="", workerCalls=0,orchestratorCalls=0;
  const state={schemaVersion:"OrchestratorState@1",goal:"Compare A and B",tasks:[],acceptedEvidence:["Initial research completed"],unresolvedQuestions:[]};
  const adapter:RuntimeAgentAdapter={adapterId:"run-fixture",workspace:repoRoot,async invoke(input){
    if(input.event.type!=="agent.request") throw new Error("Unexpected input");
    let body:unknown;
    if(input.event.runContext?.resultContractId==="agent-step-result@1") {
      workerCalls++;body={schemaVersion:"AgentStepResult@1",outcome:"succeeded",summary:"A and B researched",artifactRefs:[]};
    } else {
      orchestratorCalls++;
      const common={schemaVersion:"RunDecision@6",expectedRunVersion:runs.requireProjection(runId).version,rationale:"Use existing evidence",checkedAcceptance:[],state};
      if(scenario==="initial" && orchestratorCalls===1) body={...common,action:"ask_human",question:"选择 A 还是 B？"};
      else if(scenario==="terminal" && orchestratorCalls===2) body={...common,action:"needs_human"};
      else if(orchestratorCalls===1) body={...common,action:"next_step",nextStep:{target:{kind:"self"},mandate:{kind:"objective",objective:"Research A and B once"}}};
      else if(orchestratorCalls===2 && scenario!=="initial") body={...common,action:"ask_human",question:"选择 A 还是 B？"};
      else {
        assert.match(input.event.prompt,/选择 A，继续/);
        assert.match(input.event.prompt,/Initial research completed/);
        if(scenario!=="initial") assert.match(input.event.prompt,/A and B researched/);
        assert.equal(input.event.sessionId,runtime.sessionForRunAgent(runId,lead.principalId)?.sessionId);
        body={...common,checkedAcceptance: (runs.requireProjection(runId).orchestratorBinding as import("../src/modules/steward/run-contract-v3.js").StewardOrchestratorBindingV3).acceptanceContract!.items.map(item => ({id:item.id,status:"pass",evidenceRefs:["fixture:chosen-A"]})),action:"finish",finish:{scope:"run",outcome:"succeeded",summary:"Applied choice A using the completed research"}};
      }
    }
    return {providerSessionId:"run-session",outcome:{kind:"message",body:JSON.stringify(body)}};
  }};
  let manifest=new StewardModule({runtime,runs}).manifest();
  let agents=new AgentHandler({store:runtime,adapters:new Map([[lead.principalId,adapter]]),executionGuards:manifest.executionGuards});
  let results=new ResultHandler(runtime,manifest.resultContinuations);
  async function executeRunTurn() {
    const execution=runtime.claimDueExecutions(100,now()).find(e=>e.handler==="agent")!;
    assert.ok(execution,"queued Run turn");await agents.handle(execution,now());
    const result=runtime.claimDueExecutions(100,now()).find(e=>e.handler==="result")!;
    assert.ok(result,"queued result");results.handle(result,now());
  }
  try {
    const first=ownerTurn("@codex 研究 A/B 方案，选型时问我，然后完成结论。");
    runId=(callChatTool(first.context,"start_chat_run",{desiredEffect:"none"}) as {runId:string}).runId;
    finishChat(first.execution.executionId);
    await executeRunTurn();if(scenario!=="initial") {await executeRunTurn();await executeRunTurn();}
    const waiting=inspectStewardWork(repoRoot,runId,runtimeDirectory);
    if(scenario==="terminal") {assert.equal(waiting.terminal,true);assert.equal(waiting.status,"needs_human");assert.equal(waiting.humanQuestion,null);return;}
    assert.equal(waiting.terminal,false);assert.equal(waiting.humanQuestion?.status,"pending");assert.equal(workerCalls,scenario==="initial"?0:1);
    const checkpoint=runs.requireProjection(runId).checkpoint;
    if(scenario!=="initial") assert.ok(checkpoint);
    // Restart all domain/Runtime handles after durable suspension.
    chat.close();runs.close();runtime.close();database.close();
    database=openRuntimeDatabase(join(runtimeDirectory,"runtime.db"));
    runtime=new RuntimeStore(database);runs=new AgentRunStore(database);chat=new LocalChatStore(database);
    chatHandler=new ChatHandler({store:runtime,chat,listAgents:()=>participants});
    manifest=new StewardModule({runtime,runs}).manifest();
    agents=new AgentHandler({store:runtime,adapters:new Map([[lead.principalId,adapter]]),executionGuards:manifest.executionGuards});
    results=new ResultHandler(runtime,manifest.resultContinuations);
    assert.equal(inspectStewardWork(repoRoot,runId,runtimeDirectory).humanQuestion?.questionId,waiting.humanQuestion!.questionId);

    if (scenario.startsWith("console")) {
      const question = waiting.humanQuestion!;
      const originalSession = runtime.sessionForRunAgent(runId,lead.principalId)!;
      const ownerMessages = () => database.prepare("SELECT event_id FROM events WHERE type = 'chat.message' AND json_extract(payload_json, '$.sender.kind') = 'owner'")
        .all() as {event_id:string}[];
      const before = ownerMessages();
      const projectionBefore = runs.requireProjection(runId);
      const rootEventsBefore = runtime.eventsForRoot(projectionBefore.rootEventId).length;
      const body = {questionId:question.questionId,expectedVersion:question.runVersion,answer:"选择 A，继续。"};
      const path = `/api/runs/${runId}`;
      await withConsoleStewardApi(repoRoot,runtimeDirectory,async post => {
        const missingMarker = await post(`${path}/answer`,body,"untrusted");
        assert.equal(missingMarker.status,403);
        const stale = await post(`${path}/answer`,{...body,expectedVersion:question.runVersion+1});
        assert.equal(stale.status,400);assert.match(String(stale.body.error),/version changed/);
        const wrongQuestion = await post(`${path}/answer`,{...body,questionId:"evt_other_question"});
        assert.equal(wrongQuestion.status,400);assert.match(String(wrongQuestion.body.error),/no longer pending/);
        assert.deepEqual(ownerMessages(),before);
        assert.deepEqual(runs.requireProjection(runId),projectionBefore);
        if (scenario === "console-cancel") {
          const missingVersion = await post(`${path}/cancel`,{});
          assert.equal(missingVersion.status,400);assert.match(String(missingVersion.body.error),/expectedVersion/);
          const staleCancel = await post(`${path}/cancel`,{expectedVersion:question.runVersion+1});
          assert.equal(staleCancel.status,400);assert.match(String(staleCancel.body.error),/version/i);
          assert.deepEqual(runs.requireProjection(runId),projectionBefore);
          assert.equal((await post(`${path}/cancel`,{expectedVersion:question.runVersion})).status,200);
          assert.equal(runs.requireProjection(runId).status,"cancelled");
          assert.deepEqual(ownerMessages(),before);
          return;
        }
        if (scenario === "console-rollback") {
          // A real domain failure occurs after the Console adapter inserts the Owner message.
          suspendLocalAgent(repoRoot,lead.principalId,options);
          assert.throws(() => answerStewardRunFromConsole(repoRoot,runId,question.questionId,
            question.runVersion,body.answer,runtimeDirectory),/not active/);
          const failed = await post(`${path}/answer`,body);
          assert.equal(failed.status,400);assert.match(String(failed.body.error),/not active/);
          assert.deepEqual(ownerMessages(),before,"the Owner message insert must roll back with continuation failure");
          assert.deepEqual(runs.requireProjection(runId),projectionBefore);
          assert.equal(runtime.eventsForRoot(projectionBefore.rootEventId).length,rootEventsBefore);
          assert.equal(inspectStewardWork(repoRoot,runId,runtimeDirectory).humanQuestion?.status,"pending");
          return;
        }
        const accepted = await post(`${path}/answer`,body);
        assert.equal(accepted.status,200,JSON.stringify(accepted.body));
        assert.equal(accepted.body.status,"accepted");
        assert.equal(accepted.body.runId,runId);
        const continuation = runtime.event(String(accepted.body.eventId));
        assert.equal(continuation?.type,"agent.request");
        if (continuation?.type !== "agent.request") throw new Error("Expected Run continuation");
        assert.equal(continuation.sessionId,originalSession.sessionId);
        assert.equal(continuation.agentId,lead.principalId);
        assert.equal(continuation.runContext?.runId,runId);
        assert.deepEqual(runs.requireProjection(runId).checkpoint,checkpoint);
        const added = ownerMessages().filter(row=>!before.some(old=>old.event_id===row.event_id));
        assert.equal(added.length,1);
        const message = runtime.event(added[0]!.event_id);
        assert.equal(message?.type,"chat.message");
        if (message?.type !== "chat.message") throw new Error("Expected Owner answer");
        assert.equal(message.body,body.answer);
        assert.equal(message.replyToEventId,first.event.sourceMessageEventId);
        assert.deepEqual(message.targets,[{principalId:lead.principalId,handleSnapshot:lead.handle}]);
        assert.match(continuation.prompt,new RegExp(message.eventId));
        const repeated = await post(`${path}/answer`,body);
        assert.equal(repeated.status,400);
        assert.equal(ownerMessages().length,before.length+1,"a stale repeat creates no second Owner answer");
        await executeRunTurn();
        assert.equal(runs.requireProjection(runId).status,"succeeded");
        assert.equal(workerCalls,1);assert.equal(orchestratorCalls,3);
        const attention = runtime.executionForEvent(message.eventId)!;
        const dispatchIds = chatHandler.handle(attention,now());
        assert.equal(dispatchIds.length,1,"the Owner answer does not broadcast to the bystander");
        const responsibleDispatch = runtime.event(dispatchIds[0]!);
        assert.equal(responsibleDispatch?.type,"chat.dispatch");
        if (responsibleDispatch?.type === "chat.dispatch") assert.equal(responsibleDispatch.agentId,lead.principalId);
      });
      return;
    }

    const returned=admitChatWorkReturns({repoRoot,runtimeDirectory,database,runtime}).eventIds;
    assert.equal(returned.length,1);
    const activation=runtime.claimDueExecutions(100,now()).find(e=>e.eventId===returned[0])!;
    const dispatch=chatHandler.handle(activation,now())[0]!;
    const response=runtime.claimDueExecutions(100,now()).find(e=>e.eventId===dispatch)!;
    const reply=finishChat(response.executionId,waiting.humanQuestion!.question)!;
    chatHandler.handle(runtime.claimDueExecutions(100,now()).find(e=>e.eventId===reply.eventId)!,now());
    const answer=ownerTurn("@codex 选择 A，继续。");
    const args={runId,action:"answer",questionId:waiting.humanQuestion!.questionId,expectedVersion:waiting.humanQuestion!.runVersion};
    assert.throws(()=>callChatTool(answer.context,"control_chat_run",{...args,answer:"model replacement"}),/malformed/);
    assert.throws(()=>callChatTool(answer.context,"control_chat_run",{...args,expectedVersion:999}),/version/);
    if(scenario==="cancel") {
      callChatTool(answer.context,"control_chat_run",{runId,action:"cancel",expectedVersion:args.expectedVersion});
      assert.throws(()=>callChatTool(answer.context,"control_chat_run",args),/closed/);
      assert.equal(runs.requireProjection(runId).status,"cancelled");return;
    }
    if(scenario==="expire") {
      assert.throws(()=>runtime.withImmediateTransaction(()=>answerRunHumanInTransaction({runtime,runs,run:runs.requireProjection(runId),
        questionId:args.questionId,expectedVersion:args.expectedVersion,sourceMessageEventId:answer.event.sourceMessageEventId!,at:waiting.humanQuestion!.expiresAt})),/expired/);
      assert.deepEqual(runs.requireProjection(runId).checkpoint,checkpoint);return;
    }
    if(scenario==="suspend") {
      suspendLocalAgent(repoRoot,lead.principalId,options);
      assert.throws(()=>callChatTool(answer.context,"control_chat_run",args),/no longer eligible/);
      assert.deepEqual(runs.requireProjection(runId).checkpoint,checkpoint);return;
    }
    if (scenario === "lost-session") {
      const session = runtime.sessionForRunAgent(runId, lead.principalId)!;
      // Fixture corruption: the checkpoint survives but its original Session is lost.
      database.exec("PRAGMA foreign_keys = OFF");
      database.prepare("DELETE FROM agent_sessions WHERE session_id = ?").run(session.sessionId);
      database.exec("PRAGMA foreign_keys = ON");
      assert.throws(() => callChatTool(answer.context, "control_chat_run", args), /Session is unavailable/);
      assert.deepEqual(runs.requireProjection(runId).checkpoint, checkpoint);
      assert.equal(inspectStewardWork(repoRoot, runId, runtimeDirectory).humanQuestion?.status, "pending");
      assert.equal(workerCalls, 1);
      return;
    }
    const accepted=callChatTool(answer.context,"control_chat_run",args) as {status:string;eventId:string};
    assert.equal(accepted.status,"accepted");
    const repeated=callChatTool(createChatToolContext({repoRoot,runtimeDirectory,dispatchEventId:answer.event.eventId}),"control_chat_run",args) as typeof accepted;
    assert.equal(repeated.status,"already_answered");assert.equal(repeated.eventId,accepted.eventId);
    assert.deepEqual(runs.requireProjection(runId).checkpoint,checkpoint);
    finishChat(answer.execution.executionId);
    await executeRunTurn();
    assert.equal(runs.requireProjection(runId).status,"succeeded",JSON.stringify(inspectStewardWork(repoRoot,runId,runtimeDirectory)));assert.equal(workerCalls,scenario==="initial"?0:1);assert.equal(orchestratorCalls,scenario==="initial"?2:3);
    assert.equal(admitChatWorkReturns({repoRoot,runtimeDirectory,database,runtime}).eventIds.length,1);
  } finally {chat.close();runs.close();runtime.close();database.close();rmSync(runtimeDirectory,{recursive:true,force:true});}
});
