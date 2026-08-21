import {
  localRuntimeSnapshot,
  type LocalControlOptions
} from "../agent/control.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import {
  parseChatPresence,
  type ChatPresence,
  type ChatTimeline
} from "../../core/chat/model.js";
import type { ChatDispatchEvent } from "../../core/event/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import {
  LocalChatStore,
  type ChatMessageAdmission
} from "../../infrastructure/sqlite/chat-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import {
  chatMessageViewsFromStore,
  chatTimelineFromStore,
  type ChatMessageViewPage,
  type ChatTimelineOptions
} from "./query.js";
import { mentionedChatAgents } from "./mention.js";
import {
  clientHistoryAudits,
  inspectClientHistoryAccess
} from "../activity/client-history.js";
import { materializeLocalTopicGovernance } from
  "../topic/governance-control.js";
import type { FreeChatMode } from "../../modules/topic/free-chat.js";
import type { TopicGovernance } from "../../modules/topic/governance.js";
import {
  resumeLocalTopic,
  type TopicGovernanceControlResult
} from "../topic/governance-control.js";

export interface LocalChatView {
  readonly chat: {
    readonly topicId: string;
    readonly handle: "local";
  };
  readonly agents: readonly LocalAgent[];
  readonly events: ReturnType<LocalChatStore["events"]>;
  readonly timeline: ChatTimeline;
  readonly messages: ChatMessageViewPage;
  readonly sessions: readonly {
    readonly principalId: string;
    readonly currentSessionId?: string;
    readonly generation: number;
  }[];
  readonly conversation: {
    readonly strategy: "starter";
    readonly state: "starter_pending" | "active" | "all_silent" | "budget_exhausted" | "idle";
    readonly turnBudget: number;
    readonly usedTurns: number;
    readonly remainingTurns: number;
    readonly latestReason?: string;
    readonly activeSpeakerHandle?: string;
    readonly activeSpeakerHandles: readonly string[];
  };
}

export interface LocalChatPresenceView {
  readonly topicId: string;
  readonly agents: readonly {
    readonly principalId: string;
    readonly handle: string;
    readonly status: LocalAgent["status"];
    readonly global?: ChatPresence;
    readonly topic?: ChatPresence;
    readonly clientHistory?: {
      readonly client: LocalAgent["client"];
      readonly status: "active" | "revoked";
      readonly updatedAt: string;
      readonly coverage: "not_checked" | "available" | "unavailable" | "unsupported" | "error";
      readonly lastUsedAt?: string;
      readonly lastResultCount?: number;
      readonly truncated?: boolean;
    };
    readonly lastTurn?: {
      readonly state: "thinking" | "replied" | "silent" | "failed";
      readonly at: string;
      readonly reason?: string;
    };
  }[];
}

export function activateLocalChat(
  repoRoot: string,
  input: {
    readonly strategy: "starter" | "manual";
    readonly idempotencyKey: string;
    readonly turnBudget?: number;
    readonly intentPolicy?: FreeChatMode["intentPolicy"];
  },
  options: LocalControlOptions = {}
) {
  return activateGovernedLocalChat(repoRoot, {
    reason: input.strategy === "starter" ? "topic_opened" : "manual",
    strategy: input.strategy,
    idempotencyKey: input.idempotencyKey,
    ...(input.turnBudget === undefined ? {} : { turnBudget: input.turnBudget }),
    ...(input.intentPolicy === undefined ? {} : { intentPolicy: input.intentPolicy })
  }, options);
}

export function resumeAndWakeLocalChat(
  repoRoot: string,
  expectedRevision: number,
  idempotencyKey: string,
  options: LocalControlOptions = {}
): {
  readonly governance: TopicGovernanceControlResult;
  readonly activation?: ReturnType<RuntimeStore["createChatActivation"]>;
} {
  if (idempotencyKey.trim() === "") {
    throw new Error("Resume & wake requires an idempotency key");
  }
  const governance = resumeLocalTopic(repoRoot, expectedRevision, options);
  if (governance.outcome === "conflict") return { governance };
  return {
    governance,
    activation: activateGovernedLocalChat(repoRoot, {
      reason: "resumed",
      strategy: "manual",
      idempotencyKey
    }, options)
  };
}

