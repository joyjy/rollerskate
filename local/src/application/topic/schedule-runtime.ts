import type { DatabaseSync } from "node:sqlite";

import type { LocalControlOptions } from "../agent/control.js";
import { parseConversationIntentSnapshot } from "../../core/chat/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { TopicActivationScheduleStore } from
  "../../infrastructure/sqlite/topic-activation-schedule-store.js";
import { TopicGovernanceStore } from
  "../../infrastructure/sqlite/topic-governance-store.js";
import {
  advanceTopicActivationSchedule,
  type TopicActivationSchedule
} from "../../modules/topic/schedule.js";
import { nextCronOccurrence } from "../../capabilities/scheduled-task/time.js";
import { selectTopicActivation } from "./schedule-selection.js";

export interface TopicActivationScheduleCycle {
  readonly admittedActivationEventIds: readonly string[];
  readonly skippedOccurrenceKeys: readonly string[];
  readonly failedOccurrenceKeys: readonly string[];
}

export class TopicActivationScheduleRuntime {
  readonly #database: DatabaseSync;
  readonly #foundation: LocalFoundationStore;
  readonly #governance: TopicGovernanceStore;
  readonly #runtime: RuntimeStore;
  readonly #schedules: TopicActivationScheduleStore;

  public constructor(repoRoot: string, options: LocalControlOptions = {}) {
    this.#database = openRuntimeDatabase(
      runtimePaths(repoRoot, options.runtimeDirectory).database
    );
    this.#runtime = new RuntimeStore(this.#database);
    this.#foundation = new LocalFoundationStore(this.#database);
    this.#governance = new TopicGovernanceStore(this.#database);
    this.#schedules = new TopicActivationScheduleStore(this.#database);
  }

  public close(): void {
    this.#schedules.close();
    this.#governance.close();
    this.#foundation.close();
    this.#runtime.close();
    this.#database.close();
  }

  public runCycle(at = new Date().toISOString()): TopicActivationScheduleCycle {
    const admittedActivationEventIds: string[] = [];
    const skippedOccurrenceKeys: string[] = [];
    const failedOccurrenceKeys: string[] = [];
    for (const initial of this.#schedules.due(at)) {
      const occurrenceKey = initial.nextOccurrenceKey!;
      const scheduledFor = initial.nextRunAt!;
      let result: { readonly kind: "admitted"; readonly eventId: string } |
        { readonly kind: "skipped" | "failed" } | undefined;
      try {
        result = this.#runtime.withImmediateTransaction(() => {
        const current = this.#schedules.require(initial.scheduleId);
        if (current.status !== "active" ||
          current.nextOccurrenceKey !== occurrenceKey ||
          this.#schedules.receiptForOccurrence(current.scheduleId, occurrenceKey) !== undefined) {
          return undefined;
        }
        const lateBy = Date.parse(at) - Date.parse(scheduledFor);
        if (lateBy > current.misfireGraceMilliseconds && current.misfirePolicy === "skip") {
          return this.#skip(current, occurrenceKey, scheduledFor, "misfire-skip", at, at);
        }
        const governance = this.#governance.require(current.topicId);
        if (governance.status !== "active") {
          return this.#skip(current, occurrenceKey, scheduledFor, "topic-paused", at, at);
        }
        if (!governance.strategyPolicy.scheduledEnabled) {
          return this.#skip(current, occurrenceKey, scheduledFor, "scheduled-disabled", at, at);
        }
        const candidates = this.#eligibleCandidates(current.topicId, governance.participants, at);
        if (candidates.length === 0) {
          return this.#skip(
            current, occurrenceKey, scheduledFor, "no-eligible-participant", at, at
          );
        }
        const selection = selectTopicActivation({
          selectionId: `${current.scheduleId}:${occurrenceKey}:v1`,
          governanceRevision: governance.revision,
          intentPolicy: current.intentPolicy,
          candidates,
          themes: governance.conversationPolicy.themes
            .filter(({ status }) => status === "active")
            .map(({ themeId, brief }) => ({ themeId, brief }))
        });
        const candidateAgentIds = current.candidatePolicy === "all_available"
          ? candidates.map(({ agentId }) => agentId).sort()
          : current.candidatePolicy === "deterministic_one"
            ? selection.candidateAgentIds.slice(0, 1)
            : selection.candidateAgentIds;
        const key = `topic-schedule:${current.scheduleId}:${occurrenceKey}`;
        const activation = this.#runtime.createChatActivationInTransaction({
          topicId: current.topicId,
          reason: "scheduled",
          strategyId: "scheduled",
          conversationIntent: parseConversationIntentSnapshot(selection.conversationIntent),
          candidateAgentIds,
          sequentialDispatch: current.candidatePolicy === "sampled_sequential",
          idempotencyKey: key,
          turnBudget: Math.min(current.turnBudget, candidateAgentIds.length),
          strategyRevision: 1,
          contextRevision: governance.revision
        }, at);
        if (activation.event.source.externalId !== `chat-activation:${key}`) {
          return this.#skip(current, occurrenceKey, scheduledFor, "active-root-overlap", at, at);
        }
        const anchor = lateBy > current.misfireGraceMilliseconds ? at : scheduledFor;
        const next = advance(current, anchor);
        this.#schedules.commitOccurrenceInTransaction({
          current,
          next,
          action: "occurrence_admitted",
          occurrenceKey,
          scheduledFor,
          activationEventId: activation.event.eventId,
          at
        });
        return { kind: "admitted" as const, eventId: activation.event.eventId };
        });
      } catch (error) {
        result = this.#runtime.withImmediateTransaction(() => {
          const current = this.#schedules.require(initial.scheduleId);
          if (current.status !== "active" || current.nextOccurrenceKey !== occurrenceKey ||
            this.#schedules.receiptForOccurrence(current.scheduleId, occurrenceKey) !== undefined) {
            return undefined;
          }
          this.#schedules.commitOccurrenceInTransaction({
            current,
            next: advance(current, at),
            action: "occurrence_failed",
            occurrenceKey,
            scheduledFor,
            reason: failureReason(error),
            at
          });
          return { kind: "failed" as const };
        });
      }
      if (result?.kind === "admitted") admittedActivationEventIds.push(result.eventId);
      if (result?.kind === "skipped") skippedOccurrenceKeys.push(occurrenceKey);
      if (result?.kind === "failed") failedOccurrenceKeys.push(occurrenceKey);
    }
    return { admittedActivationEventIds, skippedOccurrenceKeys, failedOccurrenceKeys };
  }

  #skip(
    current: TopicActivationSchedule,
    occurrenceKey: string,
    scheduledFor: string,
    reason: string,
    at: string,
    advanceAfter: string
  ) {
    const next = advance(current, advanceAfter);
    this.#schedules.commitOccurrenceInTransaction({
      current,
      next,
      action: "occurrence_skipped",
      occurrenceKey,
      scheduledFor,
      reason,
      at
    });
    return { kind: "skipped" as const };
  }

  #eligibleCandidates(
    topicId: string,
    participants: readonly { readonly agentId: string; readonly status: string }[],
    at: string
  ) {
    const participantIds = new Set(participants
      .filter(({ status }) => status === "active")
      .map(({ agentId }) => agentId));
    const messages = this.#runtime.chatMessages(topicId);
    return this.#foundation.listAgents()
      .filter(({ principalId, status }) =>
        status === "active" && participantIds.has(principalId))
      .filter(({ principalId }) => {
        const presence = this.#runtime.chatPresence(principalId, topicId);
        return [presence.global, presence.topic].every((candidate) =>
          candidate === undefined || candidate.mode === "available" ||
          candidate.until === undefined || Date.parse(candidate.until) <= Date.parse(at));
      })
      .map(({ principalId }) => {
        const last = [...messages].reverse().find(
          ({ sender }) => sender.kind === "agent" && sender.principalId === principalId
        );
        return {
          agentId: principalId,
          ...(last === undefined ? {} : { lastSpokeAt: last.createdAt })
        };
      });
  }
}

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `occurrence-failed:${message}`.slice(0, 1_024);
}

function advance(schedule: TopicActivationSchedule, at: string) {
  return advanceTopicActivationSchedule(
    schedule,
    at,
    schedule.kind === "cron"
      ? nextCronOccurrence(schedule.expression, schedule.timezone!, at)
      : undefined
  );
}
