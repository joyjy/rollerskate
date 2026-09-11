import { inspectInteractiveChannelFollow } from "../channel/query.js";
import type { DatabaseSync } from "node:sqlite";
import { RuntimeStore } from "../../core/runtime/store.js";
import { inspectStewardWork } from "../steward/work-query.js";

export interface ChatWorkReturnCursor { readonly updatedAt: string; readonly entityId: string }

/** Accepted Run/Channel origins and canonical return Events own delivery facts.
 * Only explicit Chat tool origins opt in; no legacy work is replayed on upgrade. */
export function admitChatWorkReturns(input: {
  readonly repoRoot: string;
  readonly runtimeDirectory?: string;
  readonly database: DatabaseSync;
  readonly runtime: RuntimeStore;
  readonly after?: ChatWorkReturnCursor;
}, at = new Date().toISOString()) {
  const {database, runtime} = input;
  const candidates = database.prepare(`SELECT * FROM (
    SELECT 'run' AS kind, run.run_id AS entity_id, run.version, run.updated_at, dispatch.event_id,
      'chat-work-return:' || run.run_id || ':' || run.version AS return_key, NULL AS follow_token
    FROM agent_runs run JOIN events dispatch ON dispatch.type = 'chat.dispatch'
      AND run.owner_request_id = 'chat-execute:' || json_extract(dispatch.payload_json, '$.sourceMessageEventId') || ':' || dispatch.event_id
    WHERE run.status IN ('awaiting_orchestrator', 'needs_human', 'succeeded', 'failed', 'cancelled')
    UNION ALL
    SELECT 'channel', send.send_id, json_extract(follow.state_json,'$.revision'), follow.updated_at, dispatch.event_id,
      'chat-channel-return:' || send.send_id, follow.follow_token
    FROM channel_send_receipts send JOIN channel_follows follow ON follow.send_id = send.send_id
    JOIN events dispatch ON dispatch.type = 'chat.dispatch'
      AND send.idempotency_key LIKE 'chat-channel:' || json_extract(dispatch.payload_json,'$.sourceMessageEventId') || ':' || dispatch.event_id || ':%'
    WHERE follow.status IN ('quiet','terminal','failed','expired','stopped')
      AND json_extract(send.receipt_json,'$.status') IN ('accepted','failed')
  ) candidate
    WHERE (? IS NULL OR (updated_at, entity_id) > (?, ?))
    AND NOT EXISTS (SELECT 1 FROM events returned WHERE returned.source_kind = 'handler'
      AND returned.source_external_id = 'chat-activation:' || candidate.return_key)
    ORDER BY updated_at, entity_id LIMIT 20`).all(input.after?.updatedAt ?? null, input.after?.updatedAt ?? null, input.after?.entityId ?? null) as unknown as {
      kind: "run"|"channel"; entity_id: string; version: number; updated_at: string;
      event_id: string; return_key: string; follow_token: string|null;
    }[];
  const admitted: string[] = [];
  for (const candidate of candidates) {
    runtime.withImmediateTransaction(() => {
      let brief: string;
      if (candidate.kind === "run") {
        const current = database.prepare("SELECT version FROM agent_runs WHERE run_id = ?").get(candidate.entity_id) as {version:number} | undefined;
        if (current?.version !== candidate.version) return;
        const work = inspectStewardWork(input.repoRoot,candidate.entity_id,input.runtimeDirectory,database);
        if (!work.terminal && work.intervention === null && work.humanQuestion?.status !== "pending" && work.humanQuestion?.status !== "expired") return;
        brief = ["An accepted Run you are responsible for has updated. Read its exact evidence with get_run.",
          JSON.stringify({runId:work.runId,status:work.status,terminal:work.terminal,humanQuestion:work.humanQuestion,
            attentionReason:work.attentionReason?.slice(0,1024)})].join("\n");
      } else {
        const current = inspectInteractiveChannelFollow(input.repoRoot,candidate.follow_token!,input.runtimeDirectory);
        if (current.follow.revision !== candidate.version) return;
        brief = ["A Channel send/follow you initiated has settled. Read get_channel_follow for the bounded delivery and reply evidence.",
          "Accepted is not a reply; quiet/expired/stopped does not mean the requested task succeeded.",
          JSON.stringify({followToken:current.follow.followToken,sendStatus:current.receipt.status,followStatus:current.follow.status,deliveryOutcome:current.deliveryOutcome})].join("\n");
      }
      const dispatch = runtime.event(candidate.event_id);
      if (dispatch?.type !== "chat.dispatch") return;
      const sessionId = runtime.chatDecisionReceipt(dispatch.eventId)?.sessionId ?? dispatch.sessionId;
      if (sessionId === undefined || runtime.currentLocalAgentSession(dispatch.agentId)?.sessionId !== sessionId ||
        !runtime.sessionIsIdle(sessionId)) return;
      const governance = database.prepare(`SELECT t.revision FROM topic_governance t
        JOIN json_each(t.participants_json) p JOIN agents a ON a.principal_id = json_extract(p.value, '$.agentId')
        WHERE t.topic_id = ? AND t.status = 'active' AND a.principal_id = ? AND a.status = 'active'
        AND json_extract(p.value, '$.status') = 'active'`).get(dispatch.topicId, dispatch.agentId) as { revision: number } | undefined;
      if (governance === undefined) return;
      const receipt = runtime.createChatActivationInTransaction({
        topicId: dispatch.topicId, sessionId,
        reason: "work_result", strategyId: "work-result", contextRevision: governance.revision,
        candidateAgentIds: [dispatch.agentId], sourceEventId: dispatch.eventId,
        idempotencyKey: candidate.return_key,
        turnBudget: 1,
        conversationIntent: { schema: "ConversationIntentSnapshot@1", mode: "directed",
          governanceRevision: governance.revision,
          brief: [brief,"Report the outcome or the one required human action. This return is evidence, not new execution authority.",
            `Originating dispatch: ${dispatch.eventId}`].join("\n") }

      }, at);
      if (receipt.status === "accepted") admitted.push(receipt.event.eventId);
    });
  }
  const last = candidates.at(-1);
  return { eventIds: admitted, nextCursor: candidates.length === 20 && last !== undefined
    ? { updatedAt: last.updated_at, entityId: last.entity_id } : undefined };
}
