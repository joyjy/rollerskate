import type {DatabaseSync} from "node:sqlite";
import {requireLocalId} from "../../core/id.js";
import type {RuntimeDelivery,RuntimeDestination} from "../../core/runtime/model.js";

export type NotificationScope = "run" | "codex-thread";
export type NotificationMode = "enabled" | "muted" | "closed";
export interface NotificationControl {
  scope: NotificationScope; targetId: string; revision: number;
  mode: NotificationMode; reason: string; createdAt: string;
}
interface Row {scope:NotificationScope;target_id:string;revision:number;mode:NotificationMode;reason:string;created_at:string}
const map = (r:Row):NotificationControl => ({scope:r.scope,targetId:r.target_id,revision:r.revision,mode:r.mode,reason:r.reason,createdAt:r.created_at});
export function requireNotificationTarget(scope:NotificationScope,id:string):void {
  if(scope === 'run') requireLocalId(id,'run','runId');
  else if(scope !== 'codex-thread' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error('Expected an exact Codex thread UUID');
}
export class NotificationControlStore {
  constructor(private readonly db:DatabaseSync) {}
  get(scope:NotificationScope,id:string):NotificationControl|undefined {
    requireNotificationTarget(scope,id);
    const row=this.db.prepare('SELECT * FROM notification_controls WHERE scope=? AND target_id=? ORDER BY revision DESC LIMIT 1').get(scope,id) as Row|undefined;
    return row ? map(row) : undefined;
  }
  history(scope:NotificationScope,id:string):NotificationControl[] {
    requireNotificationTarget(scope,id);
    return (this.db.prepare('SELECT * FROM notification_controls WHERE scope=? AND target_id=? ORDER BY revision DESC LIMIT 100').all(scope,id) as unknown as Row[]).map(map);
  }
  setInTransaction(scope:NotificationScope,id:string,mode:NotificationMode,reason:string,at:string):NotificationControl {
    if(!this.db.isTransaction) throw new Error('Notification control requires owning transaction');
    requireNotificationTarget(scope,id);
    if(!['enabled','muted','closed'].includes(mode)) throw new Error('Invalid notification mode');
    if(!reason.trim() || reason.length>1024) throw new Error('A bounded reason (1..1024 chars) is required');
    const current=this.get(scope,id);
    if(current?.mode === 'closed' && mode !== 'closed') throw new Error('Closed notification control cannot be reopened');
    if(current?.mode === mode) return current;
    const revision=(current?.revision??0)+1;
    this.db.prepare('INSERT INTO notification_controls VALUES (?,?,?,?,?,?)').run(scope,id,revision,mode,reason,new Date(at).toISOString());
    return this.get(scope,id)!;
  }
  forRun(runId:string,threadId?:string):NotificationControl|undefined {
    const controls=[this.get('run',runId),...(threadId?[this.get('codex-thread',threadId)]:[])];
    return controls.find(x=>x?.mode==='closed')??controls.find(x=>x?.mode==='muted');
  }
  runForEvent(eventId:string):string|undefined {
    const row=this.db.prepare(`WITH RECURSIVE ancestry(event_id,parent_event_id,source_external_id,depth) AS (
      SELECT event_id,parent_event_id,source_external_id,0 FROM events WHERE event_id=?
      UNION ALL SELECT event.event_id,event.parent_event_id,event.source_external_id,ancestry.depth+1
        FROM events event JOIN ancestry ON event.event_id=ancestry.parent_event_id WHERE ancestry.depth<16
    ) SELECT sub.run_id FROM ancestry JOIN run_subscriptions sub
      ON substr(ancestry.source_external_id,1,length('chat-activation:run-subscription:' || sub.subscription_id || ':'))
        = 'chat-activation:run-subscription:' || sub.subscription_id || ':' LIMIT 1`).get(eventId) as {run_id:string}|undefined;
    return row?.run_id;
  }
  eventThreadIds(eventId:string):string[] {
    const runId=this.runForEvent(eventId);
    const bound=runId?this.db.prepare("SELECT json_extract(orchestrator_binding_json,'$.resultDestination.delivery.address.threadId') AS thread_id FROM agent_runs WHERE run_id=?").get(runId) as {thread_id:string|null}|undefined:undefined;
    const rows=this.db.prepare(`WITH RECURSIVE ancestry(event_id,parent_event_id,destination_snapshots_json,depth) AS (
      SELECT event_id,coalesce(parent_event_id,json_extract(payload_json,'$.sourceEventId'),json_extract(payload_json,'$.sourceMessageEventId')),destination_snapshots_json,0 FROM events WHERE event_id=?
      UNION ALL SELECT event.event_id,coalesce(event.parent_event_id,json_extract(event.payload_json,'$.sourceEventId'),json_extract(event.payload_json,'$.sourceMessageEventId')),event.destination_snapshots_json,ancestry.depth+1
        FROM events event JOIN ancestry ON event.event_id=ancestry.parent_event_id WHERE ancestry.depth<16
    ) SELECT DISTINCT json_extract(destination.value,'$.address.threadId') AS thread_id
      FROM ancestry,json_each(ancestry.destination_snapshots_json) destination
      WHERE json_extract(destination.value,'$.kind')='codex-desktop'`).all(eventId) as {thread_id:string}[];
    return [...new Set([...(bound?.thread_id?[bound.thread_id]:[]),...rows.map(r=>r.thread_id)])];
  }
  forEvent(eventId:string):NotificationControl|undefined {
    const runId=this.runForEvent(eventId);
    const controls=[...(runId?[this.get('run',runId)]:[]),...this.eventThreadIds(eventId).map(id=>this.get('codex-thread',id))];
    return controls.find(x=>x?.mode==='closed')??controls.find(x=>x?.mode==='muted');
  }
  runId(delivery:RuntimeDelivery):string|undefined {
    if(delivery.origin.kind==='event' || delivery.origin.id.startsWith('evt_')) return this.runForEvent(delivery.origin.id);
    const terminal=/^steward-run:(run_[^:]+):/.exec(delivery.origin.id);
    if(terminal) return terminal[1];
    const notice=/^run-subscription:(sub_run_[0-9a-f]{32}):/.exec(delivery.origin.id);
    if(notice) return (this.db.prepare('SELECT run_id FROM run_subscriptions WHERE subscription_id=?').get(notice[1]!) as {run_id:string}|undefined)?.run_id;
    return undefined;
  }
  forDelivery(delivery:RuntimeDelivery,destination:RuntimeDestination):NotificationControl|undefined {
    const runId=this.runId(delivery);
    const threadId=destination.kind==='codex-desktop'?destination.address.threadId:undefined;
    if(runId) return this.forRun(runId,threadId);
    const control=threadId?this.get('codex-thread',threadId):undefined;
    return control?.mode==='enabled'?undefined:control;
  }
}
