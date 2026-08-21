export const topicGovernanceControlReceiptSchema =
  "TopicGovernanceControlReceipt@1" as const;

export type TopicGovernanceStatus = "active" | "paused";
export type TopicParticipantStatus = "active" | "removed";
export type TopicConversationIntent = "continue_recent" | "choose_from_themes";
export type TopicThemeStatus = "active" | "archived";

export interface TopicParticipant {
  readonly agentId: string;
  readonly status: TopicParticipantStatus;
  readonly joinedAt: string;
  readonly removedAt?: string;
  readonly governanceRevision: number;
}

export interface TopicStrategyPolicy {
  readonly starterEnabled: boolean;
  readonly participantMessageEnabled: boolean;
  readonly scheduledEnabled: boolean;
}

export interface TopicConversationTheme {
  readonly themeId: string;
  readonly title: string;
  readonly brief: string;
  readonly status: TopicThemeStatus;
}

export interface TopicConversationPolicy {
  readonly defaultIntent: TopicConversationIntent;
  readonly themes: readonly TopicConversationTheme[];
}

export interface TopicGovernance {
  readonly topicId: string;
  readonly status: TopicGovernanceStatus;
  readonly participants: readonly TopicParticipant[];
  readonly strategyPolicy: TopicStrategyPolicy;
  readonly conversationPolicy: TopicConversationPolicy;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TopicGovernanceControlAction =
  | "materialize_default"
  | "pause"
  | "resume"
  | "participant_add"
  | "participant_remove"
  | "strategy_policy_update"
  | "conversation_policy_update";

export interface TopicGovernanceControlReceipt {
  readonly schema: typeof topicGovernanceControlReceiptSchema;
  readonly receiptId: string;
  readonly topicId: string;
  readonly action: TopicGovernanceControlAction;
  readonly actor: {
    readonly kind: "system" | "owner";
    readonly principalId?: string;
  };
  readonly previousRevision: number | null;
  readonly resultingRevision: number;
  readonly changedFields: readonly string[];
  readonly createdAt: string;
}

export interface TopicGovernanceMaterialization {
  readonly governance: TopicGovernance;
  readonly receipt: TopicGovernanceControlReceipt;
  readonly created: boolean;
}

export type TopicGovernanceRevisionState = Pick<
  TopicGovernance,
  "status" | "participants" | "strategyPolicy" | "conversationPolicy"
>;

export interface TopicGovernanceRevisionInput {
  readonly expectedRevision: number;
  readonly action: Exclude<TopicGovernanceControlAction, "materialize_default">;
  readonly actor: TopicGovernanceControlReceipt["actor"];
  readonly changedFields: readonly string[];
  readonly next: TopicGovernanceRevisionState;
}

export interface TopicGovernanceTransition {
  readonly changedFields: readonly string[];
  readonly next: TopicGovernanceRevisionState;
}

export function transitionTopicGovernanceStatus(
  current: TopicGovernance,
  status: TopicGovernanceStatus
): TopicGovernanceTransition | undefined {
  if (current.status === status) return undefined;
  return {
    changedFields: ["status"],
    next: {
      status,
      participants: current.participants,
      strategyPolicy: current.strategyPolicy,
      conversationPolicy: current.conversationPolicy
    }
  };
}

export function transitionTopicParticipant(
  current: TopicGovernance,
  agentIdInput: string,
  status: TopicParticipantStatus,
  atInput: string
): TopicGovernanceTransition | undefined {
  const agentId = boundedText(agentIdInput, "agentId", 256);
  const at = iso(atInput, "at");
  const existing = current.participants.find((participant) => participant.agentId === agentId);
  if ((status === "active" && existing?.status === "active") ||
    (status === "removed" && existing?.status !== "active")) {
    return undefined;
  }
  const governanceRevision = current.revision + 1;
  const participant: TopicParticipant = status === "active"
    ? { agentId, status, joinedAt: at, governanceRevision }
    : {
        ...existing!,
        status,
        removedAt: at,
        governanceRevision
      };
  const participants = existing === undefined
    ? [...current.participants, participant]
    : current.participants.map((candidate) =>
        candidate.agentId === agentId ? participant : candidate);
  return {
    changedFields: ["participants"],
    next: {
      status: current.status,
      participants,
      strategyPolicy: current.strategyPolicy,
      conversationPolicy: current.conversationPolicy
    }
  };
}

export function defaultTopicGovernance(
  topicIdInput: string,
  activeAgentIdsInput: readonly string[],
  atInput: string
): TopicGovernance {
  const topicId = boundedText(topicIdInput, "topicId", 256);
  const at = iso(atInput, "at");
  const activeAgentIds = uniqueIds(
    activeAgentIdsInput.map((agentId, index) =>
      boundedText(agentId, `activeAgentIds[${index}]`, 256)),
    "activeAgentIds"
  );
  return {
    topicId,
    status: "active",
    participants: activeAgentIds.map((agentId) => ({
      agentId,
      status: "active",
      joinedAt: at,
      governanceRevision: 1
    })),
    strategyPolicy: {
      starterEnabled: true,
      participantMessageEnabled: true,
      scheduledEnabled: true
    },
    conversationPolicy: {
      defaultIntent: "continue_recent",
      themes: []
    },
    revision: 1,
    createdAt: at,
    updatedAt: at
  };
}

export function parseTopicGovernance(value: unknown): TopicGovernance {
  const record = object(value, "TopicGovernance");
  const topicId = boundedText(record.topicId, "topicId", 256);
  const status = oneOf(record.status, ["active", "paused"] as const, "status");
  const revision = positiveInteger(record.revision, "revision");
  const createdAt = iso(record.createdAt, "createdAt");
  const updatedAt = iso(record.updatedAt, "updatedAt");
  const participants = array(record.participants, "participants").map((entry, index) =>
    parseParticipant(entry, revision, index));
  uniqueIds(participants.map(({ agentId }) => agentId), "participants.agentId");
  const strategy = object(record.strategyPolicy, "strategyPolicy");
  const conversation = object(record.conversationPolicy, "conversationPolicy");
  const themes = array(conversation.themes, "conversationPolicy.themes")
    .map((entry, index) => parseTheme(entry, index));
  uniqueIds(themes.map(({ themeId }) => themeId), "conversationPolicy.themes.themeId");
  const defaultIntent = oneOf(
    conversation.defaultIntent,
    ["continue_recent", "choose_from_themes"] as const,
    "conversationPolicy.defaultIntent"
  );
  if (defaultIntent === "choose_from_themes" &&
    !themes.some(({ status: themeStatus }) => themeStatus === "active")) {
    throw new Error("choose_from_themes requires at least one active theme");
  }
  return {
    topicId,
    status,
    participants,
    strategyPolicy: {
      starterEnabled: boolean(strategy.starterEnabled, "strategyPolicy.starterEnabled"),
      participantMessageEnabled: boolean(
        strategy.participantMessageEnabled,
        "strategyPolicy.participantMessageEnabled"
      ),
      scheduledEnabled: boolean(strategy.scheduledEnabled, "strategyPolicy.scheduledEnabled")
    },
    conversationPolicy: { defaultIntent, themes },
    revision,
    createdAt,
    updatedAt
  };
}

export function parseTopicGovernanceControlReceipt(
  value: unknown
): TopicGovernanceControlReceipt {
  const record = object(value, "TopicGovernanceControlReceipt");
  if (record.schema !== topicGovernanceControlReceiptSchema) {
    throw new Error(
      `Topic governance receipt schema must be ${topicGovernanceControlReceiptSchema}`
    );
  }
  const actor = object(record.actor, "actor");
  const kind = oneOf(actor.kind, ["system", "owner"] as const, "actor.kind");
  const principalId = actor.principalId === undefined
    ? undefined
    : boundedText(actor.principalId, "actor.principalId", 256);
  if (kind === "owner" && principalId === undefined) {
    throw new Error("owner receipt actor requires principalId");
  }
  const previousRevision = record.previousRevision === null
    ? null
    : positiveInteger(record.previousRevision, "previousRevision");
  const resultingRevision = positiveInteger(record.resultingRevision, "resultingRevision");
  if (resultingRevision !== (previousRevision ?? 0) + 1) {
    throw new Error("Topic governance receipt revisions must advance by one");
  }
  const topicId = boundedText(record.topicId, "topicId", 256);
  const action = oneOf(record.action, [
    "materialize_default",
    "pause",
    "resume",
    "participant_add",
    "participant_remove",
    "strategy_policy_update",
    "conversation_policy_update"
  ] as const, "action");
  if ((previousRevision === null) !== (action === "materialize_default")) {
    throw new Error("Only initial Topic governance materialization may omit previousRevision");
  }
  if (action === "materialize_default" && kind !== "system") {
    throw new Error("Topic governance materialization receipt actor must be system");
  }
  const receiptIdValue = boundedText(record.receiptId, "receiptId", 768);
  if (receiptIdValue !== receiptId(topicId, resultingRevision)) {
    throw new Error("Topic governance receiptId must match topicId and resultingRevision");
  }
  return {
    schema: topicGovernanceControlReceiptSchema,
    receiptId: receiptIdValue,
    topicId,
    action,
    actor: {
      kind,
      ...(principalId === undefined ? {} : { principalId })
    },
    previousRevision,
    resultingRevision,
    changedFields: uniqueIds(
      array(record.changedFields, "changedFields")
        .map((entry, index) => boundedText(entry, `changedFields[${index}]`, 128)),
      "changedFields"
    ),
    createdAt: iso(record.createdAt, "createdAt")
  };
}

export function materializationReceipt(
  governance: TopicGovernance
): TopicGovernanceControlReceipt {
  return {
    schema: topicGovernanceControlReceiptSchema,
    receiptId: receiptId(governance.topicId, governance.revision),
    topicId: governance.topicId,
    action: "materialize_default",
    actor: { kind: "system" },
    previousRevision: null,
    resultingRevision: governance.revision,
    changedFields: [
      "status",
      "participants",
      "strategyPolicy",
      "conversationPolicy"
    ],
    createdAt: governance.createdAt
  };
}

export function revisionReceipt(input: {
  readonly topicId: string;
  readonly action: Exclude<TopicGovernanceControlAction, "materialize_default">;
  readonly actor: TopicGovernanceControlReceipt["actor"];
  readonly previousRevision: number;
  readonly changedFields: readonly string[];
  readonly createdAt: string;
}): TopicGovernanceControlReceipt {
  const resultingRevision = positiveInteger(
    input.previousRevision,
    "previousRevision"
  ) + 1;
  const receipt = parseTopicGovernanceControlReceipt({
    schema: topicGovernanceControlReceiptSchema,
    receiptId: receiptId(input.topicId, resultingRevision),
    topicId: input.topicId,
    action: input.action,
    actor: input.actor,
    previousRevision: input.previousRevision,
    resultingRevision,
    changedFields: input.changedFields,
    createdAt: input.createdAt
  });
  if (receipt.changedFields.length === 0) {
    throw new Error("Topic governance receipt must name at least one changed field");
  }
  return receipt;
}

export function topicGovernanceReceiptId(topicId: string, revision: number): string {
  return receiptId(
    boundedText(topicId, "topicId", 256),
    positiveInteger(revision, "revision")
  );
}

function parseParticipant(
  value: unknown,
  currentRevision: number,
  index: number
): TopicParticipant {
  const record = object(value, `participants[${index}]`);
  const status = oneOf(
    record.status,
    ["active", "removed"] as const,
    `participants[${index}].status`
  );
  const removedAt = record.removedAt === undefined
    ? undefined
    : iso(record.removedAt, `participants[${index}].removedAt`);
  if ((status === "removed") !== (removedAt !== undefined)) {
    throw new Error(`participants[${index}] removed status and removedAt must agree`);
  }
  const governanceRevision = positiveInteger(
    record.governanceRevision,
    `participants[${index}].governanceRevision`
  );
  if (governanceRevision > currentRevision) {
    throw new Error(`participants[${index}] revision cannot exceed governance revision`);
  }
  return {
    agentId: boundedText(record.agentId, `participants[${index}].agentId`, 256),
    status,
    joinedAt: iso(record.joinedAt, `participants[${index}].joinedAt`),
    ...(removedAt === undefined ? {} : { removedAt }),
    governanceRevision
  };
}

function parseTheme(value: unknown, index: number): TopicConversationTheme {
  const record = object(value, `conversationPolicy.themes[${index}]`);
  return {
    themeId: boundedText(record.themeId, `themes[${index}].themeId`, 128),
    title: boundedText(record.title, `themes[${index}].title`, 160),
    brief: boundedText(record.brief, `themes[${index}].brief`, 4096),
    status: oneOf(
      record.status,
      ["active", "archived"] as const,
      `themes[${index}].status`
    )
  };
}

function receiptId(topicId: string, revision: number): string {
  return `topic-governance:${topicId}:${revision}`;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be text`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${field} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function iso(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an RFC3339 timestamp`);
  }
  return value;
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  field: string
): Values[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as Values[number];
}

function uniqueIds(values: readonly string[], field: string): readonly string[] {
  const unique = new Set(values);
  if (unique.size !== values.length) throw new Error(`${field} must not contain duplicates`);
  return [...values];
}
