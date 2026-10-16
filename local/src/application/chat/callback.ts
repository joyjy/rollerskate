import type { DatabaseSync } from "node:sqlite";
import { RuntimeStore } from "../../core/runtime/store.js";
import { contractRecord, contractText, exactContractKeys } from "../../modules/steward/contract-codec.js";
import type { DeterministicApplicationActionRegistration } from "../proactive/action-registry.js";

export const CHAT_CALLBACK_ACTION = "action:chat.callback@1";
export function parseChatCallbackInput(value: unknown) {
  const input = contractRecord(value, "Chat callback input");
  exactContractKeys(input, ["dispatchEventId", "title"], "Chat callback input");
  const dispatchEventId = contractText(input.dispatchEventId, "dispatchEventId", 64);
  if (!/^evt_[A-Za-z0-9_-]+$/u.test(dispatchEventId)) throw new Error("Chat callback requires an exact dispatch Event ID");
  return { dispatchEventId, title: contractText(input.title, "title", 120) };
}

/** Frozen result receipt is the pending source; the existing Chat return phase owns activation. */
export const chatCallbackAction: DeterministicApplicationActionRegistration = {
  ref: CHAT_CALLBACK_ACTION, inputSchema: "ChatCallbackInput@1", parseInput: parseChatCallbackInput,
  executeInTransaction({ database, source, occurrenceKey, observation, actionInput }) {
    if (source.kind !== "subscription" && source.kind !== "continuous_subscription") throw new Error("Chat callback requires a Subscription source");
    const target = parseChatCallbackInput(actionInput);
    const runtime = new RuntimeStore(database, {migrate: false});
    const dispatch = runtime.event(target.dispatchEventId);
    if (dispatch?.type !== "chat.dispatch") throw new Error("Chat callback origin is not a dispatch");
    return {status: "succeeded", summary: "Chat callback recorded; waiting for responsible Agent admission",
      output: {...target, source, occurrenceKey, observation}};
  }
};

/** Readback never changes membership, Session identity or execution status. */
export function chatReturnState(database: DatabaseSync, runtime: RuntimeStore, dispatchEventId: string, returnKey?: string) {
  if (returnKey !== undefined) {
    const row = database.prepare("SELECT event_id FROM events WHERE source_kind = 'handler' AND source_external_id = ?")
      .get(`chat-activation:${returnKey}`) as {event_id: string} | undefined;
    if (row) {
      const activationExecution = runtime.executionForEvent(row.event_id);
      const child = database.prepare("SELECT event_id FROM events WHERE type = 'chat.dispatch' AND json_extract(payload_json, '$.sourceAttentionEventId') = ? ORDER BY created_at DESC LIMIT 1")
        .get(row.event_id) as {event_id: string} | undefined;
      const execution = child ? runtime.executionForEvent(child.event_id) : activationExecution;
      // Chat admission only enqueues an Agent turn. Even a successful Agent turn
      // is not a business acceptance oracle; expose its decision separately.
      const status = execution?.status === "failed" || execution?.status === "cancelled" ? "failed"
        : child && execution?.status === "succeeded" ? "turn_completed"
        : child ? "agent_pending" : activationExecution?.status === "succeeded" ? "blocked" : "admitted";
      return {status, activationEventId: row.event_id,
        ...(status === "failed" ? {reason: child ? "responsible_turn_failed" : "activation_failed"} :
          status === "blocked" ? {reason: "activation_not_dispatched"} : {}),
        ...(child ? {dispatchEventId: child.event_id, decision: runtime.chatDecisionReceipt(child.event_id) ?? null} : {}),
        executionStatus: execution?.status ?? "unknown", taskAcceptance: "unverified"} as const;
    }
  }
  const dispatch = runtime.event(dispatchEventId);
  if (dispatch?.type !== "chat.dispatch") return {status: "blocked", reason: "origin_missing"} as const;
  const governance = database.prepare(`SELECT t.revision FROM topic_governance t
    JOIN json_each(t.participants_json) p JOIN agents a ON a.principal_id = json_extract(p.value, '$.agentId')
    WHERE t.topic_id = ? AND t.status = 'active' AND a.principal_id = ? AND a.status = 'active'
    AND json_extract(p.value, '$.status') = 'active'`).get(dispatch.topicId, dispatch.agentId) as {revision: number} | undefined;
  if (!governance) return {status: "blocked", reason: "participant_unavailable"} as const;
  const sessionId = runtime.chatDecisionReceipt(dispatch.eventId)?.sessionId ?? dispatch.sessionId;
  if (!sessionId) {
    const execution = runtime.executionForEvent(dispatch.eventId);
    return execution?.status === "running" || execution?.status === "queued" || execution?.status === "retry_wait"
      ? {status: "waiting_origin", reason: "origin_session_pending"} as const
      : {status: "blocked", reason: "origin_session_missing"} as const;
  }
  if (runtime.currentLocalAgentSession(dispatch.agentId)?.sessionId !== sessionId) return {status: "blocked", reason: "session_changed"} as const;
  if (!runtime.sessionIsIdle(sessionId)) return {status: "waiting_agent", reason: "session_busy"} as const;
  return {status: "ready", sessionId, governanceRevision: governance.revision} as const;
}
