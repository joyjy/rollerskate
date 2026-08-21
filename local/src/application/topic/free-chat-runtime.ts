import {
  localRuntimeSnapshot,
  type LocalControlOptions
} from "../agent/control.js";
import { parseConversationIntentSnapshot } from "../../core/chat/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { LocalChatStore } from "../../infrastructure/sqlite/chat-store.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { LocalFoundationStore } from
  "../../infrastructure/sqlite/foundation-store.js";
import {
  FreeChatModeRevisionConflict,
  FreeChatModeStore
} from "../../infrastructure/sqlite/free-chat-mode-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { TopicGovernanceStore } from
  "../../infrastructure/sqlite/topic-governance-store.js";
import {
  parseFreeChatMode,
  sampleFreeChatCycle,
  type FreeChatMode,
  type FreeChatStopReason
} from "../../modules/topic/free-chat.js";
import { eligibleCandidates } from "./free-chat-control.js";

export interface FreeChatRuntimeCycle {
  readonly admittedActivationEventIds: readonly string[];
  readonly advancedModeIds: readonly string[];
  readonly stoppedModeIds: readonly string[];
}

export class FreeChatRuntime {
  readonly #database: import("node:sqlite").DatabaseSync;
  readonly #chat: LocalChatStore;
  readonly #foundation: LocalFoundationStore;
  readonly #governance: TopicGovernanceStore;
  readonly #modes: FreeChatModeStore;
  readonly #options: LocalControlOptions;
  readonly #repoRoot: string;
  readonly #runtime: RuntimeStore;

  public constructor(repoRoot: string, options: LocalControlOptions = {}) {
    const database = runtimePaths(repoRoot, options.runtimeDirectory).database;
    this.#repoRoot = repoRoot;
    this.#options = options;
    this.#database = openRuntimeDatabase(database);
    this.#runtime = new RuntimeStore(this.#database);
    this.#modes = new FreeChatModeStore(this.#database);
    this.#foundation = new LocalFoundationStore(this.#database);
    this.#chat = new LocalChatStore(database);
    this.#governance = new TopicGovernanceStore(this.#database);
  }

  public close(): void {
    this.#runtime.close();
    this.#modes.close();
    this.#governance.close();
    this.#foundation.close();
    this.#chat.close();
    this.#database.close();
  }

