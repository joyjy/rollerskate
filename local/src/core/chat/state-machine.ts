import type { ChatMessageEvent } from "../event/model.js";
import type { ChatPresence } from "./model.js";

export type ChatAttentionReason =
  | "available"
  | "direct-mention"
  | "global-wake-keyword"
  | "topic-wake-keyword"
  | "sender"
  | "not-target"
  | "agent-suspended"
  | "global-snoozed"
  | "topic-snoozed";

export interface ChatAttentionCandidate {
  readonly agentId: string;
  readonly handle: string;
  readonly status: "active" | "suspended";
  readonly globalPresence?: ChatPresence;
  readonly topicPresence?: ChatPresence;
}

export interface ChatAttentionPlan {
  readonly agentId: string;
  readonly handle: string;
  readonly outcome: "dispatch" | "skip";
  readonly reason: ChatAttentionReason;
  readonly presenceSnapshot: {
    readonly global: ChatPresence;
    readonly topic: ChatPresence;
  };
}

export function planChatAttention(input: {
  readonly message: ChatMessageEvent;
  readonly candidates: readonly ChatAttentionCandidate[];
  readonly now?: string;
}): readonly ChatAttentionPlan[] {
  const now = Date.parse(iso(input.now ?? new Date().toISOString()));
  return input.candidates.map((candidate) => {
    const global = effectivePresence(candidate.globalPresence, "global", now);
    const topic = effectivePresence(candidate.topicPresence, "topic", now);
    const snapshot = { global, topic };
    if (input.message.sender.principalId === candidate.agentId) {
      return skipped(candidate, "sender", snapshot);
    }
    const targeted = input.message.target?.principalId;
    if (targeted !== undefined && targeted !== candidate.agentId) {
      return skipped(candidate, "not-target", snapshot);
    }
    if (candidate.status !== "active") {
      return skipped(candidate, "agent-suspended", snapshot);
    }
    const mentioned = targeted === candidate.agentId ||
      includesMention(input.message.body, candidate.handle);
    if (mentioned) return dispatched(candidate, "direct-mention", snapshot);

    if (global.mode === "snoozed") {
      if (matchesKeyword(input.message.body, global.wakeKeywords)) {
        return dispatched(candidate, "global-wake-keyword", snapshot);
      }
      return skipped(candidate, "global-snoozed", snapshot);
    }
    if (topic.mode === "snoozed") {
      if (matchesKeyword(input.message.body, topic.wakeKeywords)) {
        return dispatched(candidate, "topic-wake-keyword", snapshot);
      }
      return skipped(candidate, "topic-snoozed", snapshot);
    }
    return dispatched(candidate, "available", snapshot);
  });
}

function effectivePresence(
  presence: ChatPresence | undefined,
  scope: ChatPresence["scope"],
  now: number
): ChatPresence {
  if (presence === undefined || presence.mode === "available" ||
    presence.until === undefined || Date.parse(presence.until) <= now) {
    return { scope, mode: "available", wakeKeywords: [] };
  }
  return presence;
}

function matchesKeyword(body: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => includesLiteral(body, keyword));
}

function includesLiteral(body: string, value: string): boolean {
  return normalize(body).includes(normalize(value));
}

function includesMention(body: string, handle: string): boolean {
  return new RegExp(
    `(^|[^\\p{L}\\p{N}_-])@${escapeRegExp(normalize(handle))}` +
      "(?=$|[^\\p{L}\\p{N}_-])",
    "iu"
  ).test(normalize(body));
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dispatched(
  candidate: ChatAttentionCandidate,
  reason: ChatAttentionReason,
  presenceSnapshot: ChatAttentionPlan["presenceSnapshot"]
): ChatAttentionPlan {
  return {
    agentId: candidate.agentId,
    handle: candidate.handle,
    outcome: "dispatch",
    reason,
    presenceSnapshot
  };
}

function skipped(
  candidate: ChatAttentionCandidate,
  reason: ChatAttentionReason,
  presenceSnapshot: ChatAttentionPlan["presenceSnapshot"]
): ChatAttentionPlan {
  return {
    agentId: candidate.agentId,
    handle: candidate.handle,
    outcome: "skip",
    reason,
    presenceSnapshot
  };
}

function iso(value: string): string {
  if (Number.isNaN(Date.parse(value))) throw new Error("now must be ISO-8601");
  return new Date(value).toISOString();
}
