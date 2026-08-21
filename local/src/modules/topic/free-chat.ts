export const freeChatModeReceiptSchema = "FreeChatModeReceipt@1" as const;

export type FreeChatModeStatus = "active" | "exited" | "stopped" | "expired";
export type FreeChatStopReason =
  | "owner_exit"
  | "topic_paused"
  | "empty_roster"
  | "consecutive_silence"
  | "max_duration"
  | "max_cycles"
  | "max_turns";

export interface FreeChatIntentSelection {
  readonly schema: "ConversationIntentSnapshot@1";
  readonly mode: "continue_recent" | "selected_theme" | "directed";
  readonly brief?: string;
  readonly themeId?: string;
  readonly governanceRevision: number;
}

export interface FreeChatSample {
  readonly cycleIndex: number;
  readonly sampledAt: string;
  readonly idleDelayMinutes: number;
  readonly idleDeadline: string;
  readonly participantCount: number;
  readonly candidateAgentIds: readonly string[];
  readonly conversationIntent: FreeChatIntentSelection;
}

export interface FreeChatMode {
  readonly modeId: string;
  readonly topicId: string;
  readonly status: FreeChatModeStatus;
  readonly intentPolicy:
    | { readonly kind: "continue_recent" }
    | { readonly kind: "choose_from_themes" }
    | { readonly kind: "fixed_directed"; readonly brief: string };
  readonly strategyRevision: 1;
  readonly limits: {
    readonly maxDurationMinutes: number;
    readonly maxCycles: number;
    readonly maxTurns: number;
    readonly consecutiveSilenceLimit: number;
  };
  readonly cycleIndex: number;
  readonly sample: FreeChatSample;
  readonly lastMeaningfulActivityAt: string;
  readonly lastMeaningfulEventId?: string;
  readonly consecutiveSilentCycles: number;
  readonly admittedTurns: number;
  readonly pendingActivationEventId?: string;
  readonly revision: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly stoppedAt?: string;
  readonly stopReason?: FreeChatStopReason;
}

export type FreeChatModeReceiptAction =
  | "started"
  | "contribution_observed"
  | "roster_changed"
  | "activation_admitted"
  | "cycle_silent"
  | "continued_now"
  | "exited"
  | "stopped";

export interface FreeChatModeReceipt {
  readonly schema: typeof freeChatModeReceiptSchema;
  readonly receiptId: string;
  readonly modeId: string;
  readonly topicId: string;
  readonly sequence: number;
  readonly action: FreeChatModeReceiptAction;
  readonly previousRevision: number | null;
  readonly resultingRevision: number;
  readonly cycleIndex: number;
  readonly details: Readonly<Record<string, string | number | boolean>>;
  readonly createdAt: string;
}

export interface FreeChatCandidate {
  readonly agentId: string;
  readonly lastSpokeAt?: string;
}

export interface FreeChatTheme {
  readonly themeId: string;
  readonly brief: string;
}

export interface FreeChatSampleInput {
  readonly modeId: string;
  readonly cycleIndex: number;
  readonly sampledAt: string;
  readonly governanceRevision: number;
  readonly intentPolicy: FreeChatMode["intentPolicy"];
  readonly candidates: readonly FreeChatCandidate[];
  readonly themes: readonly FreeChatTheme[];
}

