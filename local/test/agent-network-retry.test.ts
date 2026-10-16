import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { temporaryDirectory } from "./support/temp-directory.js";
import { AgentHandler } from "../src/core/runtime/handlers.js";
import { AgentInvocationError, AgentNetworkError } from "../src/core/runtime/agent-invocation.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { addLocalAgent } from "../src/application/agent/control.js";
import { postLocalChatMessage } from "../src/application/chat/control.js";
import { ChatHandler } from "../src/application/chat/handler.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const at = "2026-09-15T10:00:00.000Z";
function fixture(kind: "chat" | "run" = "chat") {
  const runtimeDirectory = temporaryDirectory("rollerskate-network-retry-");
  const agent = addLocalAgent(repoRoot,"alice","codex",{runtimeDirectory});
  const database = openRuntimeDatabase(join(runtimeDirectory,"runtime.db"));
  const chat = new LocalChatStore(database);
  const store = new RuntimeStore(database);
  let eventId: string;
  if (kind === "chat") {
    const source = postLocalChatMessage(repoRoot,"@alice 请研究退避",{runtimeDirectory,now:()=>new Date(at)}).message;
    const execution = store.claimDueExecutions(10,at).find(item=>item.eventId===source.eventId)!;
    eventId = new ChatHandler({store,chat,listAgents:()=>[agent]}).handle(execution,at)[0]!;
  } else {
    eventId = store.appendEvent({type:"agent.request",source:{kind:"cli"},agentId:agent.principalId,prompt:"read-only fixture",createdAt:at,maxAttempts:1}).event.eventId;
  }
  return {store,database,chat,eventId,runtimeDirectory,agent,
    close:()=>{chat.close();store.close();database.close();}};
}
function handler(store: RuntimeStore, invoke: ()=>Promise<never> | Promise<{providerSessionId:string;outcome:{kind:"message";body:string}}>) {
  return new AgentHandler({store,adapterForAgent:()=>({adapterId:"fixture",workspace:repoRoot,invoke})});
}

test("Chat network rejections back off durably and produce one reply after recovery", async()=>{
  const f=fixture();
  let active=f.store;
  let calls=0;
  try {
    const invoke=async()=>{
      calls++;
      if (calls===1) throw new AgentInvocationError("HTTP 503 Service unavailable",{
        schemaVersion:"AgentInvocationFailure@1",adapterId:"fixture",workspace:repoRoot,workspaceAccess:"read",
        startedAt:at,observedAt:at,lastMeaningfulAt:at,phase:"terminated",updateCount:1,meaningfulUpdateCount:0,
        failedAt:at,reason:"protocol_error",meaningfulOutputTimeoutMilliseconds:1000,protocolStop:"acknowledged",recovery:"none",rejectedBeforeWork:true
      });
      if (calls===2) throw new AgentNetworkError("HTTP 503 Service unavailable","fixture",repoRoot);
      return {providerSessionId:"fixture-session",outcome:{kind:"message" as const,body:JSON.stringify({schema:"ChatMentionDecision@2",speech:{action:"reply",body:"恢复了"}})}};
    };
    let when=at;
    for(let attempt=1;attempt<=3;attempt++) {
      const execution=active.claimDueExecutions(10,when).find(item=>item.eventId===f.eventId)!;
      assert.equal(execution.attemptCount,attempt);
      await handler(active,invoke).handle(execution,when);
      const current=active.execution(execution.executionId)!;
      if(attempt<3) {
        assert.equal(current.status,"retry_wait");
        assert.equal(current.maxAttempts,5);
        assert.equal(Date.parse(current.nextAttemptAt)-Date.parse(when),5_000*2**(attempt-1));
        assert.equal(active.claimDueExecutions(10,when).some(item=>item.eventId===f.eventId),false);
        when=current.nextAttemptAt;
        if(attempt===1) active=new RuntimeStore(join(f.runtimeDirectory,"runtime.db"));
      } else assert.equal(current.status,"succeeded");
    }
    assert.equal(calls,3);
    assert.equal((f.database.prepare("SELECT count(*) n FROM events WHERE type='chat.message' AND json_extract(payload_json,'$.body')='恢复了'").get() as {n:number}).n,1);
  } finally {if(active!==f.store)active.close();f.close();}
});

test("Run network retries exhaust at five attempts and create only one final failure",async()=>{
  const f=fixture("run");
  try {
    let when=at;
    for(let attempt=1;attempt<=5;attempt++) {
      const execution=f.store.claimDueExecutions(10,when).find(item=>item.eventId===f.eventId)!;
      const result=await handler(f.store,async()=>{throw new AgentNetworkError("ECONNREFUSED provider connection","fixture",repoRoot);}).handle(execution,when);
      const current=f.store.execution(execution.executionId)!;
      assert.equal(current.status,attempt<5?"retry_wait":"failed");
      assert.equal(result?.type,attempt<5?undefined:"agent.result");
      if(attempt<5) assert.equal(Date.parse(current.nextAttemptAt)-Date.parse(when),5_000*2**(attempt-1));
      when=current.nextAttemptAt;
    }
  } finally {f.close();}
});

test("unknown outcomes, auth failures and malformed output are not network retries",async()=>{
  for(const error of [new Error("agent invocation timed out"),new AgentNetworkError("HTTP 403 forbidden","fixture",repoRoot),
    new AgentInvocationError("HTTP 503 after a tool",{schemaVersion:"AgentInvocationFailure@1",adapterId:"fixture",workspace:repoRoot,workspaceAccess:"read",startedAt:at,observedAt:at,lastMeaningfulAt:at,phase:"terminated",updateCount:2,meaningfulUpdateCount:1,lastProgress:{kind:"tool"},failedAt:at,reason:"protocol_error",meaningfulOutputTimeoutMilliseconds:1000,protocolStop:"acknowledged",recovery:"none"})]) {
    const f=fixture();
    try {
      const execution=f.store.claimDueExecutions(10,at).find(item=>item.eventId===f.eventId)!;
      await handler(f.store,async()=>{throw error;}).handle(execution,at);
      assert.equal(f.store.execution(execution.executionId)?.status,"failed");
      assert.equal(f.store.execution(execution.executionId)?.attemptCount,1);
    } finally {f.close();}
  }
});

test("a non-network error after a retried invocation does not inherit the network budget",async()=>{
  const f=fixture();
  try {
    const first=f.store.claimDueExecutions(10,at).find(item=>item.eventId===f.eventId)!;
    await handler(f.store,async()=>{throw new AgentNetworkError("HTTP 429 too many requests","fixture",repoRoot);}).handle(first,at);
    const retryAt=f.store.execution(first.executionId)!.nextAttemptAt;
    const next=f.store.claimDueExecutions(10,retryAt).find(item=>item.eventId===f.eventId)!;
    await handler(f.store,async()=>({providerSessionId:"fixture-session",outcome:{kind:"message",body:"not JSON"}})).handle(next,retryAt);
    assert.equal(f.store.execution(first.executionId)?.status,"failed");
    assert.equal(f.store.execution(first.executionId)?.attemptCount,2);
  } finally {f.close();}
});
