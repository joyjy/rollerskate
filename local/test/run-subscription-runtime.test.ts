import {NotificationControlStore} from "../src/capabilities/subscription/notification-control-store.js";
import {setNotificationControlInTransaction,notificationControlSnapshot} from "../src/application/subscription/notification-control.js";
import {resolveStewardRunPush} from "../src/application/steward/result-destination.js";
import {AgentRunStore} from "../src/infrastructure/sqlite/agent-run-store.js";
import assert from "node:assert/strict";
import test from "node:test";

import { RunSubscriptionRuntime, runSubscriptionPushSource } from
  "../src/application/subscription/run-monitor.js";
import { startStewardRunFromIntent } from
  "../src/application/steward/intent-control.js";
import { cancelStewardRun } from "../src/application/steward/control.js";
import { RunMonitorStore, runMonitorSubscriptionId } from
  "../src/capabilities/subscription/run-monitor-store.js";
import { DeliveryHandler } from "../src/core/runtime/handlers.js";
import { runtimeId } from "../src/core/runtime/model.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { CodexDesktopDestinationAdapter } from
  "../src/integrations/codex-desktop/push.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { LocalFoundationStore, bootstrapLocalFoundation } from
  "../src/infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { temporaryDirectory } from "./support/temp-directory.js";

const T0 = "2026-10-16T02:00:00.000Z";
const T1 = "2026-10-16T02:01:00.000Z";
const T2 = "2026-10-16T02:02:00.000Z";
const THREAD = "01a13915-bb1c-7c51-bfd8-ed88bb2ccd67";

test("Run admission binds one monitor and Desktop accepted/terminal notices keep their origins", async () => {
  const f = fixture();
  try {
    const started = startStewardRunFromIntent(f.repo, intent("monitor-accepted", f.destinationId),
      f.runtimeDirectory, T0);
    const subscriptionId = started.subscriptionId!;
    const repeated = startStewardRunFromIntent(f.repo, intent("monitor-accepted", f.destinationId),
      f.runtimeDirectory, T0);
    assert.equal(subscriptionId, runMonitorSubscriptionId(started.run.runId));
    assert.equal(repeated.subscriptionId, subscriptionId);
    assert.equal(f.subscriptions.list().length, 1);
    assert.equal(f.monitor("boot-1", T0).runCycle(T1).notifications.length, 1);
    const [accepted] = f.noticeDeliveries();
    assert.ok(accepted);
    assert.equal(accepted.origin.id, `run-subscription:${subscriptionId}:${f.subscriptions.get(subscriptionId)!.observedKey}`);
    const claimed = f.runtime.claimDueDeliveries(10, T1).find(d => d.deliveryId === accepted.deliveryId)!;
    const pushed: string[] = [];
    const adapter = new CodexDesktopDestinationAdapter(input => runSubscriptionPushSource(f.database)(input) ??
      resolveStewardRunPush(new AgentRunStore(f.database,{migrate:false}),input), async (thread, body) => {
      assert.equal(thread, THREAD);
      pushed.push(body);
      return JSON.stringify({schema: "CodexPushReceipt@1", threadId: thread, status: "accepted",
        messageId: "monitor-message", ownerClientId: "owner", turnId: "turn"});
    });
    const handler = new DeliveryHandler({store: f.runtime, adapters: new Map([[adapter.kind, adapter]])});
    assert.equal((await handler.handle(claimed, T1)).status, "delivered");
    assert.match(pushed[0]!, /accepted/);
    f.monitor("boot-1", T0).runCycle(T1);
    assert.equal(f.noticeDeliveries().length, 1);

    cancelStewardRun(f.repo, started.run.runId, f.runtimeDirectory, T2);
    f.monitor("boot-2", T2).runCycle(T2); // restart after cancellation, before observer had enqueued its notice
    const terminal = f.runtime.deliveriesForDestinationKind("codex-desktop")
      .filter(d => d.origin.id === `steward-run:${started.run.runId}:run:terminal`);
    assert.equal(terminal.length, 1);
    f.monitor("boot-1", T0).runCycle(T2);
    assert.equal(f.runtime.deliveriesForDestinationKind("codex-desktop")
      .filter(d => d.origin.id === terminal[0]!.origin.id).length, 1);
    const terminalClaim = f.runtime.claimDueDeliveries(10,T2).find(row => row.deliveryId === terminal[0]!.deliveryId)!;
    assert.equal((await handler.handle(terminalClaim,T2)).status,"delivered");
    f.monitor("boot-2",T2).runCycle(T2);
    assert.equal(f.subscriptions.get(subscriptionId)?.status,"completed");
  } finally { f.close(); }
});