export function sampleFreeChatCycle(input: FreeChatSampleInput): FreeChatSample {
  const modeId = text(input.modeId, "modeId", 256);
  const cycleIndex = integer(input.cycleIndex, "cycleIndex", 1, 1_000_000);
  const sampledAt = iso(input.sampledAt, "sampledAt");
  const governanceRevision = integer(
    input.governanceRevision, "governanceRevision", 1, 1_000_000
  );
  const candidates = unique(input.candidates.map((candidate) => ({
    agentId: text(candidate.agentId, "candidate.agentId", 256),
    ...(candidate.lastSpokeAt === undefined
      ? {}
      : { lastSpokeAt: iso(candidate.lastSpokeAt, "candidate.lastSpokeAt") })
  })));
  if (candidates.length === 0) throw new Error("Free Chat sample requires a candidate");
  const seed = `${modeId}:${cycleIndex}:v1`;
  const delays = [5, 10, 15, 20, 30] as const;
  const idleDelayMinutes = weightedPick(delays, [1, 3, 3, 2, 1], `${seed}:idle`);
  const maximumParticipants = Math.min(candidates.length, 3);
  const participantCounts = Array.from(
    { length: maximumParticipants }, (_, index) => index + 1
  );
  const participantCount = weightedPick(
    participantCounts,
    participantCounts.map((count) => maximumParticipants - count + 1),
    `${seed}:count`
  );
  const ranked = [...candidates].sort((left, right) => {
    const leftAt = left.lastSpokeAt === undefined ? Number.NEGATIVE_INFINITY
      : Date.parse(left.lastSpokeAt);
    const rightAt = right.lastSpokeAt === undefined ? Number.NEGATIVE_INFINITY
      : Date.parse(right.lastSpokeAt);
    return leftAt - rightAt || left.agentId.localeCompare(right.agentId);
  });
  const remaining = [...ranked];
  const candidateAgentIds: string[] = [];
  for (let index = 0; index < participantCount; index += 1) {
    const selected = weightedIndex(
      remaining.map((_, rank) => remaining.length - rank),
      `${seed}:agent:${index}`
    );
    candidateAgentIds.push(remaining.splice(selected, 1)[0]!.agentId);
  }
  const themes = [...input.themes]
    .map((theme) => ({
      themeId: text(theme.themeId, "theme.themeId", 128),
      brief: text(theme.brief, "theme.brief", 4_096)
    }))
    .sort((left, right) => left.themeId.localeCompare(right.themeId));
  const conversationIntent = selectIntent(
    input.intentPolicy, themes, governanceRevision, `${seed}:intent`
  );
  return {
    cycleIndex,
    sampledAt,
    idleDelayMinutes,
    idleDeadline: new Date(
      Date.parse(sampledAt) + idleDelayMinutes * 60_000
    ).toISOString(),
    participantCount,
    candidateAgentIds,
    conversationIntent
  };
}

export function parseFreeChatMode(value: unknown): FreeChatMode {
  const record = object(value, "FreeChatMode");
  const sample = parseSample(record.sample);
  const limits = object(record.limits, "limits");
  const intentPolicy = parseIntentPolicy(record.intentPolicy);
  const status = oneOf(
    record.status, ["active", "exited", "stopped", "expired"] as const, "status"
  );
  const stoppedAt = record.stoppedAt === undefined
    ? undefined : iso(record.stoppedAt, "stoppedAt");
  const stopReason = record.stopReason === undefined
    ? undefined
    : oneOf(record.stopReason, [
        "owner_exit", "topic_paused", "empty_roster", "consecutive_silence",
        "max_duration", "max_cycles", "max_turns"
      ] as const, "stopReason");
  if ((status === "active") === (stoppedAt !== undefined || stopReason !== undefined)) {
    throw new Error("Free Chat terminal fields must agree with status");
  }
  return {
    modeId: text(record.modeId, "modeId", 256),
    topicId: text(record.topicId, "topicId", 256),
    status,
    intentPolicy,
    strategyRevision: record.strategyRevision === 1
      ? 1 : fail("strategyRevision must be 1"),
    limits: {
      maxDurationMinutes: integer(
        limits.maxDurationMinutes, "maxDurationMinutes", 1, 7 * 24 * 60
      ),
      maxCycles: integer(limits.maxCycles, "maxCycles", 1, 10_000),
      maxTurns: integer(limits.maxTurns, "maxTurns", 1, 100_000),
      consecutiveSilenceLimit: integer(
        limits.consecutiveSilenceLimit, "consecutiveSilenceLimit", 1, 100
      )
    },
    cycleIndex: integer(record.cycleIndex, "cycleIndex", 1, 1_000_000),
    sample,
    lastMeaningfulActivityAt: iso(
      record.lastMeaningfulActivityAt, "lastMeaningfulActivityAt"
    ),
    ...(record.lastMeaningfulEventId === undefined
      ? {}
      : { lastMeaningfulEventId: text(record.lastMeaningfulEventId, "lastMeaningfulEventId", 256) }),
    consecutiveSilentCycles: integer(
      record.consecutiveSilentCycles, "consecutiveSilentCycles", 0, 100_000
    ),
    admittedTurns: integer(record.admittedTurns, "admittedTurns", 0, 100_000),
    ...(record.pendingActivationEventId === undefined
      ? {}
      : {
          pendingActivationEventId: text(
            record.pendingActivationEventId, "pendingActivationEventId", 256
          )
        }),
    revision: integer(record.revision, "revision", 1, 1_000_000),
    startedAt: iso(record.startedAt, "startedAt"),
    updatedAt: iso(record.updatedAt, "updatedAt"),
    ...(stoppedAt === undefined ? {} : { stoppedAt }),
    ...(stopReason === undefined ? {} : { stopReason })
  };
}

