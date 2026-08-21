import { createHash } from "node:crypto";

import { localRuntimeSnapshot, type LocalControlOptions } from "../agent/control.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { LocalChatStore } from "../../infrastructure/sqlite/chat-store.js";
import {
  FreeChatActiveModeConflict,
  FreeChatModeRevisionConflict,
  FreeChatModeStore
} from "../../infrastructure/sqlite/free-chat-mode-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import {
  parseFreeChatMode,
  sampleFreeChatCycle,
  type FreeChatMode,
  type FreeChatModeReceipt
} from "../../modules/topic/free-chat.js";
import { materializeLocalTopicGovernance } from "./governance-control.js";

export interface FreeChatControlResult {
  readonly outcome: "applied" | "unchanged" | "conflict";
  readonly mode: FreeChatMode;
  readonly receipt?: FreeChatModeReceipt;
}

export interface StartFreeChatInput {
  readonly idempotencyKey: string;
  readonly intentPolicy?:
    | { readonly kind: "continue_recent" }
    | { readonly kind: "choose_from_themes" }
    | { readonly kind: "fixed_directed"; readonly brief: string };
  readonly limits?: Partial<FreeChatMode["limits"]>;
}

export function startLocalFreeChat(
  repoRoot: string,
  input: StartFreeChatInput,
  options: LocalControlOptions = {}
): FreeChatControlResult {
  const at = now(options);
  const governance = materializeLocalTopicGovernance(
    repoRoot, options.runtimeDirectory, at
  ).governance;
  if (governance.status !== "active") throw new Error("Topic is paused");
  const modeId = stableModeId(governance.topicId, input.idempotencyKey);
  const paths = runtimePaths(repoRoot, options.runtimeDirectory);
  const store = new FreeChatModeStore(paths.database);
  try {
    const existing = store.get(modeId);
    if (existing !== undefined) return { outcome: "unchanged", mode: existing };
    const active = store.active(governance.topicId);
    if (active !== undefined) return { outcome: "conflict", mode: active };
    const candidates = eligibleCandidates(repoRoot, governance, options, at);
    if (candidates.length === 0) {
      throw new Error("Free Chat mode requires an eligible Topic participant");
    }
    const intentPolicy = input.intentPolicy ??
      (governance.conversationPolicy.defaultIntent === "choose_from_themes"
        ? { kind: "choose_from_themes" as const }
        : { kind: "continue_recent" as const });
    const sample = sampleFreeChatCycle({
      modeId,
      cycleIndex: 1,
      sampledAt: at,
      governanceRevision: governance.revision,
      intentPolicy,
      candidates,
      themes: governance.conversationPolicy.themes
        .filter(({ status }) => status === "active")
        .map(({ themeId, brief }) => ({ themeId, brief }))
    });
    const mode = parseFreeChatMode({
      modeId,
      topicId: governance.topicId,
      status: "active",
      intentPolicy,
      strategyRevision: 1,
      limits: {
        maxDurationMinutes: input.limits?.maxDurationMinutes ?? 8 * 60,
        maxCycles: input.limits?.maxCycles ?? 32,
        maxTurns: input.limits?.maxTurns ?? 64,
        consecutiveSilenceLimit: input.limits?.consecutiveSilenceLimit ?? 3
      },
      cycleIndex: 1,
      sample,
      lastMeaningfulActivityAt: at,
      consecutiveSilentCycles: 0,
      admittedTurns: 0,
      revision: 1,
      startedAt: at,
      updatedAt: at
    });
    try {
      const created = store.create(mode, at);
      return { outcome: "applied", ...created };
    } catch (error) {
      if (!(error instanceof FreeChatActiveModeConflict)) throw error;
      return {
        outcome: error.current.modeId === modeId ? "unchanged" : "conflict",
        mode: error.current
      };
    }
  } finally {
    store.close();
  }
}

export function continueLocalFreeChatNow(
  repoRoot: string,
  expectedRevision: number,
  options: LocalControlOptions = {}
): FreeChatControlResult {
  const at = now(options);
  return mutateActiveMode(repoRoot, expectedRevision, options, (current) => {
    if (Date.parse(current.sample.idleDeadline) <= Date.parse(at)) {
      return { outcome: "unchanged", mode: current };
    }
    const next = parseFreeChatMode({
      ...current,
      sample: { ...current.sample, idleDeadline: at },
      revision: current.revision + 1,
      updatedAt: at
    });
    return commit(repoRoot, current, next, "continued_now", { deadline: at }, options);
  });
}

