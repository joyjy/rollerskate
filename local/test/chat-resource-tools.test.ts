import { bindInteractiveChannel, revokeInteractiveChannel } from "../src/application/channel/control.js";
import { InteractiveChannelRuntime } from "../src/application/channel/runtime.js";
import { admitChatWorkReturns } from "../src/application/chat/work-return.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";
import { inspectInteractiveChannelFollow } from "../src/application/channel/query.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { addLocalAgent, suspendLocalAgent } from "../src/application/agent/control.js";
import { postLocalChatMessage } from "../src/application/chat/control.js";
import { callChatTool, createChatToolContext } from "../src/application/chat/tool-policy.js";
import { inspectSubscriptionView } from "../src/application/subscription/query.js";
import { inspectScheduleView } from "../src/application/schedule/query.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { ScheduledTaskStore } from "../src/capabilities/scheduled-task/store.js";
import { ContinuousSubscriptionStore } from "../src/capabilities/subscription/continuous-store.js";
import { SubscriptionStore } from "../src/capabilities/subscription/store.js";
import { chatPromptResourceId } from "../src/core/chat/model.js";
import { localId } from "../src/core/id.js";
import { createHash } from "node:crypto";

test("Chat discovers source-owned resources, controls current state and rejects stale/revoked instructions", async () => {
  const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");
  const runtimeDirectory=mkdtempSync(join(tmpdir(),"rs-chat-resources-"));
  const options={runtimeDirectory};
  const agent=addLocalAgent(repoRoot,"alice","codex",options);
  const database=openRuntimeDatabase(join(runtimeDirectory,"runtime.db"));
  const runtime=new RuntimeStore(database);
  const schedules=new ScheduledTaskStore(database,{migrate:false});
  const continuous=new ContinuousSubscriptionStore(database,{migrate:false});
  const single=new SubscriptionStore(database,{migrate:false});
  const at=()=>new Date().toISOString();
  try {
    const target={schemaVersion:"ProactiveTarget@1",kind:"application_action",actionRef:"action:test/record@1",registrationDigest:`sha256:${"a".repeat(64)}`,input:{}} as const;
    const policy={workspaceRoot:repoRoot,allowedHttpOrigins:[],allowedExecutables:[],allowedEnvironment:[],timeoutMilliseconds:1000,maxOutputBytes:4096};
    const scheduleId=localId("sch"), subscriptionId=localId("sub");
    runtime.withImmediateTransaction(()=>{
      schedules.createTargetedInTransaction({scheduleId,ownerPrincipalId:agent.principalId,kind:"once",expression:"2099-01-01T00:00:00Z",misfirePolicy:"skip",overlapPolicy:"skip",misfireGraceMilliseconds:60000,target});
      continuous.createTargetedInTransaction({subscriptionId,schemaVersion:"ContinuousSubscriptionDefinition@3",revision:1,title:"Test monitor",probe:{plugin:{path:"/registered/test.mjs",id:"test",config:{secret:"not exposed"}},policy},intervalMilliseconds:60000,target});
    });
    const legacy=single.create({schemaVersion:3,revision:"v1",title:"Legacy",ownerAgentId:agent.principalId,
      probe:{plugin:{path:"/registered/test.mjs",id:"test",schemaVersion:1,config:{}},artifactRevision:"v1",artifactDigest:`sha256:${"a".repeat(64)}`,policy},
      intervalMilliseconds:1000,maxWaitMilliseconds:60000,maxAttempts:60,callbacks:[],approvedGrantDigest:createHash("sha256").update("[]").digest("base64url")});
    function makeTurn(body:string) {
    const message=postLocalChatMessage(repoRoot,body,options).message;
    const execution=runtime.claimDueExecutions(100,at()).find(item=>item.eventId===message.eventId)!;
    const dispatch=runtime.admitChatAttention(execution.executionId,[{plan:{agentId:agent.principalId,handle:agent.handle,outcome:"dispatch",reason:"direct-mention",presenceSnapshot:{global:{scope:"global",mode:"available",wakeKeywords:[]},topic:{scope:"topic",mode:"available",wakeKeywords:[]}}},prompt:"fixture",promptResourceId:chatPromptResourceId}],at())[0]!;
    runtime.claimDueExecutions(100,at());
    const call=(name:string,args:unknown)=>callChatTool(createChatToolContext({repoRoot,runtimeDirectory,dispatchEventId:dispatch.eventId}),name,args) as Record<string,unknown>;
    return {message,dispatch,call};
    }
    const {message,dispatch,call}=makeTurn("@alice 暂停这些监控和定时任务，再恢复支持恢复的任务并取消它们。以你的身份向当前 Chat 发送测试消息。");
    for (const [domain,id] of [["schedule",scheduleId],["subscription",subscriptionId],["subscription",legacy.subscriptionId]]) {
      const list=call(`list_${domain}s`,{}) as {items:{id:string}[]};
      assert.ok(list.items.some(item=>item.id===id));
      const initial=call(`get_${domain}`,{id});
      assert.doesNotMatch(JSON.stringify(initial),/not exposed|registered|workspaceRoot/);
      assert.throws(()=>call(`control_${domain}`,{id,action:"pause",expectedState:"0".repeat(64)}),/state changed/);
      const paused=call(`control_${domain}`,{id,action:"pause",expectedState:initial.stateToken});
      assert.equal(paused.status,"paused");
      assert.equal(paused.authoritySourceEventId,message.eventId);
      const read=domain==="schedule" ? inspectScheduleView(repoRoot,id!,runtimeDirectory).summary : inspectSubscriptionView(repoRoot,id!,runtimeDirectory);
      assert.equal(read.status,paused.status);
      assert.throws(()=>call(`control_${domain}`,{id,action:"pause",expectedState:initial.stateToken}),/state changed/);
      if (id===legacy.subscriptionId) {
        assert.throws(()=>call(`control_${domain}`,{id,action:"resume",expectedState:paused.stateToken}),/legacy_trigger_execution_closed/);
      } else {
        const resumed=call(`control_${domain}`,{id,action:"resume",expectedState:paused.stateToken});
        assert.equal(resumed.status,"active");
      }
      const latest=call(`get_${domain}`,{id});
      assert.equal(call(`control_${domain}`,{id,action:"cancel",expectedState:latest.stateToken}).status,"cancelled");
    }

    const binding=bindInteractiveChannel(repoRoot,{agentId:agent.principalId,
      allowedChannelRefs:[{kind:"local-chat",channelId:message.topicId}],expiresAt:new Date(Date.now()+60000).toISOString()},options);
    const channels=call("list_channels",{}) as {items:{binding:{bindingId:string}}[]};
    assert.equal(channels.items[0]?.binding.bindingId,binding.bindingId);
    const sendArgs={bindingId:binding.bindingId,expectedRevision:binding.revision,
      channelRef:{kind:"local-chat",channelId:message.topicId},body:"Owner-requested participant message"};
    const first=call("send_channel_message",sendArgs) as {receipt:{sendId:string;status:string};follow:{followToken:string}};
    assert.equal(first.receipt.status,"pending");
    const repeated=call("send_channel_message",sendArgs) as typeof first;
    assert.equal(repeated.receipt.sendId,first.receipt.sendId);
    assert.throws(()=>call("send_channel_message",{...sendArgs,body:"different side effect"}),/different input/);
    assert.throws(()=>call("send_channel_message",{...sendArgs,channelRef:{kind:"local-chat",channelId:"another"}}),/allowlist/);
    assert.deepEqual(admitChatWorkReturns({repoRoot,runtimeDirectory,database,runtime}).eventIds,[]);
    const channelsRuntime=new InteractiveChannelRuntime(repoRoot,options);
    try {
      await channelsRuntime.runCycle();
      await channelsRuntime.runCycle(new Date(Date.now()+10000).toISOString());
      const settled=call("get_channel_follow",{followToken:first.follow.followToken}) as {receipt:{status:string};follow:{status:string;callback?:unknown}};
      assert.equal(settled.receipt.status,"accepted");
      assert.equal(settled.follow.status,"quiet");
      assert.equal(settled.follow.callback,undefined); // Chat must not receive an agent.request callback
      assert.deepEqual(admitChatWorkReturns({repoRoot,runtimeDirectory,database,runtime}).eventIds,[]); // busy original Session
      const chat=new LocalChatStore(database);
      assert.equal(chat.events(message.topicId).filter(event=>event.type==="chat.message" && event.body===sendArgs.body).length,1);
      chat.close();
      const agentExecution=runtime.executionForEvent(dispatch.eventId)!;
      runtime.completeExecution(agentExecution.executionId,{adapterId:"fixture",workspace:repoRoot,providerSessionId:"resource-session",
        chatDecision:{schema:"ChatDecision@2",speech:{action:"silent",reason:"waiting"},presence:{scope:"topic",mode:"available",wakeKeywords:[]}}},at());
      const freshDatabase=openRuntimeDatabase(join(runtimeDirectory,"runtime.db"));
      const freshRuntime=new RuntimeStore(freshDatabase,{migrate:false});
      try {
        const returned=admitChatWorkReturns({repoRoot,runtimeDirectory,database:freshDatabase,runtime:freshRuntime}).eventIds;
        assert.equal(returned.length,1);
        assert.equal(freshRuntime.event(returned[0]!)?.sessionId,freshRuntime.currentLocalAgentSession(agent.principalId)?.sessionId);
        assert.deepEqual(admitChatWorkReturns({repoRoot,runtimeDirectory,database:freshDatabase,runtime:freshRuntime}).eventIds,[]);
      } finally {freshRuntime.close();freshDatabase.close();}
      assert.equal(inspectInteractiveChannelFollow(repoRoot,first.follow.followToken,runtimeDirectory).receipt.status,"accepted");
    } finally {channelsRuntime.close();}

    const pendingTurn=makeTurn("@alice 请再向当前 Chat 发一条测试消息。");
    const pending=pendingTurn.call("send_channel_message",{...sendArgs,body:"Must not send after revocation"}) as {follow:{followToken:string}};
    revokeInteractiveChannel(repoRoot,binding.bindingId,binding.revision,options);
    const revokedRuntime=new InteractiveChannelRuntime(repoRoot,options);
    try {await revokedRuntime.runCycle();} finally {revokedRuntime.close();}
    const failed=inspectInteractiveChannelFollow(repoRoot,pending.follow.followToken,runtimeDirectory);
    assert.equal(failed.receipt.status,"failed");
    assert.match(failed.receipt.failure!,/authority changed/);
    const revokedRead=pendingTurn.call("get_channel_follow",{followToken:pending.follow.followToken});
    assert.deepEqual(revokedRead.delta,[]);
    suspendLocalAgent(repoRoot,agent.principalId,options);
    assert.throws(()=>pendingTurn.call("control_schedule",{id:scheduleId,action:"resume",expectedState:"0".repeat(64)}),/no longer eligible/);

  } finally {single.close();continuous.close();schedules.close();runtime.close();database.close();rmSync(runtimeDirectory,{recursive:true,force:true});}
});