export function freeChatReceipt(input: {
  readonly mode: FreeChatMode;
  readonly action: FreeChatModeReceiptAction;
  readonly previousRevision: number | null;
  readonly sequence: number;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly createdAt: string;
}): FreeChatModeReceipt {
  const resultingRevision = input.mode.revision;
  if (resultingRevision !== (input.previousRevision ?? 0) + 1) {
    throw new Error("Free Chat receipt revision must advance by one");
  }
  return {
    schema: freeChatModeReceiptSchema,
    receiptId: `free-chat:${input.mode.modeId}:${input.sequence}`,
    modeId: input.mode.modeId,
    topicId: input.mode.topicId,
    sequence: integer(input.sequence, "sequence", 1, 1_000_000),
    action: input.action,
    previousRevision: input.previousRevision,
    resultingRevision,
    cycleIndex: input.mode.cycleIndex,
    details: input.details ?? {},
    createdAt: iso(input.createdAt, "createdAt")
  };
}

export function parseFreeChatModeReceipt(value: unknown): FreeChatModeReceipt {
  const record = object(value, "FreeChatModeReceipt");
  if (record.schema !== freeChatModeReceiptSchema) {
    throw new Error("Free Chat receipt schema is unsupported");
  }
  const detailsRecord = object(record.details, "details");
  const details: Record<string, string | number | boolean> = {};
  for (const [key, detail] of Object.entries(detailsRecord)) {
    if (typeof detail !== "string" && typeof detail !== "number" &&
      typeof detail !== "boolean") {
      throw new Error("Free Chat receipt details must be scalar");
    }
    details[text(key, "details key", 128)] = detail;
  }
  const modeId = text(record.modeId, "modeId", 256);
  const sequence = integer(record.sequence, "sequence", 1, 1_000_000);
  const receiptId = text(record.receiptId, "receiptId", 512);
  if (receiptId !== `free-chat:${modeId}:${sequence}`) {
    throw new Error("Free Chat receiptId is not canonical");
  }
  return {
    schema: freeChatModeReceiptSchema,
    receiptId,
    modeId,
    topicId: text(record.topicId, "topicId", 256),
    sequence,
    action: oneOf(record.action, [
      "started", "contribution_observed", "roster_changed", "activation_admitted",
      "cycle_silent", "continued_now", "exited", "stopped"
    ] as const, "action"),
    previousRevision: record.previousRevision === null
      ? null
      : integer(record.previousRevision, "previousRevision", 1, 1_000_000),
    resultingRevision: integer(
      record.resultingRevision, "resultingRevision", 1, 1_000_000
    ),
    cycleIndex: integer(record.cycleIndex, "cycleIndex", 1, 1_000_000),
    details,
    createdAt: iso(record.createdAt, "createdAt")
  };
}