export function exitLocalFreeChat(
  repoRoot: string,
  expectedRevision: number,
  options: LocalControlOptions = {}
): FreeChatControlResult {
  const at = now(options);
  const paths = runtimePaths(repoRoot, options.runtimeDirectory);
  const governance = materializeLocalTopicGovernance(
    repoRoot, options.runtimeDirectory, at
  ).governance;
  const store = new FreeChatModeStore(paths.database);
  try {
    const current = store.latest(governance.topicId);
    if (current === undefined) throw new Error("Free Chat mode is not materialized");
    if (current.status !== "active") return { outcome: "unchanged", mode: current };
    if (current.revision !== expectedRevision) {
      return { outcome: "conflict", mode: current };
    }
    const next = parseFreeChatMode({
      ...current,
      status: "exited",
      stopReason: "owner_exit",
      stoppedAt: at,
      revision: current.revision + 1,
      updatedAt: at
    });
    const committed = store.commit({
      modeId: current.modeId,
      expectedRevision,
      next,
      action: "exited",
      details: { reason: "owner_exit" },
      at
    });
    return { outcome: "applied", ...committed };
  } catch (error) {
    if (!(error instanceof FreeChatModeRevisionConflict)) throw error;
    return { outcome: "conflict", mode: error.current };
  } finally {
    store.close();
  }
}

function mutateActiveMode(
  repoRoot: string,
  expectedRevision: number,
  options: LocalControlOptions,
  mutation: (current: FreeChatMode) => FreeChatControlResult
): FreeChatControlResult {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error("expectedRevision must be a positive integer");
  }
  const governance = materializeLocalTopicGovernance(
    repoRoot, options.runtimeDirectory, now(options)
  ).governance;
  const store = new FreeChatModeStore(
    runtimePaths(repoRoot, options.runtimeDirectory).database
  );
  try {
    const current = store.active(governance.topicId);
    if (current === undefined) throw new Error("Free Chat mode is not active");
    if (current.revision !== expectedRevision) {
      return { outcome: "conflict", mode: current };
    }
    return mutation(current);
  } finally {
    store.close();
  }
}

function commit(
  repoRoot: string,
  current: FreeChatMode,
  next: FreeChatMode,
  action: "continued_now",
  details: Readonly<Record<string, string | number | boolean>>,
  options: LocalControlOptions
): FreeChatControlResult {
  const store = new FreeChatModeStore(
    runtimePaths(repoRoot, options.runtimeDirectory).database
  );
  try {
    const committed = store.commit({
      modeId: current.modeId,
      expectedRevision: current.revision,
      next,
      action,
      details,
      at: next.updatedAt
    });
    return { outcome: "applied", ...committed };
  } catch (error) {
    if (!(error instanceof FreeChatModeRevisionConflict)) throw error;
    return { outcome: "conflict", mode: error.current };
  } finally {
    store.close();
  }
}

export function eligibleCandidates(
  repoRoot: string,
  governance: ReturnType<typeof materializeLocalTopicGovernance>["governance"],
  options: LocalControlOptions,
  at: string
): readonly { readonly agentId: string; readonly lastSpokeAt?: string }[] {
  const participantIds = new Set(governance.participants
    .filter(({ status }) => status === "active")
    .map(({ agentId }) => agentId));
  const paths = runtimePaths(repoRoot, options.runtimeDirectory);
  const runtime = new RuntimeStore(paths.database);
  const chat = new LocalChatStore(paths.database);
  try {
    const messages = chat.events(governance.topicId)
      .filter((event) => event.type === "chat.message" && event.sender.kind === "agent");
    return localRuntimeSnapshot(repoRoot, options).agents
      .filter(({ principalId, status }) =>
        status === "active" && participantIds.has(principalId))
      .filter(({ principalId }) => {
        const presence = runtime.chatPresence(principalId, governance.topicId);
        return [presence.global, presence.topic].every((candidate) =>
          candidate === undefined || candidate.mode === "available" ||
          candidate.until === undefined || Date.parse(candidate.until) <= Date.parse(at));
      })
      .map(({ principalId }) => {
        const last = [...messages].reverse().find(
          (event) => event.type === "chat.message" &&
            event.sender.principalId === principalId
        );
        return {
          agentId: principalId,
          ...(last === undefined ? {} : { lastSpokeAt: last.createdAt })
        };
      });
  } finally {
    chat.close();
    runtime.close();
  }
}

function stableModeId(topicId: string, idempotencyKey: string): string {
  if (idempotencyKey.trim().length === 0 || idempotencyKey.length > 512) {
    throw new Error("Free Chat idempotencyKey must contain 1-512 characters");
  }
  return `fcm_${createHash("sha256")
    .update(`${topicId}:free-chat:${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function now(options: LocalControlOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}
