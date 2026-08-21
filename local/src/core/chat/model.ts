export const chatPromptResourceId = "prompt.chat.free-turn" as const;
export const chatMentionPromptResourceId = "prompt.chat.mentioned-turn" as const;

export interface ConversationIntentSnapshot {
  readonly schema: "ConversationIntentSnapshot@1";
  readonly mode: "continue_recent" | "selected_theme" | "directed";
  readonly brief?: string;
  readonly themeId?: string;
  readonly governanceRevision: number;
}

export function parseConversationIntentSnapshot(
  value: unknown
): ConversationIntentSnapshot {
  if (!isRecord(value) || value.schema !== "ConversationIntentSnapshot@1" ||
    (value.mode !== "continue_recent" && value.mode !== "selected_theme" &&
      value.mode !== "directed") ||
    !Number.isInteger(value.governanceRevision) ||
    (value.governanceRevision as number) < 1) {
    throw new Error("ConversationIntentSnapshot@1 is malformed");
  }
  const brief = value.brief === undefined
    ? undefined
    : boundedText(value.brief, "ConversationIntentSnapshot.brief", 4_096);
  const themeId = value.themeId === undefined
    ? undefined
    : boundedText(value.themeId, "ConversationIntentSnapshot.themeId", 128);
  if (value.mode === "continue_recent" && (brief !== undefined || themeId !== undefined)) {
    throw new Error("continue_recent intent cannot carry a brief or themeId");
  }
  if (value.mode === "selected_theme" && (brief === undefined || themeId === undefined)) {
    throw new Error("selected_theme intent requires brief and themeId");
  }
  if (value.mode === "directed" && (brief === undefined || themeId !== undefined)) {
    throw new Error("directed intent requires only a brief");
  }
  return {
    schema: "ConversationIntentSnapshot@1",
    mode: value.mode,
    ...(brief === undefined ? {} : { brief }),
    ...(themeId === undefined ? {} : { themeId }),
    governanceRevision: value.governanceRevision as number
  };
}

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
  readonly replyToEventId?: string;
  readonly targets?: readonly import("../event/model.js").ChatMessageTarget[];
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

export type ClientHistoryRequest =
  | {
      readonly schema: "ClientHistoryRequest@1";
      readonly action: "search";
      readonly query: string;
      readonly limit: number;
    }
  | {
      readonly schema: "ClientHistoryRequest@1";
      readonly action: "read";
      readonly reference: string;
    };

export interface ClientHistoryResult {
  readonly schema: "ClientHistoryResult@1";
  readonly client: import("../../modules/agent/client-profile.js").AgentClient;
  readonly action: "search" | "read";
  readonly items: readonly {
    readonly reference: string;
    readonly occurredAt: string;
    readonly content: string;
  }[];
  readonly truncated: boolean;
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
    | { readonly action: "silent"; readonly reason: string };
  readonly presence: ChatPresence;
};

export type ChatMentionDecision = {
  readonly schema: "ChatMentionDecision@1";
  readonly speech:
    | { readonly action: "reply"; readonly body: string }
    | { readonly action: "silent"; readonly reason: string };
};

export type ChatTurnDecision = ChatDecision | ChatMentionDecision;

export interface ChatProfileContext {
  readonly schema: "ChatProfileContext@1";
  readonly visibility: "public";
  readonly resolvedAt: string;
  readonly validUntil: string;
  readonly agent: {
    readonly agentId: string;
    readonly displayName: string;
    readonly role: string;
    readonly disclosure: string;
    readonly expressionRules: readonly string[];
    readonly revision: number;
  };
  readonly topic: {
    readonly topicId: string;
    readonly purpose: string;
    readonly participationRules: readonly string[];
    readonly expressionRules: readonly string[];
    readonly revision: number;
  };
  readonly precedence: "topic-rules-further-restrict-agent-rules";
}

