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

test("one Owner message elects one supported Steward and shares admitted Workers without duplicate Runs", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const runtimeDirectory = mkdtempSync(join(tmpdir(),"rollerskate-chat-responsibility-"));
  const alice = addLocalAgent(repoRoot,"alice","pi",{runtimeDirectory});
  const bob = addLocalAgent(repoRoot,"bob","codex",{runtimeDirectory});
  const database = openRuntimeDatabase(join(runtimeDirectory,"runtime.db"));
  const runtime = new RuntimeStore(database);
  const chat = new LocalChatStore(database);
  try {
    const message = postLocalChatMessage(repoRoot,`@alice @bob 请整理结论，由一人负责整合。只读 workspacePath=${repoRoot}`,{runtimeDirectory}).message;
    const execution = runtime.claimDueExecutions(100).find(item=>item.eventId===message.eventId)!;
    const ids = new ChatHandler({store:runtime,chat,listAgents:()=>[alice,bob]}).handle(execution);
    runtime.claimDueExecutions(100);
    const context = (agentId:string) => createChatToolContext({repoRoot,runtimeDirectory,
      dispatchEventId:ids.find(id=>runtime.event(id)?.agentId === agentId)!});
    const bobContext = context(bob.principalId);
    const deferred = callChatTool(bobContext,"start_chat_run",{desiredEffect:"read",workspacePath:repoRoot}) as {status:string;agentId:string};
    assert.equal(deferred.status,"responsible_agent");
    assert.equal(deferred.agentId,alice.principalId);
    const accepted = callChatTool(context(alice.principalId),"start_chat_run",{desiredEffect:"read",workspacePath:repoRoot}) as {status:string;runId:string;authority:{participantAgentIds:string[]}};
    assert.equal(accepted.status,"accepted");
    const duplicate = callChatTool(bobContext,"start_chat_run",{desiredEffect:"read",workspacePath:repoRoot}) as typeof accepted;
    assert.equal(duplicate.status,"duplicate");
    assert.equal(duplicate.runId,accepted.runId);
    const run = database.prepare("SELECT steward_agent_id FROM agent_runs WHERE run_id = ?").get(accepted.runId) as {steward_agent_id:string;authority_json?:string};
    assert.equal(run.steward_agent_id,alice.principalId);
    assert.deepEqual(new Set(accepted.authority.participantAgentIds),new Set([alice.principalId,bob.principalId]));
    assert.equal((database.prepare("SELECT count(*) AS n FROM agent_runs").get() as {n:number}).n,1);
  } finally {chat.close();runtime.close();database.close();rmSync(runtimeDirectory,{recursive:true,force:true});}
});
