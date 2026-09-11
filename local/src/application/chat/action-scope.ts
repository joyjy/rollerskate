import type { DatabaseSync } from "node:sqlite";
import { RuntimeStore } from "../../core/runtime/store.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import type { ChatWorkQueryContext } from "./work-query.js";

export function ownerActionScope(context: ChatWorkQueryContext, database: DatabaseSync,
  runtime: RuntimeStore, foundation: LocalFoundationStore) {
  const dispatch = chatActionDispatch(context, database, runtime);
  const local = foundation.foundation();
  const source = dispatch.sourceMessageEventId === undefined ? undefined : runtime.event(dispatch.sourceMessageEventId);
  if (local === undefined || source?.type !== "chat.message" || source.sender.kind !== "owner" ||
    source.sender.principalId !== local.owner.principalId || source.topicId !== local.topicId) {
    return { status: "needs_authorization", reason: "An explicit Local Owner instruction is required" };
  }
  return {source, dispatch};
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