  public runCycle(at = new Date().toISOString()): FreeChatRuntimeCycle {
    const admittedActivationEventIds: string[] = [];
    const advancedModeIds: string[] = [];
    const stoppedModeIds: string[] = [];
    for (const initial of this.#modes.activeModes()) {
      const governance = this.#governance.require(initial.topicId);
      const roster = governance.participants.filter(({ status }) => status === "active");
      const activeAgentIds = new Set(localRuntimeSnapshot(
        this.#repoRoot, this.#options
      ).agents.filter(({ status }) => status === "active").map(({ principalId }) => principalId));
      const durableRosterCount = roster.filter(({ agentId }) =>
        activeAgentIds.has(agentId)).length;
      const boundary = stopBoundary(
        initial, governance.status, durableRosterCount, at
      );
      if (boundary !== undefined) {
        if (this.#stop(initial, boundary, at)) stoppedModeIds.push(initial.modeId);
        continue;
      }
      let current = this.#modes.get(initial.modeId)!;
      const contribution = this.#latestContribution(current);
      if (contribution !== undefined) {
        const advanced = this.#advance(
          current,
          governance,
          contribution.createdAt,
          "contribution_observed",
          at,
          contribution.eventId,
          0
        );
        if (advanced === undefined) continue;
        current = advanced;
        advancedModeIds.push(current.modeId);
      }
      const durableParticipantIds = new Set(roster
        .filter(({ agentId }) => activeAgentIds.has(agentId))
        .map(({ agentId }) => agentId));
      if (current.sample.candidateAgentIds.some((agentId) =>
        !durableParticipantIds.has(agentId))) {
        const advanced = this.#advance(
          current,
          governance,
          at,
          "roster_changed",
          at,
          undefined,
          current.consecutiveSilentCycles
        );
        if (advanced === undefined) continue;
        current = advanced;
        advancedModeIds.push(current.modeId);
      }
      if (current.pendingActivationEventId !== undefined) {
        if (this.#rootIsActive(current.pendingActivationEventId)) continue;
        const silentCycles = current.consecutiveSilentCycles + 1;
        if (silentCycles >= current.limits.consecutiveSilenceLimit) {
          if (this.#stop(current, "consecutive_silence", at)) {
            stoppedModeIds.push(current.modeId);
          }
          continue;
        }
        const advanced = this.#advance(
          current,
          governance,
          at,
          "cycle_silent",
          at,
          undefined,
          silentCycles
        );
        if (advanced === undefined) continue;
        current = advanced;
        advancedModeIds.push(current.modeId);
      }
      if (Date.parse(current.sample.idleDeadline) > Date.parse(at)) continue;
      const eligible = eligibleCandidates(
        this.#repoRoot, governance, this.#options, at
      ).map(({ agentId }) => agentId);
      const eligibleSet = new Set(eligible);
      const remainingTurns = current.limits.maxTurns - current.admittedTurns;
      const candidateAgentIds = current.sample.candidateAgentIds
        .filter((agentId) => eligibleSet.has(agentId))
        .slice(0, Math.max(0, remainingTurns));
      if (candidateAgentIds.length === 0) {
        if (remainingTurns === 0) {
          if (this.#stop(current, "max_turns", at)) {
            stoppedModeIds.push(current.modeId);
          }
        }
        continue;
      }
      const key = `free-chat:${current.modeId}:${current.cycleIndex}`;
      try {
        const admitted = this.#runtime.withImmediateTransaction(() => {
          const reserved = this.#modes.get(current.modeId);
          if (reserved === undefined || reserved.status !== "active" ||
            reserved.revision !== current.revision) {
            if (reserved === undefined) throw new Error(
              `Free Chat mode not found: ${current.modeId}`
            );
            throw new FreeChatModeRevisionConflict(current.revision, reserved);
          }
          const admittedGovernance = this.#governance.require(reserved.topicId);
          if (admittedGovernance.status !== "active" ||
            admittedGovernance.revision !== governance.revision) {
            return undefined;
          }
          const admittedActiveAgentIds = new Set(this.#foundation.listAgents()
            .filter(({ status }) => status === "active")
            .map(({ principalId }) => principalId));
          const admittedParticipantIds = new Set(admittedGovernance.participants
            .filter(({ agentId, status }) =>
              status === "active" && admittedActiveAgentIds.has(agentId))
            .map(({ agentId }) => agentId));
          if (!candidateAgentIds.every((agentId) =>
            admittedParticipantIds.has(agentId) &&
            isAvailable(this.#runtime.chatPresence(agentId, reserved.topicId), at))) {
            return undefined;
          }
          if (this.#latestContribution(reserved) !== undefined) return undefined;
          const activation = this.#runtime.createChatActivationInTransaction({
            topicId: reserved.topicId,
            reason: "manual",
            strategyId: "manual",
            conversationIntent: parseConversationIntentSnapshot(
              reserved.sample.conversationIntent
            ),
            candidateAgentIds,
            sequentialDispatch: true,
            idempotencyKey: key,
            turnBudget: candidateAgentIds.length,
            strategyRevision: reserved.strategyRevision,
            contextRevision: governance.revision
          }, at);
          if (activation.event.source.externalId !== `chat-activation:${key}`) {
            return undefined;
          }
          const next = parseFreeChatMode({
            ...reserved,
            pendingActivationEventId: activation.event.eventId,
            admittedTurns: reserved.admittedTurns + candidateAgentIds.length,
            revision: reserved.revision + 1,
            updatedAt: at
          });
          this.#modes.commitInTransaction({
            modeId: reserved.modeId,
            expectedRevision: reserved.revision,
            next,
            action: "activation_admitted",
            details: {
              activationEventId: activation.event.eventId,
              candidateCount: candidateAgentIds.length,
              duplicate: activation.status === "duplicate"
            },
            at
          });
          return activation;
        });
        if (admitted !== undefined) {
          admittedActivationEventIds.push(admitted.event.eventId);
        }
      } catch (error) {
        if (!(error instanceof FreeChatModeRevisionConflict)) throw error;
      }
    }
    return { admittedActivationEventIds, advancedModeIds, stoppedModeIds };
  }

  #latestContribution(mode: FreeChatMode) {
    return this.#runtime.chatMessages(mode.topicId)
      .filter(({ sender }) => sender.kind === "owner" || sender.kind === "agent")
      .filter((message) =>
        message.createdAt > mode.lastMeaningfulActivityAt ||
        (message.createdAt === mode.lastMeaningfulActivityAt &&
          message.eventId > (mode.lastMeaningfulEventId ?? "")))
      .at(-1);
  }

  #rootIsActive(rootEventId: string): boolean {
    return this.#runtime.eventsForRoot(rootEventId).some(({ eventId }) => {
      const execution = this.#runtime.executionForEvent(eventId);
      return execution !== undefined &&
        (execution.status === "queued" || execution.status === "running" ||
          execution.status === "retry_wait");
    });
  }

  #advance(
    current: FreeChatMode,
    governance: ReturnType<TopicGovernanceStore["require"]>,
    sampledAt: string,
    action: "contribution_observed" | "roster_changed" | "cycle_silent",
    at: string,
    meaningfulEventId: string | undefined,
    consecutiveSilentCycles: number
  ): FreeChatMode | undefined {
    if (current.cycleIndex >= current.limits.maxCycles) {
      this.#stop(current, "max_cycles", at);
      return undefined;
    }
    const candidates = eligibleCandidates(
      this.#repoRoot, governance, this.#options, at
    );
    if (candidates.length === 0) return undefined;
    const cycleIndex = current.cycleIndex + 1;
    const sample = sampleFreeChatCycle({
      modeId: current.modeId,
      cycleIndex,
      sampledAt,
      governanceRevision: governance.revision,
      intentPolicy: current.intentPolicy,
      candidates,
      themes: governance.conversationPolicy.themes
        .filter(({ status }) => status === "active")
        .map(({ themeId, brief }) => ({ themeId, brief }))
    });
    const next = parseFreeChatMode({
      ...current,
      cycleIndex,
      sample,
      lastMeaningfulActivityAt: meaningfulEventId === undefined
        ? current.lastMeaningfulActivityAt
        : sampledAt,
      ...(meaningfulEventId === undefined
        ? (current.lastMeaningfulEventId === undefined
            ? {}
            : { lastMeaningfulEventId: current.lastMeaningfulEventId })
        : { lastMeaningfulEventId: meaningfulEventId }),
      consecutiveSilentCycles,
      pendingActivationEventId: undefined,
      revision: current.revision + 1,
      updatedAt: at
    });
    try {
      return this.#modes.commit({
        modeId: current.modeId,
        expectedRevision: current.revision,
        next,
        action,
        details: {
          idleDeadline: sample.idleDeadline,
          participantCount: sample.participantCount,
          ...(meaningfulEventId === undefined ? {} : { meaningfulEventId })
        },
        at
      }).mode;
    } catch (error) {
      if (!(error instanceof FreeChatModeRevisionConflict)) throw error;
      return undefined;
    }
  }

  #stop(current: FreeChatMode, reason: FreeChatStopReason, at: string): boolean {
    const next = parseFreeChatMode({
      ...current,
      status: reason === "max_duration" ? "expired" : "stopped",
      stopReason: reason,
      stoppedAt: at,
      revision: current.revision + 1,
      updatedAt: at
    });
    try {
      this.#modes.commit({
        modeId: current.modeId,
        expectedRevision: current.revision,
        next,
        action: "stopped",
        details: { reason },
        at
      });
      return true;
    } catch (error) {
      if (!(error instanceof FreeChatModeRevisionConflict)) throw error;
      return false;
    }
  }
}

function isAvailable(
  presence: ReturnType<RuntimeStore["chatPresence"]>,
  at: string
): boolean {
  return [presence.global, presence.topic].every((candidate) =>
    candidate === undefined || candidate.mode === "available" ||
    candidate.until === undefined || Date.parse(candidate.until) <= Date.parse(at));
}

function stopBoundary(
  mode: FreeChatMode,
  topicStatus: "active" | "paused",
  rosterCount: number,
  at: string
): FreeChatStopReason | undefined {
  if (topicStatus === "paused") return "topic_paused";
  if (rosterCount === 0) return "empty_roster";
  if (Date.parse(at) >= Date.parse(mode.startedAt) +
    mode.limits.maxDurationMinutes * 60_000) return "max_duration";
  if (mode.cycleIndex > mode.limits.maxCycles) return "max_cycles";
  if (mode.admittedTurns >= mode.limits.maxTurns) return "max_turns";
  return undefined;
}