function activateGovernedLocalChat(
  repoRoot: string,
  input: {
    readonly reason: "topic_opened" | "manual" | "resumed";
    readonly strategy: "starter" | "manual";
    readonly idempotencyKey: string;
    readonly turnBudget?: number;
    readonly intentPolicy?: FreeChatMode["intentPolicy"];
  },
  options: LocalControlOptions
) {
  const snapshot = localRuntimeSnapshot(repoRoot, options);
  const governance = materializeLocalTopicGovernance(
    repoRoot,
    options.runtimeDirectory,
    now(options)
  ).governance;
  if (governance.status === "paused") throw new Error("Topic is paused");
  if (input.strategy === "starter" && !governance.strategyPolicy.starterEnabled) {
    throw new Error("Topic starter strategy is disabled");
  }
  const participantIds = new Set(governance.participants
    .filter(({ status }) => status === "active")
    .map(({ agentId }) => agentId));
  const candidates = snapshot.agents
    .filter((agent) => agent.status === "active" && participantIds.has(agent.principalId))
    .sort((left, right) => left.handle.localeCompare(right.handle));
  if (candidates.length === 0) throw new Error("No active Local Agent can start the Topic");
  const runtime = new RuntimeStore(runtimePaths(repoRoot, options.runtimeDirectory).database);
  try {
    return runtime.createChatActivation({
      topicId: snapshot.foundation.topicId,
      reason: input.reason,
      strategyId: input.strategy,
      conversationIntent: conversationIntent(governance, input.intentPolicy),
      candidateAgentIds: input.strategy === "starter"
        ? [candidates[0]!.principalId]
        : candidates.map((agent) => agent.principalId),
      idempotencyKey: input.idempotencyKey,
      turnBudget: input.turnBudget ?? 8,
      strategyRevision: governance.revision,
      contextRevision: governance.revision
    }, now(options));
  } finally {
    runtime.close();
  }
}

function conversationIntent(
  governance: TopicGovernance,
  requested?: FreeChatMode["intentPolicy"]
) {
  const policy = requested ?? { kind: governance.conversationPolicy.defaultIntent };
  if (policy.kind === "continue_recent") {
    return {
      schema: "ConversationIntentSnapshot@1" as const,
      mode: "continue_recent" as const,
      governanceRevision: governance.revision
    };
  }
  if (policy.kind === "fixed_directed") {
    const brief = policy.brief.trim();
    if (brief === "" || brief.length > 4_096) {
      throw new Error("directed conversation intent requires a 1-4096 character brief");
    }
    return {
      schema: "ConversationIntentSnapshot@1" as const,
      mode: "directed" as const,
      brief,
      governanceRevision: governance.revision
    };
  }
  const theme = governance.conversationPolicy.themes
    .filter(({ status }) => status === "active")
    .sort((left, right) => left.themeId.localeCompare(right.themeId))[0];
  if (theme === undefined) throw new Error("Topic has no active conversation theme");
  return {
    schema: "ConversationIntentSnapshot@1" as const,
    mode: "selected_theme" as const,
    themeId: theme.themeId,
    brief: theme.brief,
    governanceRevision: governance.revision
  };
}

export function localChatView(
  repoRoot: string,
  options: LocalControlOptions = {},
  timelineOptions: ChatTimelineOptions = {}
): LocalChatView {
  const snapshot = localRuntimeSnapshot(repoRoot, options);
  const chat = openChat(repoRoot, options);
  const runtime = new RuntimeStore(runtimePaths(repoRoot, options.runtimeDirectory).database);
  try {
    const events = chat.events(snapshot.foundation.topicId);
    const activation = runtime.latestChatActivation(snapshot.foundation.topicId);
    const activationEvents = activation === undefined
      ? []
      : runtime.eventsForRoot(activation.eventId);
    const executionIsActive = (eventId: string) => {
      const execution = runtime.executionForEvent(eventId);
      return execution !== undefined &&
        (execution.status === "queued" || execution.status === "running" ||
          execution.status === "retry_wait");
    };
    const dispatches = activationEvents.filter(
      (event): event is ChatDispatchEvent =>
      event.type === "chat.dispatch");
    const activeDispatches = dispatches.filter((dispatch) =>
      executionIsActive(dispatch.eventId));
    const active = activation !== undefined &&
      activationEvents.some((event) =>
        event.causality.rootEventId === activation.eventId &&
        executionIsActive(event.eventId));
    const activeSpeaker = activeDispatches.at(-1);
    const decisions = dispatches.flatMap((dispatch) => {
      const decision = runtime.chatDecisionReceipt(dispatch.eventId);
      return decision === undefined ? [] : [decision];
    });
    const turnBudget = activation?.type === "chat.activation" ? activation.turnBudget : 8;
    const usedTurns = dispatches.length;
    const state = activation === undefined
      ? events.some((event) => event.type === "chat.message") ? "idle" : "starter_pending"
      : active ? "active"
      : usedTurns >= turnBudget ? "budget_exhausted"
      : decisions.length === usedTurns && decisions.length > 0 &&
        decisions.every((decision) => decision.speechAction === "silent")
        ? "all_silent"
        : "idle";
    return {
      chat: {
        topicId: snapshot.foundation.topicId,
        handle: snapshot.foundation.topicHandle
      },
      agents: snapshot.agents,
      events,
      timeline: chatTimelineFromStore(chat, snapshot.foundation.topicId, timelineOptions),
      messages: chatMessageViewsFromStore(chat, snapshot.foundation.topicId, timelineOptions),
      sessions: snapshot.agents.map((agent) => {
        const current = chat.currentSession(agent.principalId);
        return {
          principalId: agent.principalId,
          ...(current.sessionId === undefined
            ? {}
            : { currentSessionId: current.sessionId }),
          generation: current.generation
        };
      }),
      conversation: {
        strategy: "starter",
        state,
        turnBudget,
        usedTurns,
        remainingTurns: Math.max(0, turnBudget - usedTurns),
        activeSpeakerHandles: [...new Set(activeDispatches.map((dispatch) =>
          dispatch.targetHandleSnapshot))],
        ...(activation?.type === "chat.activation"
          ? { latestReason: activation.reason }
          : {}),
        ...(activeSpeaker === undefined
          ? {}
          : { activeSpeakerHandle: activeSpeaker.targetHandleSnapshot })
      }
    };
  } finally {
    runtime.close();
    chat.close();
  }
}

