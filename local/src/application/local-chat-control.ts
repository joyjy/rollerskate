import {
  localRuntimeSnapshot,
  type LocalControlOptions
} from "./local-agent-control.js";
import type { LocalAgent } from "./local-foundation.js";
import {
  LocalChatStore,
  type ChatMessageAdmission
} from "./local-chat-store.js";
import { runtimePaths } from "./runtime-config.js";

export interface LocalChatView {
  readonly chat: {
    readonly topicId: string;
    readonly handle: "local";
  };
  readonly agents: readonly LocalAgent[];
  readonly events: ReturnType<LocalChatStore["events"]>;
  readonly sessions: readonly {
    readonly principalId: string;
    readonly currentSessionId?: string;
    readonly generation: number;
  }[];
}

export function localChatView(
  repoRoot: string,
  options: LocalControlOptions = {}
): LocalChatView {
  const snapshot = localRuntimeSnapshot(repoRoot, options);
  const chat = openChat(repoRoot, options);
  try {
    return {
      chat: {
        topicId: snapshot.foundation.topicId,
        handle: snapshot.foundation.topicHandle
      },
      agents: snapshot.agents,
      events: chat.events(snapshot.foundation.topicId),
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
    chat.close();
  }
}

export function postLocalChatMessage(
  repoRoot: string,
  body: string,
  options: LocalControlOptions = {}
): ChatMessageAdmission {
  const snapshot = localRuntimeSnapshot(repoRoot, options);
  const target = resolveMention(body, snapshot.agents);
  const chat = openChat(repoRoot, options);
  try {
    return chat.postOwnerMessage({
      topicId: snapshot.foundation.topicId,
      ownerPrincipalId: snapshot.foundation.owner.principalId,
      body,
      ...(target === undefined
        ? {}
        : { target: { principalId: target.principalId, handle: target.handle } }),
      at: now(options)
    });
  } finally {
    chat.close();
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
  const chat = openChat(repoRoot, options);
  const existing = chat.dispatchReceipt(sourceMessageEventId);
  if (existing !== undefined) {
    chat.close();
    return existing;
  }
  const target = snapshot.agents.find(
    (agent) => agent.principalId === targetPrincipalId && agent.status === "active"
  );
  if (target === undefined) {
    chat.close();
    throw new Error(`Active Local Agent not found: ${targetPrincipalId}`);
  }
  try {
    return chat.dispatch({
      sourceMessageEventId,
      topicId: snapshot.foundation.topicId,
      target: { principalId: target.principalId, handle: target.handle },
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

function resolveMention(body: string, agents: readonly LocalAgent[]): LocalAgent | undefined {
  const mentioned = agents.filter((agent) =>
    agent.status === "active" &&
    new RegExp(`(^|\\s)@${escapeRegExp(agent.handle)}(?=$|[\\s.,!?;:])`, "iu").test(body)
  );
  if (mentioned.length > 1) {
    throw new Error("A Local Chat message may target only one Agent");
  }
  return mentioned[0];
}

function openChat(repoRoot: string, options: LocalControlOptions): LocalChatStore {
  return new LocalChatStore(runtimePaths(repoRoot, options.runtimeDirectory).database);
}

function now(options: LocalControlOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