export function parseChatProfileContext(
  value: unknown,
  expectedAgentId: string,
  expectedTopicId: string,
  at: string
): ChatProfileContext {
  if (!isRecord(value) || value.schema !== "ChatProfileContext@1" ||
    value.visibility !== "public" ||
    value.precedence !== "topic-rules-further-restrict-agent-rules" ||
    !isRecord(value.agent) || !isRecord(value.topic)) {
    throw new Error("Public Chat requires ChatProfileContext@1");
  }
  const resolvedAt = iso(value.resolvedAt, "ChatProfileContext.resolvedAt");
  const validUntil = iso(value.validUntil, "ChatProfileContext.validUntil");
  if (Date.parse(resolvedAt) > Date.parse(at) || Date.parse(validUntil) < Date.parse(at)) {
    throw new Error("Public Chat profile context is stale");
  }
  const agentId = boundedText(value.agent.agentId, "ChatProfileContext.agent.agentId", 255);
  const topicId = boundedText(value.topic.topicId, "ChatProfileContext.topic.topicId", 255);
  if (agentId !== expectedAgentId || topicId !== expectedTopicId) {
    throw new Error("Public Chat profile context identity does not match dispatch");
  }
  return {
    schema: "ChatProfileContext@1",
    visibility: "public",
    resolvedAt,
    validUntil,
    agent: {
      agentId,
      displayName: boundedText(value.agent.displayName,
        "ChatProfileContext.agent.displayName", 255),
      role: boundedText(value.agent.role, "ChatProfileContext.agent.role", 2_000),
      disclosure: boundedText(value.agent.disclosure,
        "ChatProfileContext.agent.disclosure", 2_000),
      expressionRules: boundedRules(value.agent.expressionRules,
        "ChatProfileContext.agent.expressionRules"),
      revision: positiveRevision(value.agent.revision,
        "ChatProfileContext.agent.revision")
    },
    topic: {
      topicId,
      purpose: boundedText(value.topic.purpose, "ChatProfileContext.topic.purpose", 4_000),
      participationRules: boundedRules(value.topic.participationRules,
        "ChatProfileContext.topic.participationRules"),
      expressionRules: boundedRules(value.topic.expressionRules,
        "ChatProfileContext.topic.expressionRules"),
      revision: positiveRevision(value.topic.revision,
        "ChatProfileContext.topic.revision")
    },
    precedence: "topic-rules-further-restrict-agent-rules"
  };
}

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

export function parseClientHistoryRequest(value: string): ClientHistoryRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.schema !== "ClientHistoryRequest@1") return undefined;
  if (parsed.action === "search") {
    if (typeof parsed.query !== "string" || parsed.query.length > 500 ||
      !Number.isInteger(parsed.limit) || (parsed.limit as number) < 1 ||
      (parsed.limit as number) > 20) {
      throw new Error("ClientHistoryRequest search is malformed");
    }
    return {
      schema: "ClientHistoryRequest@1",
      action: "search",
      query: parsed.query,
      limit: parsed.limit as number
    };
  }
  if (parsed.action === "read" && typeof parsed.reference === "string" &&
    /^[a-z-]+:[a-f0-9]{24}(?::[a-f0-9]{1,16})?$/.test(parsed.reference)) {
    return {
      schema: "ClientHistoryRequest@1",
      action: "read",
      reference: parsed.reference
    };
  }
  throw new Error("ClientHistoryRequest is malformed");
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
    : {
        action: "silent" as const,
        reason: boundedText(speech.reason, "ChatDecision.speech.reason", 200)
      };
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
      : {
          action: "silent",
          reason: boundedText(speech.reason, "ChatMentionDecision.speech.reason", 200)
        }
  };
}

export function availableChatDecision(scope: ChatPresenceScope = "topic"): ChatDecision {
  return {
    schema: "ChatDecision@1",
    speech: { action: "silent", reason: "No useful contribution for this turn." },
    presence: { scope, mode: "available", wakeKeywords: [] }
  };
}

export function silentChatMentionDecision(): ChatMentionDecision {
  return {
    schema: "ChatMentionDecision@1",
    speech: { action: "silent", reason: "No useful reply to this mention." }
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

function boundedText(value: unknown, field: string, maximum: number): string {
  const text = requireText(value, field);
  if (text.length > maximum) throw new Error(`${field} exceeds ${maximum} characters`);
  return text;
}

function boundedRules(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`${field} must contain at most 32 rules`);
  }
  return value.map((rule) => boundedText(rule, `${field}[]`, 500));
}

function positiveRevision(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
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
