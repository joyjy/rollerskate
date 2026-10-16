import {runtimePaths} from "../../infrastructure/runtime/config.js";
import { RunSubscriptionRuntime } from "../subscription/run-monitor.js";
import { chatRunOriginSql } from "./work-origin.js";
import { returnNotice, observationPreview } from "../proactive/return-notice.js";
import { DeterministicApplicationActionRegistry } from "../proactive/action-registry.js";
import { contractRecord, contractText } from "../../modules/steward/contract-codec.js";
import { CHAT_CALLBACK_ACTION, chatReturnState } from "./callback.js";
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
  // Keep the established Chat return entrypoint, delegating monitored Runs to their source owner.
  const monitored = new RunSubscriptionRuntime({database,repoRoot:input.repoRoot,
    runtimeDirectory:runtimePaths(input.repoRoot,input.runtimeDirectory).runtimeDirectory,runtimeIdentity:"chat-return",startedAt:at}).runCycle(at,"chat-return");
  const candidates = database.prepare(`SELECT * FROM (
    SELECT 'run' AS kind, run.run_id AS entity_id, run.version, run.updated_at, dispatch.event_id,
      'chat-work-return:' || run.run_id || ':' || run.version AS return_key, NULL AS follow_token
    FROM agent_runs run JOIN events dispatch ON dispatch.type = 'chat.dispatch'
      AND ${chatRunOriginSql("dispatch", true)}
    WHERE run.status IN ('awaiting_orchestrator', 'needs_human', 'succeeded', 'failed', 'cancelled')
      AND NOT EXISTS (SELECT 1 FROM run_subscriptions monitor WHERE monitor.run_id = run.run_id)
    UNION ALL
    SELECT 'callback', receipt.receipt_id, 1, receipt.created_at,
      json_extract(receipt.receipt_json, '$.output.dispatchEventId'),
      'chat-callback-return:' || receipt.receipt_id, NULL
    FROM deterministic_action_receipts receipt
    WHERE receipt.action_ref = '${CHAT_CALLBACK_ACTION}' AND receipt.status = 'succeeded'
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
      kind: "run"|"channel"|"callback"; entity_id: string; version: number; updated_at: string;
      event_id: string; return_key: string; follow_token: string|null;
    }[];
  const admitted: string[] = [...monitored.eventIds];
  for (const candidate of candidates) {
    runtime.withImmediateTransaction(() => {
      let brief: string;
      if (candidate.kind === "run") {
        const current = database.prepare("SELECT version FROM agent_runs WHERE run_id = ?").get(candidate.entity_id) as {version:number} | undefined;
        if (current?.version !== candidate.version) return;
        const work = inspectStewardWork(input.repoRoot,candidate.entity_id,input.runtimeDirectory,database);
        if (!work.terminal && work.state !== "needs_human") return;
        brief = returnNotice({title: work.label, status: `${work.status} / ${work.state}`,
          detail: work.attentionReason ?? work.terminalSummary, read: `get_run ${JSON.stringify({runId: work.runId})} (expected version ${candidate.version})`});
      } else if (candidate.kind === "callback") {
        const receipt = new DeterministicApplicationActionRegistry(database).receiptById(candidate.entity_id)!;
        const output = contractRecord(receipt.output, "Chat callback output");
        brief = returnNotice({title: contractText(output.title, "callback title", 120),
          ...observationPreview(output.observation), read: `get_chat_callback ${JSON.stringify({receiptId: candidate.entity_id})}`});
      } else {
        const current = inspectInteractiveChannelFollow(input.repoRoot,candidate.follow_token!,input.runtimeDirectory);
        if (current.follow.revision !== candidate.version) return;
        brief = returnNotice({title: "Channel follow settled",
          status: `${current.receipt.status} / ${current.follow.status} / ${current.deliveryOutcome}`,
          detail: "Delivery/follow status does not establish task success.",
          read: `get_channel_follow ${JSON.stringify({followToken: current.follow.followToken})}`});
      }
      const dispatch = runtime.event(candidate.event_id);
      if (dispatch?.type !== "chat.dispatch") return;
      const target = chatReturnState(database, runtime, dispatch.eventId, candidate.return_key);
      if (target.status !== "ready") return;
      const sessionId = target.sessionId;
      const governance = {revision: target.governanceRevision};
      const receipt = runtime.createChatActivationInTransaction({
        topicId: dispatch.topicId, sessionId,
        reason: "work_result", strategyId: "work-result", contextRevision: governance.revision,
        candidateAgentIds: [dispatch.agentId], sourceEventId: dispatch.eventId,
        idempotencyKey: candidate.return_key,
        turnBudget: 1,
        conversationIntent: { schema: "ConversationIntentSnapshot@1", mode: "directed",
          governanceRevision: governance.revision,
          brief }

      }, at);
      if (receipt.status === "accepted") admitted.push(receipt.event.eventId);
    });
  }
  const last = candidates.at(-1);
  return { eventIds: admitted, nextCursor: candidates.length === 20 && last !== undefined
    ? { updatedAt: last.updated_at, entityId: last.entity_id } : undefined };
}
