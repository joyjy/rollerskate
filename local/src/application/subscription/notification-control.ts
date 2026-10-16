import type {DatabaseSync} from "node:sqlite";
import {NotificationControlStore,requireNotificationTarget,type NotificationScope,type NotificationMode} from "../../capabilities/subscription/notification-control-store.js";
import {RunMonitorStore} from "../../capabilities/subscription/run-monitor-store.js";
import {RuntimeStore} from "../../core/runtime/store.js";
import {AgentRunStore} from "../../infrastructure/sqlite/agent-run-store.js";
import {isTerminal} from "../../modules/steward/state-machine.js";
import {runtimePaths} from "../../infrastructure/runtime/config.js";
import {openRuntimeDatabase,openRuntimeDatabaseReadOnly} from "../../infrastructure/sqlite/database.js";
import {assertCurrentLocalSchema} from "../../infrastructure/sqlite/schema/index.js";
import {redact} from "../../integrations/activity/provider-source.js";

/** Query in-flight transport separately: a durable gate cannot retract an already sent request. */
export function notificationControlSnapshot(db:DatabaseSync,scope:NotificationScope,targetId:string) {
  requireNotificationTarget(scope,targetId);
  const controls=new NotificationControlStore(db);
  const runtime=new RuntimeStore(db,{migrate:false});
  try {
    const rows=db.prepare("SELECT delivery_id FROM deliveries WHERE status IN ('pending','retry_wait','delivering')").all() as {delivery_id:string}[];
    const matching=rows.map(r=>runtime.delivery(r.delivery_id)!).filter(delivery=>scope==='run'
      ? controls.runId(delivery)===targetId
      : delivery.destinationId && runtime.destination(delivery.destinationId)?.kind==='codex-desktop' && runtime.destination(delivery.destinationId)?.address.threadId===targetId);
    const attention=db.prepare(`SELECT execution.execution_id,execution.event_id,execution.status
      FROM executions execution JOIN events event ON event.event_id=execution.event_id
      WHERE execution.status IN ('queued','running','retry_wait') AND event.type IN ('chat.activation','chat.dispatch')`)
      .all() as {execution_id:string;event_id:string;status:string}[];
    const matchingAttention=attention.filter(row=>scope==='run'
      ? controls.runForEvent(row.event_id)===targetId : controls.eventThreadIds(row.event_id).includes(targetId));
    const inFlightAttention=matchingAttention.filter(row=>row.status==='running').map(row=>row.execution_id);
    const inFlight=matching.filter(x=>x.status==='delivering').map(x=>x.deliveryId);
    const control=controls.get(scope,targetId);
    return {schemaVersion:'NotificationControlReadback@1',scope,targetId,control:control??null,
      state:control?.mode??'enabled',effective:control?.mode!=='enabled' && control!==undefined && inFlight.length===0 && inFlightAttention.length===0,
      inFlightAttentionExecutionIds:inFlightAttention,queuedAttentionExecutionIds:matchingAttention.filter(row=>row.status!=='running').map(row=>row.execution_id),
      inFlightDeliveryIds:inFlight,queuedDeliveryIds:matching.filter(x=>x.status!=='delivering').map(x=>x.deliveryId),
      history:controls.history(scope,targetId),
      semantics:'Owner control affects future transport admission. In-flight requests cannot be recalled; inspect until drained. Business execution is unchanged.'};
  } finally {runtime.close();}
}
export function setNotificationControlInTransaction(db:DatabaseSync,scope:NotificationScope,targetId:string,mode:NotificationMode,reason:string,at=new Date().toISOString()) {
  if(!db.isTransaction) throw new Error('Notification control requires owning transaction');
  if(scope==='run') {
    const run=new AgentRunStore(db,{migrate:false}).requireProjection(targetId);
    if(mode==='closed' && !isTerminal(run.status)) throw new Error('Close monitoring only after the Run is terminal; mute a running Run instead');
  }
  const control=new NotificationControlStore(db).setInTransaction(scope,targetId,mode,redact(reason),at);
  if(scope==='run' && mode==='closed') {
    const monitors=new RunMonitorStore(db);const sub=monitors.getByRun(targetId);
    if(sub) monitors.setStatusInTransaction(sub.subscriptionId,'completed',`notification_closed:run:${targetId}:r${control.revision}`,at);
  }
  // Only policy-held unsent deliveries become due again. Failed/unknown transport is never replayed.
  if(mode==='enabled') {
    db.prepare("UPDATE deliveries SET next_attempt_at=? WHERE status='retry_wait' AND attempt_count=0 AND last_error LIKE 'notification_muted:%'").run(at);
    db.prepare("UPDATE executions SET next_attempt_at=? WHERE status='retry_wait' AND attempt_count=0 AND last_error LIKE 'notification_muted:%'").run(at);
  }
  return notificationControlSnapshot(db,scope,targetId);
}
export function inspectNotificationControl(repoRoot:string,scope:NotificationScope,targetId:string,runtimeDirectory?:string) {
  const db=openRuntimeDatabaseReadOnly(runtimePaths(repoRoot,runtimeDirectory).database);
  try {assertCurrentLocalSchema(db);return notificationControlSnapshot(db,scope,targetId);} finally {db.close();}
}
export function controlNotifications(repoRoot:string,scope:NotificationScope,targetId:string,action:'mute'|'resume'|'close',reason:string,runtimeDirectory?:string) {
  const db=openRuntimeDatabase(runtimePaths(repoRoot,runtimeDirectory).database);const runtime=new RuntimeStore(db,{migrate:false});
  try {return runtime.withImmediateTransaction(()=>setNotificationControlInTransaction(db,scope,targetId,
    action==='mute'?'muted':action==='close'?'closed':'enabled',reason));} finally {runtime.close();db.close();}
}
