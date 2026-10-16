import {RunMonitorStore,runMonitorSubscriptionId} from "../../capabilities/subscription/run-monitor-store.js";
import { chatDispatchTaskClaims } from "./responsibility.js";
import { CHAT_CALLBACK_ACTION } from "./callback.js";
import type { DatabaseSync } from "node:sqlite";
import { RuntimeStore } from "../../core/runtime/store.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import type { ChatWorkQueryContext } from "./work-query.js";

export function ownerActionScope(context: ChatWorkQueryContext, database: DatabaseSync,
  runtime: RuntimeStore, foundation: LocalFoundationStore, resumeOriginal = false) {
  const current = chatActionDispatch(context, database, runtime);
  let dispatch = current;
  let resumedRunId: string | undefined;
  if (resumeOriginal && !dispatch.sourceMessageEventId) {
    const activation = runtime.event(dispatch.sourceAttentionEventId);
    const origin = activation?.type === "chat.activation" && activation.sourceEventId ? runtime.event(activation.sourceEventId) : undefined;
    if (activation?.type === "chat.activation" && activation.reason === "work_result" && activation.strategyId === "work-result" &&
      origin?.type === "chat.dispatch" && origin.agentId === current.agentId && origin.topicId === current.topicId &&
      (runtime.chatDecisionReceipt(origin.eventId)?.sessionId ?? origin.sessionId) === current.sessionId) {
      const task = chatDispatchTaskClaims(database,origin.eventId).find(claim =>
        activation.source.externalId?.startsWith(`chat-activation:chat-work-return:${claim.runId}:`) ||
        (new RunMonitorStore(database).getByRun(claim.runId) !== undefined &&
          activation.source.externalId?.startsWith(`chat-activation:run-subscription:${runMonitorSubscriptionId(claim.runId)}:`)));
      const runReturn = task !== undefined;
      if (task) resumedRunId = task.runId;
      const receiptId = activation.source.externalId?.startsWith("chat-activation:chat-callback-return:")
        ? activation.source.externalId.slice("chat-activation:chat-callback-return:".length) : undefined;
      const callbackReturn = receiptId && database.prepare(`SELECT 1 FROM deterministic_action_receipts WHERE receipt_id = ?
        AND action_ref = ? AND status = 'succeeded' AND json_extract(receipt_json,'$.output.dispatchEventId') = ?`).get(receiptId,CHAT_CALLBACK_ACTION,origin.eventId);
      if (runReturn || callbackReturn) dispatch = origin;
    }
  }
  const local = foundation.foundation();
  const source = dispatch.sourceMessageEventId === undefined ? undefined : runtime.event(dispatch.sourceMessageEventId);
  if (local === undefined || source?.type !== "chat.message" || source.sender.kind !== "owner" ||
    source.sender.principalId !== local.owner.principalId || source.topicId !== local.topicId) {
    return { status: "needs_authorization", reason: "An explicit Local Owner instruction is required" };
  }
  return {source, dispatch, ...(resumedRunId ? {resumedRunId} : {})};
}

export function chatActionDispatch(context: ChatWorkQueryContext, database: DatabaseSync, runtime: RuntimeStore) {
  const dispatch = context.dispatchEventId === undefined ? undefined : runtime.event(context.dispatchEventId);
  if (dispatch?.type !== "chat.dispatch" || runtime.executionForEvent(dispatch.eventId)?.status !== "running") {
    throw new Error("Chat action requires a running Host dispatch");
  }
  const eligible = database.prepare(`SELECT 1 FROM agents a
    JOIN topic_governance t ON t.topic_id = ? JOIN json_each(t.participants_json) p
    WHERE a.principal_id = ? AND a.status = 'active' AND t.status = 'active'
    AND json_extract(p.value, '$.agentId') = a.principal_id
    AND json_extract(p.value, '$.status') = 'active'`).get(dispatch.topicId, dispatch.agentId);
  if (eligible === undefined) throw new Error("Chat action participant is no longer eligible");
  if (dispatch.sessionId !== undefined &&
    runtime.currentLocalAgentSession(dispatch.agentId)?.sessionId !== dispatch.sessionId) {
    throw new Error("Chat action Session has changed");
  }
  return dispatch;
}