function selectIntent(
  policy: FreeChatMode["intentPolicy"],
  themes: readonly FreeChatTheme[],
  governanceRevision: number,
  seed: string
): FreeChatIntentSelection {
  if (policy.kind === "continue_recent") {
    return {
      schema: "ConversationIntentSnapshot@1",
      mode: "continue_recent",
      governanceRevision
    };
  }
  if (policy.kind === "fixed_directed") {
    return {
      schema: "ConversationIntentSnapshot@1",
      mode: "directed",
      brief: text(policy.brief, "fixedBrief", 4_096),
      governanceRevision
    };
  }
  if (themes.length === 0) {
    throw new Error("choose_from_themes requires an active theme");
  }
  const theme = themes[hash(seed) % themes.length]!;
  return {
    schema: "ConversationIntentSnapshot@1",
    mode: "selected_theme",
    themeId: theme.themeId,
    brief: theme.brief,
    governanceRevision
  };
}

function parseSample(value: unknown): FreeChatSample {
  const record = object(value, "sample");
  const intent = object(record.conversationIntent, "conversationIntent");
  return {
    cycleIndex: integer(record.cycleIndex, "sample.cycleIndex", 1, 1_000_000),
    sampledAt: iso(record.sampledAt, "sample.sampledAt"),
    idleDelayMinutes: integer(record.idleDelayMinutes, "idleDelayMinutes", 1, 1_440),
    idleDeadline: iso(record.idleDeadline, "idleDeadline"),
    participantCount: integer(record.participantCount, "participantCount", 1, 64),
    candidateAgentIds: uniqueText(record.candidateAgentIds, "candidateAgentIds"),
    conversationIntent: {
      schema: intent.schema === "ConversationIntentSnapshot@1"
        ? intent.schema : fail("conversationIntent schema is unsupported"),
      mode: oneOf(
        intent.mode,
        ["continue_recent", "selected_theme", "directed"] as const,
        "conversationIntent.mode"
      ),
      ...(intent.brief === undefined
        ? {} : { brief: text(intent.brief, "conversationIntent.brief", 4_096) }),
      ...(intent.themeId === undefined
        ? {} : { themeId: text(intent.themeId, "conversationIntent.themeId", 128) }),
      governanceRevision: integer(
        intent.governanceRevision, "conversationIntent.governanceRevision", 1, 1_000_000
      )
    }
  };
}

function parseIntentPolicy(value: unknown): FreeChatMode["intentPolicy"] {
  const record = object(value, "intentPolicy");
  const kind = oneOf(
    record.kind,
    ["continue_recent", "choose_from_themes", "fixed_directed"] as const,
    "intentPolicy.kind"
  );
  return kind === "fixed_directed"
    ? { kind, brief: text(record.brief, "intentPolicy.brief", 4_096) }
    : { kind };
}

function weightedPick<T>(items: readonly T[], weights: readonly number[], seed: string): T {
  return items[weightedIndex(weights, seed)]!;
}

function weightedIndex(weights: readonly number[], seed: string): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = hash(seed) % total;
  for (let index = 0; index < weights.length; index += 1) {
    cursor -= weights[index]!;
    if (cursor < 0) return index;
  }
  return weights.length - 1;
}

function hash(value: string): number {
  let result = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619);
  }
  return result >>> 0;
}

function unique(candidates: readonly FreeChatCandidate[]): FreeChatCandidate[] {
  const seen = new Set<string>();
  return candidates.filter(({ agentId }) => {
    if (seen.has(agentId)) throw new Error(`Duplicate Free Chat candidate: ${agentId}`);
    seen.add(agentId);
    return true;
  });
}

function uniqueText(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return unique(value.map((entry) => ({ agentId: text(entry, field, 256) })))
    .map(({ agentId }) => agentId);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function oneOf<const T extends readonly string[]>(
  value: unknown, values: T, field: string
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${field} is unsupported`);
  }
  return value as T[number];
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 ||
    value.trim().length > maximum) {
    throw new Error(`${field} must contain 1-${maximum} characters`);
  }
  return value.trim();
}

function integer(
  value: unknown, field: string, minimum: number, maximum: number
): number {
  if (!Number.isInteger(value) || (value as number) < minimum ||
    (value as number) > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function iso(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be RFC3339`);
  }
  return value;
}

function fail(message: string): never {
  throw new Error(message);
}
