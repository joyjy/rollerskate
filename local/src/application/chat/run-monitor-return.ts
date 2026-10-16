import type {DatabaseSync} from "node:sqlite";
import {RuntimeStore} from "../../core/runtime/store.js";
import {chatReturnState} from "./callback.js";

/** Exact dispatch/Session authority remains owned by Chat; monitoring never picks a replacement. */
export function admitRunMonitorChatNotice(database: DatabaseSync, runtime: RuntimeStore,
  input: {dispatchEventId: string; key: string; brief: string}, at: string): boolean {
  const existing = database.prepare("SELECT event_id FROM events WHERE source_kind = 'handler' AND source_external_id = ?")
    .get(`chat-activation:${input.key}`);
  if (existing) return true;
  const dispatch = runtime.event(input.dispatchEventId);
  if (dispatch?.type !== "chat.dispatch") return false;
  const target = chatReturnState(database, runtime, dispatch.eventId, input.key);
  if (target.status !== "ready") return false;
  const admitted = runtime.createChatActivationInTransaction({
    topicId: dispatch.topicId, sessionId: target.sessionId, reason: "work_result", strategyId: "work-result",
    contextRevision: target.governanceRevision, candidateAgentIds: [dispatch.agentId], sourceEventId: dispatch.eventId,
    idempotencyKey: input.key, turnBudget: 1,
    conversationIntent: {schema: "ConversationIntentSnapshot@1", mode: "directed",
      governanceRevision: target.governanceRevision, brief: input.brief}
  }, at);
  return admitted.event.source.externalId === `chat-activation:${input.key}`;
}


export function runMonitorChatNoticeStates(database: DatabaseSync, _runtime: RuntimeStore,
  _dispatchEventId: string, subscriptionId: string) {
  const prefix = `chat-activation:run-subscription:${subscriptionId}:`;
  // Aggregate every persisted notification: a bounded display window must not hide older failures.
  return database.prepare(`WITH notices AS (
    SELECT activation.event_id, activation_execution.status AS activation_status,
      child.event_id AS child_id, child_execution.status AS child_status,
      json_extract(child_execution.receipt_json,'$.speechAction') AS speech_action,
      json_extract(child_execution.receipt_json,'$.replyEventId') AS reply_event_id
    FROM events activation JOIN executions activation_execution ON activation_execution.event_id = activation.event_id
    LEFT JOIN events child ON child.event_id = (SELECT dispatch.event_id FROM events dispatch
      WHERE dispatch.type = 'chat.dispatch' AND json_extract(dispatch.payload_json,'$.sourceAttentionEventId') = activation.event_id
      ORDER BY dispatch.created_at DESC LIMIT 1)
    LEFT JOIN executions child_execution ON child_execution.event_id = child.event_id
    WHERE activation.source_kind = 'handler' AND activation.source_external_id >= ? AND activation.source_external_id < ?
  ), states AS (SELECT CASE
    WHEN activation_status IN ('failed','cancelled') OR child_status IN ('failed','cancelled') THEN 'failed'
    WHEN child_status = 'succeeded' AND (speech_action IS NULL OR speech_action != 'reply' OR reply_event_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM events reply WHERE reply.event_id = notices.reply_event_id AND reply.type = 'chat.message')) THEN 'blocked'
    WHEN EXISTS (SELECT 1 FROM deliveries delivery WHERE delivery.origin_id = notices.reply_event_id AND delivery.status = 'failed') THEN 'failed'
    WHEN child_status = 'succeeded' AND EXISTS (SELECT 1 FROM deliveries delivery WHERE delivery.origin_id = notices.reply_event_id AND delivery.status != 'delivered') THEN 'delivery_pending'
    WHEN child_status = 'succeeded' THEN 'turn_completed'
    WHEN child_id IS NOT NULL THEN 'agent_pending'
    WHEN activation_status = 'succeeded' THEN 'blocked' ELSE 'admitted' END AS status FROM notices)
    SELECT status, count(*) AS count, CASE WHEN status = 'blocked' THEN 'return_produced_no_visible_reply'
      WHEN status = 'failed' THEN 'responsible_return_failed' ELSE NULL END AS reason
    FROM states GROUP BY status`).all(prefix,`${prefix}\uffff`) as {status:string;count:number;reason:string|null}[];
}
