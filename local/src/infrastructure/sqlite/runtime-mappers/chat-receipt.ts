import type {
  ChatPresence,
  ChatRunProposalDraft,
  ChatTurnDecision
} from "../../../core/chat/model.js";
import type {
  ChatAttentionPlan,
  ChatAttentionReason
} from "../../../core/chat/state-machine.js";

export interface ChatPresenceRow {
  agent_id: string;
  scope_kind: ChatPresence["scope"];
  scope_id: string;
  mode: ChatPresence["mode"];
  until_at: string | null;
  wake_keywords_json: string;
  revision: number;
  updated_by_dispatch_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatAttentionReceiptRow {
  source_message_event_id: string;
  agent_id: string;
  outcome: "dispatched" | "skipped";
  reason: ChatAttentionReason;
  presence_snapshot_json: string;
  dispatch_event_id: string | null;
  prompt_resource_id: string | null;
  created_at: string;
}

export interface ChatDecisionReceiptRow {
  dispatch_event_id: string;
  speech_action: ChatTurnDecision["speech"]["action"];
  presence_transition_json: string;
  reply_event_id: string | null;
  created_at: string;
}

export interface ChatAttentionReceipt {
  readonly sourceMessageEventId: string;
  readonly agentId: string;
  readonly handleSnapshot: string;
  readonly outcome: "dispatched" | "skipped";
  readonly reason: ChatAttentionReason;
  readonly presenceSnapshot: ChatAttentionPlan["presenceSnapshot"];
  readonly dispatchEventId?: string;
  readonly promptResourceId?: string;
  readonly createdAt: string;
}

export interface ChatDecisionReceipt {
  readonly sessionId?: string;
  readonly dispatchEventId: string;
  readonly speechAction: ChatTurnDecision["speech"]["action"];
  readonly silenceReason?: string;
  readonly proposal?: ChatRunProposalDraft;
  readonly presenceTransition?: ChatPresence;
  readonly replyEventId?: string;
  readonly replySuppressedReason?: string;
  readonly createdAt: string;
  readonly profileRevisions?: {
    readonly schema: "ChatProfileRevisionReceipt@1";
    readonly agentId: string;
    readonly agentRevision: number;
    readonly topicId: string;
    readonly topicRevision: number;
    readonly resolvedAt: string;
  };
}

export function mapChatPresence(row: ChatPresenceRow): ChatPresence {
  const wakeKeywords = JSON.parse(row.wake_keywords_json) as unknown;
  if (!Array.isArray(wakeKeywords) ||
    wakeKeywords.some((keyword) => typeof keyword !== "string")) {
    throw new Error(`Chat presence wake keywords are malformed: ${row.agent_id}`);
  }
  return {
    scope: row.scope_kind,
    mode: row.mode,
    ...(row.until_at === null ? {} : { until: row.until_at }),
    wakeKeywords
  };
}

export function mapChatAttentionReceipt(row: ChatAttentionReceiptRow): ChatAttentionReceipt {
  const snapshot = JSON.parse(row.presence_snapshot_json) as
    ChatAttentionPlan["presenceSnapshot"];
  return {
    sourceMessageEventId: row.source_message_event_id,
    agentId: row.agent_id,
    handleSnapshot: row.agent_id,
    outcome: row.outcome,
    reason: row.reason,
    presenceSnapshot: snapshot,
    ...(row.dispatch_event_id === null ? {} : { dispatchEventId: row.dispatch_event_id }),
    ...(row.prompt_resource_id === null ? {} : { promptResourceId: row.prompt_resource_id }),
    createdAt: row.created_at
  };
}

export function mapChatDecisionReceipt(row: ChatDecisionReceiptRow): ChatDecisionReceipt {
  const presence = JSON.parse(row.presence_transition_json) as ChatPresence | null;
  return {
    dispatchEventId: row.dispatch_event_id,
    speechAction: row.speech_action,
    ...(presence === null ? {} : { presenceTransition: presence }),
    ...(row.reply_event_id === null ? {} : { replyEventId: row.reply_event_id }),
    createdAt: row.created_at
  };
}