test("restart deduplicates unchanged state without replaying Run work; unknown Desktop result blocks without resend", async () => {
  const f = fixture();
  try {
    const started = startStewardRunFromIntent(f.repo, intent("monitor-restart", f.destinationId),
      f.runtimeDirectory, T0);
    const subscriptionId = started.subscriptionId!;
    f.monitor("boot-1", T0).runCycle(T1);
    const executionCount = (f.database.prepare("SELECT count(*) AS n FROM executions").get() as {n:number}).n;
    const restarted = new RunSubscriptionRuntime({database:f.database, repoRoot:f.repo,
      runtimeDirectory:f.runtimeDirectory, runtimeIdentity:"boot-2", startedAt:T2});
    restarted.recover(T2);
    restarted.runCycle(T2);
    assert.equal((f.database.prepare("SELECT count(*) AS n FROM executions").get() as {n:number}).n,
      executionCount);
    assert.equal(f.noticeDeliveries().length, 1);
    const resumed = f.noticeDeliveries()[0]!;
    assert.equal(f.subscriptions.get(subscriptionId)?.runtimeIdentity, "boot-2");
    const claimed = f.runtime.claimDueDeliveries(10, T2).find(d => d.deliveryId === resumed.deliveryId)!;
    const adapter = new CodexDesktopDestinationAdapter(runSubscriptionPushSource(f.database), async () => {
      throw new Error("Desktop transport outcome unknown");
    });
    const handler = new DeliveryHandler({store:f.runtime, adapters:new Map([[adapter.kind, adapter]])});
    assert.equal((await handler.handle(claimed, T2)).status, "failed");
    const before = f.noticeDeliveries().length;
    assert.ok(restarted.runCycle(T2).blocked.includes(subscriptionId));
    assert.equal(f.subscriptions.get(subscriptionId)?.status, "blocked");
    assert.equal(f.noticeDeliveries().length, before);
    assert.deepEqual(f.runtime.claimDueDeliveries(10, T2), []);
  } finally { f.close(); }
});

test("a Run without immutable return target retains an explicit blocked monitor", () => {
  const f = fixture();
  try {
    const started = startStewardRunFromIntent(f.repo, intent("monitor-unbound"),
      f.runtimeDirectory, T0);
    const subscriptionId = started.subscriptionId!;
    assert.equal(f.monitor("boot-1", T0).runCycle(T1).blocked[0], subscriptionId);
    assert.equal(f.subscriptions.get(subscriptionId)?.status, "blocked");
    assert.match(f.subscriptions.get(subscriptionId)?.latestError ?? "", /origin_session_unbound/);
    assert.equal(f.noticeDeliveries().length, 0);
  } finally { f.close(); }
});


test("an exhausted Execution is reported while its Run still awaits orchestration", () => {
  const f = fixture();
  try {
    const started = startStewardRunFromIntent(f.repo, intent("monitor-failed",f.destinationId),f.runtimeDirectory,T0);
    const monitor = f.monitor("boot-1",T0);
    monitor.runCycle(T0);
    const execution = f.runtime.claimDueExecutions(10,T1).find(row => row.executionId === started.executionId)!;
    f.runtime.failExecution(execution.executionId,"provider unavailable: api_key=private-test-secret",T1);
    // Historical incident: continuation left the Run awaiting orchestration rather than terminal.
    f.database.prepare("UPDATE agent_runs SET status='awaiting_orchestrator', active_execution_id=NULL, updated_at=? WHERE run_id=?").run(T1,started.run.runId);
    monitor.runCycle(T1);
    const notice = f.noticeDeliveries().find(row => row.payload.status === "execution_failed");
    assert.ok(notice);
    assert.match(String(notice.payload.body),/provider unavailable/);
    assert.equal(String(notice.payload.body).includes("private-test-secret"),false);
    monitor.runCycle(T2);
    assert.equal(f.noticeDeliveries().filter(row => row.payload.status === "execution_failed").length,1);
  } finally { f.close(); }
});

function intent(requestId: string, destinationId?: string) {
  return {
    schemaVersion: "RunIntent@1", requestId, objective: "Observe this admitted Run",
    acceptance: ["Owner sees the outcome"], contextRefs: [], triggerIntent: "cron",
    requestedParticipantRefs: ["agent:worker"], terminalEvidence: ["Run receipt"],
    ...(destinationId === undefined ? {} : {resultDestinationRef:`destination:${destinationId}`})
  } as const;
}

