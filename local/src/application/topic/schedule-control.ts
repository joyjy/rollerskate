import type { LocalControlOptions } from "../agent/control.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import {
  TopicActivationScheduleRevisionConflict,
  TopicActivationScheduleStore
} from "../../infrastructure/sqlite/topic-activation-schedule-store.js";
import {
  createTopicActivationSchedule,
  transitionTopicActivationScheduleStatus,
  type CreateTopicActivationSchedule,
  type TopicActivationSchedule,
  type TopicActivationScheduleReceipt
} from "../../modules/topic/schedule.js";
import { materializeLocalTopicGovernance } from "./governance-control.js";
import {
  canonicalCronExpression,
  canonicalOnceExpression,
  firstOccurrence,
  requireIanaTimezone,
  nextCronOccurrence
} from "../../capabilities/scheduled-task/time.js";

export interface TopicActivationScheduleControlResult {
  readonly outcome: "applied" | "unchanged" | "conflict";
  readonly schedule: TopicActivationSchedule;
  readonly receipt?: TopicActivationScheduleReceipt;
}

export function createLocalTopicActivationSchedule(
  repoRoot: string,
  input: Omit<CreateTopicActivationSchedule, "topicId">,
  options: LocalControlOptions = {}
): TopicActivationScheduleControlResult {
  const at = timestamp(options);
  const governance = materializeLocalTopicGovernance(
    repoRoot, options.runtimeDirectory, at
  ).governance;
  const store = new TopicActivationScheduleStore(
    runtimePaths(repoRoot, options.runtimeDirectory).database
  );
  try {
    const definition = {
      ...input,
      topicId: governance.topicId,
      expression: input.kind === "once"
        ? canonicalOnceExpression(input.expression)
        : canonicalCronExpression(input.expression),
      ...(input.kind === "cron"
        ? { timezone: requireIanaTimezone(input.timezone ?? "") }
        : {})
    };
    const first = firstOccurrence({
      kind: definition.kind,
      expression: definition.expression,
      ...(definition.timezone === undefined ? {} : { timezone: definition.timezone }),
      after: at
    });
    if (first === undefined) throw new Error("Topic activation once schedule must be in the future");
    const created = store.create(createTopicActivationSchedule(definition, at, first));
    return { outcome: "applied", ...created };
  } finally {
    store.close();
  }
}

export function pauseLocalTopicActivationSchedule(
  repoRoot: string,
  scheduleId: string,
  expectedRevision: number,
  options: LocalControlOptions = {}
): TopicActivationScheduleControlResult {
  return mutate(repoRoot, scheduleId, expectedRevision, "pause", options);
}

export function resumeLocalTopicActivationSchedule(
  repoRoot: string,
  scheduleId: string,
  expectedRevision: number,
  options: LocalControlOptions = {}
): TopicActivationScheduleControlResult {
  return mutate(repoRoot, scheduleId, expectedRevision, "resume", options);
}

export function cancelLocalTopicActivationSchedule(
  repoRoot: string,
  scheduleId: string,
  expectedRevision: number,
  options: LocalControlOptions = {}
): TopicActivationScheduleControlResult {
  return mutate(repoRoot, scheduleId, expectedRevision, "cancel", options);
}

function mutate(
  repoRoot: string,
  scheduleId: string,
  expectedRevision: number,
  action: "pause" | "resume" | "cancel",
  options: LocalControlOptions
): TopicActivationScheduleControlResult {
  const store = new TopicActivationScheduleStore(
    runtimePaths(repoRoot, options.runtimeDirectory).database
  );
  try {
    try {
      const at = timestamp(options);
      const current = store.require(scheduleId);
      const target = action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
      if (current.status === target || (action === "resume" && current.status === "completed")) {
        return { outcome: "unchanged", schedule: current };
      }
      if (current.revision !== expectedRevision) {
        return { outcome: "conflict", schedule: current };
      }
      const missed = action === "resume" && current.nextRunAt !== undefined &&
        Date.parse(current.nextRunAt) <= Date.parse(at);
      const nextOccurrence = missed && current.kind === "cron"
        ? nextCronOccurrence(current.expression, current.timezone!, at)
        : undefined;
      const next = transitionTopicActivationScheduleStatus(
        current, action, at, missed, nextOccurrence
      );
      const changed = store.commitControl({
        current,
        expectedRevision,
        action,
        next,
        at,
        ...(missed ? {
          skippedOccurrence: {
            occurrenceKey: current.nextOccurrenceKey!,
            scheduledFor: current.nextRunAt!,
            reason: "paused-window"
          }
        } : {})
      });
      return {
        outcome: changed.changed ? "applied" : "unchanged",
        schedule: changed.schedule,
        ...(changed.receipt === undefined ? {} : { receipt: changed.receipt })
      };
    } catch (error) {
      if (!(error instanceof TopicActivationScheduleRevisionConflict)) throw error;
      return { outcome: "conflict", schedule: error.current };
    }
  } finally {
    store.close();
  }
}

function timestamp(options: LocalControlOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}
