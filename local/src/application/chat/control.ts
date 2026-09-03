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
import { RuntimeStore } from "../../core/runtime/store.js";
import {
  LocalChatStore,
  type ChatMessageAdmission
} from "../../infrastructure/sqlite/chat-store.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import {
  chatMessageViewsFromPage,
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
import { startStewardRunFromIntent } from "../steward/intent-control.js";
import {
  projectChatRunProposals
} from "./run-proposal.js";
import { inspectCurrentChatRunProposal } from "./run-proposal-control.js";

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
      readonly state: "thinking" | "replied" | "proposed" | "silent" | "failed";
      readonly at: string;
      readonly reason?: string;
    };
  }[];
}

export function localChatView(
  repoRoot: string,
  options: LocalControlOptions = {},
  timelineOptions: ChatTimelineOptions = {}
): LocalChatView {
  const snapshot = localRuntimeSnapshot(repoRoot, options);
  const chat = openChat(repoRoot, options);
  const database = openRuntimeDatabase(
    runtimePaths(repoRoot, options.runtimeDirectory).database
  );
  const runtime = new RuntimeStore(database);
  try {
    const events = chat.events(snapshot.foundation.topicId);
    const messagePage = chat.messagePage(snapshot.foundation.topicId, timelineOptions);
    const messages = chatMessageViewsFromPage(
      chat,
      snapshot.foundation.topicId,
      messagePage
    );
    const proposalMessages = messagePage.items.filter(
      (message) => message.dispatchCard === undefined
    );
    const proposals = projectChatRunProposals({
      repoRoot,
      ...(options.runtimeDirectory === undefined
        ? {}
        : { runtimeDirectory: options.runtimeDirectory }),
      database,
      messages: proposalMessages,
      agents: snapshot.agents
    });
    return {
      chat: {
        topicId: snapshot.foundation.topicId,
        handle: snapshot.foundation.topicHandle
      },
      agents: snapshot.agents,
      events,
      timeline: chatTimelineFromStore(chat, snapshot.foundation.topicId, timelineOptions),
      messages: {
        ...messages,
        items: messages.items.map((message) => {
          const messageProposals = proposals.get(message.eventId);
          return messageProposals === undefined
            ? message
            : { ...message, runProposals: messageProposals.map(({ view }) => view) };
        })
      },
      sessions: snapshot.agents.map((agent) => {
        const current = chat.currentSession(agent.principalId);
        return {
          principalId: agent.principalId,
          ...(current.sessionId === undefined
            ? {}
            : { currentSessionId: current.sessionId }),
          generation: current.generation
        };
      })
    };
  } finally {
    runtime.close();
    database.close();
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

export function handoffLocalChatMessageToRun(
  repoRoot: string,
  eventId: string,
  options: LocalControlOptions = {}
) {
  const snapshot = localRuntimeSnapshot(repoRoot, options);
  const chat = openChat(repoRoot, options);
  try {
    const message = chat.message(eventId);
    if (message.topicId !== snapshot.foundation.topicId || message.sender.kind !== "owner") {
      throw new Error("Only an Owner message in the Local Topic can be handed off to a Run");
    }
    if (inspectCurrentChatRunProposal(repoRoot, message, snapshot.agents, options) !== undefined) {
      throw new Error(
        "Owner messages with a Run proposal require current revision confirmation"
      );
    }
    return startStewardRunFromIntent(repoRoot, {
      schemaVersion: "RunIntent@1",
      requestId: `chat-work:${message.eventId}`,
      objective: message.body,
      acceptance: ["Complete the explicit work intent handed off from Local Chat"],
      contextRefs: [
        `chat-topic:${message.topicId}`,
        `chat-message:${message.eventId}`
      ],
      ...(message.targets === undefined || message.targets.length === 0
        ? {}
        : {
            requestedParticipantRefs: message.targets.map(
              ({ principalId }) => `principal:${principalId}`
            )
          }),
      terminalEvidence: ["Record a terminal Run receipt linked to the source Chat message"]
    }, options.runtimeDirectory);
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
        const history = agent.status === "active"
          ? inspectClientHistoryAccess(repoRoot, agent.principalId, options)
          : undefined;
        const lastHistory = agent.status === "active"
          ? [...clientHistoryAudits(repoRoot, agent.principalId, options)]
            .reverse()
            .find((audit) => audit.action === "search" || audit.action === "read")
          : undefined;
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
                  : lastDecision.speechAction === "propose_run"
                    ? "proposed" as const
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
