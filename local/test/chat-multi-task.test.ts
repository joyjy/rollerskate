import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { addLocalAgent } from "../src/application/agent/control.js";
import { postLocalChatMessage, localChatView } from "../src/application/chat/control.js";
import { ChatHandler } from "../src/application/chat/handler.js";
import { callChatTool, createChatToolContext } from "../src/application/chat/tool-policy.js";
import { chatTaskClaims } from "../src/application/chat/responsibility.js";
import { projectChatRunProposal } from "../src/application/chat/run-proposal.js";
import { confirmLocalChatRunProposal } from "../src/application/chat/run-proposal-control.js";
import { admitChatWorkReturns } from "../src/application/chat/work-return.js";
import { cancelStewardRun } from "../src/application/steward/control.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";

test("two Agents claim four independent tasks, with task-level dedupe, proposals and exact returns", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const runtimeDirectory = mkdtempSync(join(tmpdir(),"rollerskate-multi-task-"));
  const options = {runtimeDirectory};
  const agents = [addLocalAgent(repoRoot,"alice","codex",options),addLocalAgent(repoRoot,"bob","pi",options)];
  const database = openRuntimeDatabase(join(runtimeDirectory,"runtime.db"));
  const runtime = new RuntimeStore(database), chat = new LocalChatStore(database);
  const tasks = ["研究排序边界", "研究缓存语义", "研究错误恢复", "检查项目文件"] as const;
  try {
    const source = postLocalChatMessage(repoRoot,`@alice @bob 各自认领剩余任务：${tasks.join("；")}。请执行并分别报告。`,options).message;
    const execution = runtime.claimDueExecutions(100).find(item=>item.eventId===source.eventId)!;
    const ids = new ChatHandler({store:runtime,chat,listAgents:()=>agents}).handle(execution);
    const executions = runtime.claimDueExecutions(100);
    const contexts = agents.map(agent => createChatToolContext({repoRoot,runtimeDirectory,dispatchEventId:ids.find(id=>runtime.event(id)?.agentId===agent.principalId)!}));
    const start = (index:number,taskQuote:string,desiredEffect="none") => callChatTool(contexts[index]!,"start_chat_run",{desiredEffect,taskQuote}) as {status:string;runId:string};
    const first = start(0,tasks[0]!);
    assert.equal(first.status,"accepted");
    assert.deepEqual(start(1,"排序边界").runId,first.runId); // overlapping quote, different Agent
    assert.throws(()=>start(1,"不存在的任务"),/exactly once/);
    assert.equal(start(1,tasks[3]!,"read").status,"needs_authorization");
    const second = start(1,tasks[1]!);
    const third = start(1,tasks[2]!); // same Agent/dispatch can own another task
    assert.equal(second.status,"accepted"); assert.equal(third.status,"accepted");
    assert.equal(new Set([first.runId,second.runId,third.runId]).size,3);
    assert.equal(start(0,tasks[2]!).runId,third.runId);
    assert.equal(chatTaskClaims(database,source.eventId).length,3);
    for (const [i,context] of contexts.entries()) {
      const dispatchExecution = executions.find(item=>item.eventId===context.dispatchEventId)!;
      runtime.completeExecution(dispatchExecution.executionId,{
        adapterId:"fixture",workspace:repoRoot,providerSessionId:`multi-session-${i}`,
        chatDecision:{schema:"ChatMentionDecision@2",speech:i===1 ? {action:"propose_run",proposal:{
          schema:"ChatRunProposalDraft@1",taskQuote:tasks[3],goal:tasks[3],scope:{include:[tasks[3]],exclude:[]},acceptance:["报告文件检查结果"],desiredEffect:"read"
        }} : {action:"propose_run",proposal:{schema:"ChatRunProposalDraft@1",goal:"另一项工作",scope:{include:["另一项工作"],exclude:[]},acceptance:["报告"],desiredEffect:"none"}}}
      });
    }
    const project = () => projectChatRunProposal({repoRoot,runtimeDirectory,database,message:source,agents,dispatchEventId:contexts[1]!.dispatchEventId!,workspaceSelection:{kind:"path",path:repoRoot}})!;
    const missingIdentity = projectChatRunProposal({repoRoot,runtimeDirectory,database,message:source,agents,dispatchEventId:contexts[0]!.dispatchEventId!})!;
    assert.equal(missingIdentity.view.linkedRun,undefined);
    assert.equal(missingIdentity.view.blocker?.code,"clarification_required");
    const proposal = project();
    assert.equal(proposal.view.ready,true); assert.equal(proposal.view.linkedRun,undefined);
    const fourth = confirmLocalChatRunProposal(repoRoot,source.eventId,contexts[1]!.dispatchEventId!,proposal.view.revision,options,{kind:"path",path:repoRoot});
    assert.equal(fourth.status,"accepted");
    assert.equal(project().view.linkedRun?.runId,fourth.run.runId);
    const claims = chatTaskClaims(database,source.eventId);
    assert.equal(claims.length,4);
    assert.deepEqual(new Set(claims.map(claim=>claim.taskQuote)),new Set(tasks));
    const card = localChatView(repoRoot,options).messages.items.find(item=>item.eventId===source.eventId)!;
    assert.equal(card.works!.filter(work=>work.kind==="agent").length,3);
    assert.equal(card.runProposals?.find(p=>p.dispatchEventId===contexts[1]!.dispatchEventId)?.linkedRun?.runId,fourth.run.runId);
    // Same-dispatch Runs retain independent callback identity.
    cancelStewardRun(repoRoot,third.runId,runtimeDirectory);
    const returned = admitChatWorkReturns({repoRoot,runtimeDirectory,database,runtime});
    assert.equal(returned.eventIds.length,1);
    const activationExecution = runtime.claimDueExecutions(100).find(item=>item.eventId===returned.eventIds[0])!;
    const [returnId] = new ChatHandler({store:runtime,chat,listAgents:()=>agents}).handle(activationExecution);
    runtime.claimDueExecutions(100);
    const callbackContext = createChatToolContext({repoRoot,runtimeDirectory,dispatchEventId:returnId!});
    const duplicate = callChatTool(callbackContext,"start_chat_run",{desiredEffect:"none",taskQuote:tasks[0]}) as {runId:string;status:string};
    assert.equal(duplicate.status,"duplicate"); assert.equal(duplicate.runId,third.runId);
    assert.equal(chatTaskClaims(database,source.eventId).length,4);
  } finally {chat.close();runtime.close();database.close();rmSync(runtimeDirectory,{recursive:true,force:true});}
});