export function postLocalChatMessage(
  repoRoot: string,
  body: string,
  options: LocalControlOptions = {},
  messageOptions: { readonly replyToEventId?: string } = {}
): ChatMessageAdmission {
  const snapshot = localRuntimeSnapshot(repoRoot, options);
  const chat = openChat(repoRoot, options);
  try {
    const replyTo = messageOptions.replyToEventId === undefined
      ? undefined
      : chat.message(messageOptions.replyToEventId);
    const mentioned = resolveMentions(body, snapshot.agents);
    const repliedAgent = replyTo?.sender.kind === "agent"
      ? snapshot.agents.find((agent) =>
          agent.principalId === replyTo.sender.principalId && agent.status === "active")
      : undefined;
    const targets = mentioned.length > 0
      ? mentioned
      : repliedAgent === undefined ? [] : [repliedAgent];
    return chat.postOwnerMessage({
      topicId: snapshot.foundation.topicId,
      ownerPrincipalId: snapshot.foundation.owner.principalId,
      body,
      ...(messageOptions.replyToEventId === undefined
        ? {}
        : { replyToEventId: messageOptions.replyToEventId }),
      ...(targets.length === 0
        ? {}
        : { targets: targets.map((target) => ({
            principalId: target.principalId,
            handle: target.handle
          })) }),
      at: now(options)
    });
  } finally {
    chat.close();
  }
}

export function localChatPresenceView(
  repoRoot: string,
  options: LocalControlOptions = {}
): LocalChatPresenceView {
  const snapshot = localRuntimeSnapshot(repoRoot, options);
  const runtime = new RuntimeStore(runtimePaths(repoRoot, options.runtimeDirectory).database);
  try {
    return {
      topicId: snapshot.foundation.topicId,
      agents: snapshot.agents.map((agent) => {
        const presence = runtime.chatPresence(agent.principalId, snapshot.foundation.topicId);
        const history = inspectClientHistoryAccess(repoRoot, agent.principalId, options);
        const lastHistory = [...clientHistoryAudits(repoRoot, agent.principalId, options)]
          .reverse()
          .find((audit) => audit.action === "search" || audit.action === "read");
        const lastDispatch = runtime.latestChatDispatch(
          snapshot.foundation.topicId,
          agent.principalId
        );
        const lastExecution = lastDispatch === undefined
          ? undefined
          : runtime.executionForEvent(lastDispatch.eventId);
        const lastDecision = lastDispatch === undefined
          ? undefined
          : runtime.chatDecisionReceipt(lastDispatch.eventId);
        const lastTurn = lastExecution !== undefined &&
          (lastExecution.status === "queued" || lastExecution.status === "running" ||
            lastExecution.status === "retry_wait")
          ? { state: "thinking" as const, at: lastExecution.updatedAt }
          : lastDecision !== undefined
            ? {
                state: lastDecision.speechAction === "silent"
                  ? "silent" as const
                  : "replied" as const,
                at: lastDecision.createdAt,
                ...(lastDecision.silenceReason === undefined
                  ? {}
                  : { reason: lastDecision.silenceReason })
              }
            : lastExecution?.status === "failed"
              ? { state: "failed" as const, at: lastExecution.updatedAt }
              : undefined;
        const coverage = lastHistory === undefined
          ? "not_checked" as const
          : lastHistory.outcome !== "failed"
            ? "available" as const
            : lastHistory.failureReason === "source-unavailable"
              ? "unavailable" as const
              : lastHistory.failureReason === "source-unsupported"
                ? "unsupported" as const
                : "error" as const;
        return {
          principalId: agent.principalId,
          handle: agent.handle,
          status: agent.status,
          ...(presence.global === undefined ? {} : { global: presence.global }),
          ...(presence.topic === undefined ? {} : { topic: presence.topic }),
          ...(history === undefined
            ? {}
            : {
                clientHistory: {
                  client: history.client,
                  status: history.status,
                  updatedAt: history.updatedAt,
                  coverage,
                  ...(lastHistory === undefined
                    ? {}
                    : {
                        lastUsedAt: lastHistory.occurredAt,
                        ...(lastHistory.resultCount === undefined
                          ? {}
                          : { lastResultCount: lastHistory.resultCount }),
                        ...(lastHistory.truncated === undefined
                          ? {}
                          : { truncated: lastHistory.truncated })
                      })
                }
              }),
          ...(lastTurn === undefined ? {} : { lastTurn })
        };
      })
    };
  } finally {
    runtime.close();
  }
}

