export const chatPromptResourceId = "prompt.chat.free-turn" as const;
export const chatMentionPromptResourceId = "prompt.chat.mentioned-turn" as const;

export type ChatPresenceScope = "topic" | "global";
export type ChatPresenceMode = "available" | "snoozed";

export interface ChatMessageSummary {
  readonly eventId: string;
  readonly createdAt: string;
  readonly sender: {
    readonly kind: "owner" | "system" | "agent";
    readonly principalId?: string;
    readonly handleSnapshot: string;
  };
  readonly body: string;
  readonly target?: {
    readonly principalId: string;
    readonly handleSnapshot: string;
  };
}

export interface ChatPromptHistory {
  readonly items: readonly ChatMessageSummary[];
  readonly hasEarlier: boolean;
  readonly beforeEventId?: string;
}

export interface ChatTimeline extends ChatPromptHistory {
  readonly topicId: string;
}

export interface ChatHistoryRequest {
  readonly schema: "ChatHistoryRequest@1";
  readonly beforeEventId: string;
  readonly limit: number;
}

export interface ChatPresence {
  readonly scope: ChatPresenceScope;
  readonly mode: ChatPresenceMode;
  readonly until?: string;
  readonly wakeKeywords: readonly string[];
}

export type ChatDecision = {
  readonly schema: "ChatDecision@1";
  readonly speech:
    | { readonly action: "reply"; readonly body: string }
    | { readonly action: "silent" };
  readonly presence: ChatPresence;
};

export type ChatMentionDecision = {
  readonly schema: "ChatMentionDecision@1";
  readonly speech:
    | { readonly action: "reply"; readonly body: string }
    | { readonly action: "silent" };
};

export type ChatTurnDecision = ChatDecision | ChatMentionDecision;

export function parseChatHistoryRequest(value: string): ChatHistoryRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.schema !== "ChatHistoryRequest@1") return undefined;
  if (typeof parsed.beforeEventId !== "string" || parsed.beforeEventId.trim() === "") {
    throw new Error("ChatHistoryRequest.beforeEventId must be non-empty");
  }
  if (!Number.isInteger(parsed.limit) || (parsed.limit as number) < 1 ||
    (parsed.limit as number) > 200) {
    throw new Error("ChatHistoryRequest.limit must be between 1 and 200");
  }
  return {
    schema: "ChatHistoryRequest@1",
    beforeEventId: parsed.beforeEventId,
    limit: parsed.limit as number
  };
}

export function parseChatDecision(
  value: string,
  now = new Date().toISOString()
): ChatDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Chat Agent output must be valid ChatDecision@1 JSON");
  }
  if (!isRecord(parsed) || parsed.schema !== "ChatDecision@1") {
    throw new Error("Chat Agent output must use schema ChatDecision@1");
  }
  const speech = parsed.speech;
  if (!isRecord(speech) || (speech.action !== "reply" && speech.action !== "silent")) {
    throw new Error("ChatDecision.speech.action must be reply or silent");
  }
  const normalizedSpeech = speech.action === "reply"
    ? { action: "reply" as const, body: requireText(speech.body, "ChatDecision.speech.body") }
    : { action: "silent" as const };
  const presence = parseChatPresence(parsed.presence, now);
  return {
    schema: "ChatDecision@1",
    speech: normalizedSpeech,
    presence
  };
}

export function parseChatMentionDecision(value: string): ChatMentionDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Chat Agent output must be valid ChatMentionDecision@1 JSON");
  }
  if (!isRecord(parsed) || parsed.schema !== "ChatMentionDecision@1") {
    throw new Error("Chat Agent output must use schema ChatMentionDecision@1");
  }
  if ("presence" in parsed) {
    throw new Error("ChatMentionDecision@1 must not include presence");
  }
  const speech = parsed.speech;
  if (!isRecord(speech) || (speech.action !== "reply" && speech.action !== "silent")) {
    throw new Error("ChatMentionDecision.speech.action must be reply or silent");
  }
  return {
    schema: "ChatMentionDecision@1",
    speech: speech.action === "reply"
      ? {
          action: "reply",
          body: requireText(speech.body, "ChatMentionDecision.speech.body")
        }
      : { action: "silent" }
  };
}

export function availableChatDecision(scope: ChatPresenceScope = "topic"): ChatDecision {
  return {
    schema: "ChatDecision@1",
    speech: { action: "silent" },
    presence: { scope, mode: "available", wakeKeywords: [] }
  };
}

export function silentChatMentionDecision(): ChatMentionDecision {
  return {
    schema: "ChatMentionDecision@1",
    speech: { action: "silent" }
  };
}

export function parseChatPresence(value: unknown, now = new Date().toISOString()): ChatPresence {
  if (!isRecord(value) || (value.scope !== "topic" && value.scope !== "global")) {
    throw new Error("ChatDecision.presence.scope must be topic or global");
  }
  if (value.mode === "available") {
    return { scope: value.scope, mode: "available", wakeKeywords: [] };
  }
  if (value.mode !== "snoozed") {
    throw new Error("ChatDecision.presence.mode must be available or snoozed");
  }
  const until = iso(value.until, "ChatDecision.presence.until");
  if (Date.parse(until) <= Date.parse(iso(now, "now"))) {
    throw new Error("ChatDecision.presence.until must be in the future");
  }
  if (!Array.isArray(value.wakeKeywords)) {
    throw new Error("ChatDecision.presence.wakeKeywords must be an array");
  }
  const wakeKeywords = [...new Set(value.wakeKeywords.map(
    (keyword) => requireText(keyword, "ChatDecision.presence.wakeKeywords[]")
  ))];
  return {
    scope: value.scope,
    mode: "snoozed",
    until,
    wakeKeywords
  };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be non-empty`);
  }
  return value.trim();
}

function iso(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be ISO-8601`);
  }
  return new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