function fixture() {
  const repo = temporaryDirectory("rollerskate-run-monitor-repo-");
  const runtimeDirectory = temporaryDirectory("rollerskate-run-monitor-runtime-");
  const paths = runtimePaths(repo, runtimeDirectory);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths, T0);
  const foundation = new LocalFoundationStore(paths.database);
  foundation.addAgent("codex", "codex", T0);
  foundation.addAgent("worker", "codex", T0);
  foundation.close();
  const database = openRuntimeDatabase(paths.database);
  const runtime = new RuntimeStore(database);
  const subscriptions = new RunMonitorStore(database);
  const destinationId = runtimeId("dst");
  const registration = runtime.enqueueHostDelivery({originId:"register-monitor-desktop",
    destinationId,kind:"codex-desktop",address:{threadId:THREAD},payload:{body:"fixture"},at:T0});
  runtime.claimDueDeliveries(1,T0);
  runtime.deliverySucceeded(registration.deliveryId,"fixture receipt",T0);
  return {repo,runtimeDirectory,database,runtime,subscriptions,destinationId,
    monitor(runtimeIdentity:string, startedAt:string) {
      return new RunSubscriptionRuntime({database,repoRoot:repo,runtimeDirectory,runtimeIdentity,startedAt});
    },
    noticeDeliveries() {
      return runtime.deliveriesForDestinationKind("codex-desktop")
        .filter(d => d.origin.id.startsWith("run-subscription:"));
    },
    close() {runtime.close();database.close();}
  };
}


test('Owner thread mute holds queued messages without consuming attempts and close survives restart',async()=>{
  const f=fixture();
  try {
    const started=startStewardRunFromIntent(f.repo,intent('control-mute',f.destinationId),f.runtimeDirectory,T0);
    f.monitor('boot-1',T0).runCycle(T1);
    const original=f.noticeDeliveries()[0]!;
    f.runtime.withImmediateTransaction(()=>setNotificationControlInTransaction(f.database,'codex-thread',THREAD,'muted','Owner pause',T1));
    let sent=0;
    const adapter={kind:'codex-desktop' as const,async deliver(){sent++;return {receipt:'accepted'};}};
    const handler=new DeliveryHandler({store:f.runtime,adapters:new Map([[adapter.kind,adapter]]),admission:(delivery,destination)=>{
      const control=new NotificationControlStore(f.database).forDelivery(delivery,destination);
      return control?{reason:`notification_${control.mode}:${control.targetId}`,permanent:control.mode==='closed'}:undefined;
    }});
    const claimed=f.runtime.claimDueDeliveries(20,T1).find(x=>x.deliveryId===original.deliveryId)!;
    assert.equal(notificationControlSnapshot(f.database,'codex-thread',THREAD).effective,false);
    assert.equal((await handler.handle(claimed,T1)).status,'retry_wait');
    assert.equal(f.runtime.delivery(claimed.deliveryId)!.attemptCount,0);
    assert.equal(sent,0);
    assert.equal(notificationControlSnapshot(f.database,'codex-thread',THREAD).effective,true);
    f.monitor('boot-2',T2).runCycle(T2);
    assert.equal(f.noticeDeliveries().length,1);
    f.runtime.withImmediateTransaction(()=>setNotificationControlInTransaction(f.database,'codex-thread',THREAD,'enabled','Owner resume',T2));
    const resumed=f.runtime.claimDueDeliveries(20,T2).find(x=>x.deliveryId===original.deliveryId)!;
    assert.equal((await handler.handle(resumed,T2)).status,'delivered');assert.equal(sent,1);
    // Per-Run close rejects live work and does not erase failed/unknown history.
    assert.throws(()=>f.runtime.withImmediateTransaction(()=>setNotificationControlInTransaction(f.database,'run',started.run.runId,'closed','done',T2)),/terminal/);
    cancelStewardRun(f.repo,started.run.runId,f.runtimeDirectory,T2);
    f.runtime.withImmediateTransaction(()=>setNotificationControlInTransaction(f.database,'run',started.run.runId,'closed','Owner close monitor',T2));
    f.monitor('boot-3',T2).runCycle(T2);
    assert.equal(f.subscriptions.getByRun(started.run.runId)!.status,'completed');
    assert.throws(()=>f.runtime.withImmediateTransaction(()=>setNotificationControlInTransaction(f.database,'run',started.run.runId,'enabled','reopen',T2)),/cannot be reopened/);
    const terminal=f.runtime.claimDueDeliveries(20,T2);
    for(const delivery of terminal) await handler.handle(delivery,T2);
    assert.equal(sent,1);assert.equal(f.runtime.delivery(original.deliveryId)!.status,'delivered');
    assert.equal(new NotificationControlStore(f.database).history('run',started.run.runId).length,1);
  }finally{f.close();}
});
