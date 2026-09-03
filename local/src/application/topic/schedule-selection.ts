import type { ConversationIntentSnapshot } from "../../core/chat/model.js";
import type { TopicActivationIntentPolicy } from "../../modules/topic/schedule.js";

export interface TopicActivationCandidate {
  readonly agentId: string;
  readonly lastSpokeAt?: string;
}

export interface TopicActivationSelection {
  readonly candidateAgentIds: readonly string[];
  readonly conversationIntent: ConversationIntentSnapshot;
}

export function selectTopicActivation(input: {
  readonly selectionId: string;
  readonly governanceRevision: number;
  readonly intentPolicy: TopicActivationIntentPolicy;
  readonly candidates: readonly TopicActivationCandidate[];
  readonly themes: readonly { readonly themeId: string; readonly brief: string }[];
}): TopicActivationSelection {
  const selectionId = text(input.selectionId, "selectionId", 512);
  const governanceRevision = integer(
    input.governanceRevision, "governanceRevision", 1, 1_000_000
  );
  const seen = new Set<string>();
  const candidates = input.candidates.map((candidate) => {
    const agentId = text(candidate.agentId, "candidate.agentId", 256);
    if (seen.has(agentId)) throw new Error(`Duplicate Topic activation candidate: ${agentId}`);
    seen.add(agentId);
    return {
      agentId,
      ...(candidate.lastSpokeAt === undefined
        ? {}
        : { lastSpokeAt: iso(candidate.lastSpokeAt, "candidate.lastSpokeAt") })
    };
  });
  if (candidates.length === 0) throw new Error("Topic activation requires a candidate");
  const ranked = [...candidates].sort((left, right) => {
    const leftAt = left.lastSpokeAt === undefined
      ? Number.NEGATIVE_INFINITY : Date.parse(left.lastSpokeAt);
    const rightAt = right.lastSpokeAt === undefined
      ? Number.NEGATIVE_INFINITY : Date.parse(right.lastSpokeAt);
    return leftAt - rightAt || left.agentId.localeCompare(right.agentId);
  });
  const maximumParticipants = Math.min(ranked.length, 3);
  const participantCount = weightedIndex(
    Array.from({ length: maximumParticipants }, (_, index) => maximumParticipants - index),
    `${selectionId}:count`
  ) + 1;
  const remaining = [...ranked];
  const candidateAgentIds: string[] = [];
  for (let index = 0; index < participantCount; index += 1) {
    const selected = weightedIndex(
      remaining.map((_, rank) => remaining.length - rank),
      `${selectionId}:agent:${index}`
    );
    candidateAgentIds.push(remaining.splice(selected, 1)[0]!.agentId);
  }
  return {
    candidateAgentIds,
    conversationIntent: selectIntent(
      input.intentPolicy,
      input.themes,
      governanceRevision,
      `${selectionId}:intent`
    )
  };
}

function selectIntent(
  policy: TopicActivationIntentPolicy,
  themesInput: readonly { readonly themeId: string; readonly brief: string }[],
  governanceRevision: number,
  seed: string
): ConversationIntentSnapshot {
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
      brief: text(policy.brief, "intentPolicy.brief", 4_096),
      governanceRevision
    };
  }
  const themes = themesInput.map((theme) => ({
    themeId: text(theme.themeId, "theme.themeId", 128),
    brief: text(theme.brief, "theme.brief", 4_096)
  })).sort((left, right) => left.themeId.localeCompare(right.themeId));
  if (themes.length === 0) throw new Error("choose_from_themes requires an active theme");
  const theme = themes[hash(seed) % themes.length]!;
  return {
    schema: "ConversationIntentSnapshot@1",
    mode: "selected_theme",
    themeId: theme.themeId,
    brief: theme.brief,
    governanceRevision
  };
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

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${field} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function iso(value: unknown, field: string): string {
  const timestamp = text(value, field, 64);
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`${field} must be an ISO timestamp`);
  return timestamp;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}