export function setLocalChatPresence(
  repoRoot: string,
  principalId: string,
  presenceInput: unknown,
  options: LocalControlOptions = {}
): ChatPresence {
  const snapshot = localRuntimeSnapshot(repoRoot, options);
  const agent = snapshot.agents.find((candidate) => candidate.principalId === principalId);
  if (agent === undefined) throw new Error(`Local Agent not found: ${principalId}`);
  const at = now(options);
  const presence = parseChatPresence(presenceInput, at);
  const runtime = new RuntimeStore(runtimePaths(repoRoot, options.runtimeDirectory).database);
  try {
    return runtime.setChatPresence(
      agent.principalId,
      snapshot.foundation.topicId,
      presence,
      at
    );
  } finally {
    runtime.close();
  }
}

export function promptLocalChatDispatches(
  repoRoot: string,
  options: LocalControlOptions = {}
): readonly string[] {
  const snapshot = localRuntimeSnapshot(repoRoot, options);
  const chat = openChat(repoRoot, options);
  try {
    return chat.promptPending(
      snapshot.foundation.topicId,
      snapshot.agents.filter((agent) => agent.status === "active")
        .map((agent) => ({ principalId: agent.principalId, handle: agent.handle })),
      now(options)
    ).map((event) => event.eventId);
  } finally {
    chat.close();
  }
}

export function dispatchLocalChatMessage(
  repoRoot: string,
  sourceMessageEventId: string,
  targetPrincipalId: string,
  options: LocalControlOptions = {}
): NonNullable<ChatMessageAdmission["dispatch"]> {
  const snapshot = localRuntimeSnapshot(repoRoot, options);
  const governance = materializeLocalTopicGovernance(
    repoRoot,
    options.runtimeDirectory,
    now(options)
  ).governance;
  const chat = openChat(repoRoot, options);
  const existing = chat.dispatchReceipt(sourceMessageEventId);
  if (existing !== undefined) {
    chat.close();
    return existing;
  }
  if (governance.status === "paused") {
    chat.close();
    throw new Error("Topic is paused");
  }
  const target = snapshot.agents.find(
    (agent) => agent.principalId === targetPrincipalId && agent.status === "active"
  );
  if (target === undefined) {
    chat.close();
    throw new Error(`Active Local Agent not found: ${targetPrincipalId}`);
  }
  const participant = governance.participants.find(
    ({ agentId, status }) => agentId === targetPrincipalId && status === "active"
  );
  if (participant === undefined) {
    chat.close();
    throw new Error(`Active Topic participant not found: ${targetPrincipalId}`);
  }
  try {
    return chat.dispatch({
      sourceMessageEventId,
      topicId: snapshot.foundation.topicId,
      target: { principalId: target.principalId, handle: target.handle },
      admissionSnapshot: {
        revision: governance.revision,
        participantRevision: participant.governanceRevision
      },
      at: now(options)
    });
  } finally {
    chat.close();
  }
}

export function rotateLocalAgentSession(
  repoRoot: string,
  principalId: string,
  options: LocalControlOptions = {}
): number {
  const snapshot = localRuntimeSnapshot(repoRoot, options);
  const agent = snapshot.agents.find(
    (candidate) => candidate.principalId === principalId &&
      candidate.status === "active"
  );
  if (agent === undefined) throw new Error(`Active Local Agent not found: ${principalId}`);
  const chat = openChat(repoRoot, options);
  try {
    return chat.newSession(principalId, now(options));
  } finally {
    chat.close();
  }
}

function resolveMentions(body: string, agents: readonly LocalAgent[]): readonly LocalAgent[] {
  return mentionedChatAgents(body, agents);
}

function openChat(repoRoot: string, options: LocalControlOptions): LocalChatStore {
  return new LocalChatStore(runtimePaths(repoRoot, options.runtimeDirectory).database);
}

function now(options: LocalControlOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}
