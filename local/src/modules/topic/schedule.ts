import { moduleId, requireModuleId } from "../shared/id.js";

export type TopicActivationScheduleStatus = "active" | "paused" | "cancelled" | "completed";
export type TopicActivationCandidatePolicy =
  | "deterministic_one"
  | "sampled_sequential"
  | "all_available";
export type TopicActivationIntentPolicy =
  | { readonly kind: "continue_recent" }
  | { readonly kind: "choose_from_themes" }
  | { readonly kind: "fixed_directed"; readonly brief: string };

export interface TopicActivationSchedule {
  readonly scheduleId: string;
  readonly topicId: string;
  readonly status: TopicActivationScheduleStatus;
  readonly kind: "once" | "cron";
  readonly expression: string;
  readonly timezone?: string;
  readonly misfirePolicy: "skip" | "run_once";
  readonly misfireGraceMilliseconds: number;
  readonly candidatePolicy: TopicActivationCandidatePolicy;
  readonly intentPolicy: TopicActivationIntentPolicy;
  readonly turnBudget: number;
  readonly nextRunAt?: string;
  readonly nextOccurrenceKey?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TopicActivationScheduleReceiptAction =
  | "created"
  | "paused"
  | "resumed"
  | "cancelled"
  | "occurrence_admitted"
  | "occurrence_skipped"
  | "occurrence_failed";

export interface TopicActivationScheduleReceipt {
  readonly schema: "TopicActivationScheduleReceipt@1";
  readonly receiptId: string;
  readonly scheduleId: string;
  readonly topicId: string;
  readonly sequence: number;
  readonly action: TopicActivationScheduleReceiptAction;
  readonly resultingRevision: number;
  readonly occurrenceKey?: string;
  readonly scheduledFor?: string;
  readonly activationEventId?: string;
  readonly reason?: string;
  readonly createdAt: string;
}

export interface CreateTopicActivationSchedule {
  readonly topicId: string;
  readonly kind: "once" | "cron";
  readonly expression: string;
  readonly timezone?: string;
  readonly misfirePolicy?: "skip" | "run_once";
  readonly misfireGraceMilliseconds?: number;
  readonly candidatePolicy?: TopicActivationCandidatePolicy;
  readonly intentPolicy?: TopicActivationIntentPolicy;
  readonly turnBudget?: number;
}

export function newTopicActivationScheduleId(): string {
  return moduleId("tas");
}

export function requireTopicActivationScheduleId(value: string): string {
  return requireModuleId(value, "tas", "scheduleId");
}

export function createTopicActivationSchedule(
  input: CreateTopicActivationSchedule,
  at: string,
  first: { readonly scheduledFor: string; readonly occurrenceKey: string }
): TopicActivationSchedule {
  const scheduleId = newTopicActivationScheduleId();
  const timestamp = iso(at, "at");
  const normalized = normalizeDefinition(input);
  return parseTopicActivationSchedule({
    scheduleId,
    topicId: input.topicId,
    status: "active",
    ...normalized,
    nextRunAt: first.scheduledFor,
    nextOccurrenceKey: first.occurrenceKey,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

export function advanceTopicActivationSchedule(
  schedule: TopicActivationSchedule,
  at: string,
  nextOccurrence?: { readonly scheduledFor: string; readonly occurrenceKey: string }
): TopicActivationSchedule {
  const timestamp = iso(at, "at");
  if (schedule.kind === "once") return parseTopicActivationSchedule({
    ...schedule,
    status: "completed",
    nextRunAt: undefined,
    nextOccurrenceKey: undefined,
    revision: schedule.revision + 1,
    updatedAt: timestamp
  });
  if (nextOccurrence === undefined) {
    throw new Error("Cron Topic activation schedule advance requires the next occurrence");
  }
  return parseTopicActivationSchedule({
    ...schedule,
    nextRunAt: nextOccurrence.scheduledFor,
    nextOccurrenceKey: nextOccurrence.occurrenceKey,
    revision: schedule.revision + 1,
    updatedAt: timestamp
  });
}

export function transitionTopicActivationScheduleStatus(
  scheduleInput: TopicActivationSchedule,
  action: "pause" | "resume" | "cancel",
  at: string,
  advanceMissed = false,
  nextOccurrence?: { readonly scheduledFor: string; readonly occurrenceKey: string }
): TopicActivationSchedule {
  const schedule = parseTopicActivationSchedule(scheduleInput);
  const target = action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
  const allowed = action === "pause"
    ? schedule.status === "active"
    : action === "resume"
      ? schedule.status === "paused"
      : schedule.status === "active" || schedule.status === "paused";
  if (!allowed) throw new Error(`Topic activation schedule cannot ${action} from ${schedule.status}`);
  if (action === "resume" && advanceMissed) {
    return advanceTopicActivationSchedule(parseTopicActivationSchedule({
      ...schedule,
      status: "active"
    }), at, nextOccurrence);
  }
  return parseTopicActivationSchedule({
    ...schedule,
    status: target,
    revision: schedule.revision + 1,
    updatedAt: at
  });
}

export function parseTopicActivationSchedule(value: unknown): TopicActivationSchedule {
  const record = object(value, "TopicActivationSchedule");
  const kind = oneOf(record.kind, ["once", "cron"] as const, "kind");
  const expression = text(record.expression, "expression", 512);
  const timezone = kind === "cron"
    ? text(record.timezone, "timezone", 128)
    : undefined;
  if (kind === "once" && record.timezone !== undefined) {
    throw new Error("once Topic activation schedule must not define timezone");
  }
  const status = oneOf(
    record.status, ["active", "paused", "cancelled", "completed"] as const, "status"
  );
  const nextRunAt = record.nextRunAt === undefined ? undefined : iso(record.nextRunAt, "nextRunAt");
  const nextOccurrenceKey = record.nextOccurrenceKey === undefined
    ? undefined : text(record.nextOccurrenceKey, "nextOccurrenceKey", 512);
  if (status === "active" && (nextRunAt === undefined || nextOccurrenceKey === undefined)) {
    throw new Error("active Topic activation schedule requires a next occurrence");
  }
  return {
    scheduleId: requireTopicActivationScheduleId(text(record.scheduleId, "scheduleId", 64)),
    topicId: text(record.topicId, "topicId", 256),
    status,
    kind,
    expression,
    ...(timezone === undefined ? {} : { timezone }),
    misfirePolicy: oneOf(record.misfirePolicy, ["skip", "run_once"] as const, "misfirePolicy"),
    misfireGraceMilliseconds: integer(
      record.misfireGraceMilliseconds, "misfireGraceMilliseconds", 0, 604_800_000
    ),
    candidatePolicy: oneOf(record.candidatePolicy, [
      "deterministic_one", "sampled_sequential", "all_available"
    ] as const, "candidatePolicy"),
    intentPolicy: intentPolicy(record.intentPolicy),
    turnBudget: integer(record.turnBudget, "turnBudget", 1, 64),
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    ...(nextOccurrenceKey === undefined ? {} : { nextOccurrenceKey }),
    revision: integer(record.revision, "revision", 1, 1_000_000),
    createdAt: iso(record.createdAt, "createdAt"),
    updatedAt: iso(record.updatedAt, "updatedAt")
  };
}

export function topicActivationScheduleReceipt(input: Omit<
  TopicActivationScheduleReceipt,
  "schema" | "receiptId"
>): TopicActivationScheduleReceipt {
  return parseTopicActivationScheduleReceipt({
    ...input,
    schema: "TopicActivationScheduleReceipt@1",
    receiptId: `topic-schedule:${input.scheduleId}:${input.sequence}`
  });
}

export function parseTopicActivationScheduleReceipt(
  value: unknown
): TopicActivationScheduleReceipt {
  const record = object(value, "TopicActivationScheduleReceipt");
  if (record.schema !== "TopicActivationScheduleReceipt@1") {
    throw new Error("Topic activation schedule receipt schema is unsupported");
  }
  const scheduleId = requireTopicActivationScheduleId(
    text(record.scheduleId, "scheduleId", 64)
  );
  const sequence = integer(record.sequence, "sequence", 1, 1_000_000);
  const receiptId = text(record.receiptId, "receiptId", 256);
  if (receiptId !== `topic-schedule:${scheduleId}:${sequence}`) {
    throw new Error("Topic activation schedule receiptId is not canonical");
  }
  return {
    schema: "TopicActivationScheduleReceipt@1",
    receiptId,
    scheduleId,
    topicId: text(record.topicId, "topicId", 256),
    sequence,
    action: oneOf(record.action, [
      "created", "paused", "resumed", "cancelled", "occurrence_admitted",
      "occurrence_skipped", "occurrence_failed"
    ] as const, "action"),
    resultingRevision: integer(record.resultingRevision, "resultingRevision", 1, 1_000_000),
    ...(record.occurrenceKey === undefined
      ? {} : { occurrenceKey: text(record.occurrenceKey, "occurrenceKey", 512) }),
    ...(record.scheduledFor === undefined
      ? {} : { scheduledFor: iso(record.scheduledFor, "scheduledFor") }),
    ...(record.activationEventId === undefined
      ? {} : { activationEventId: text(record.activationEventId, "activationEventId", 256) }),
    ...(record.reason === undefined ? {} : { reason: text(record.reason, "reason", 1_024) }),
    createdAt: iso(record.createdAt, "createdAt")
  };
}

function normalizeDefinition(input: CreateTopicActivationSchedule) {
  const kind = input.kind;
  const expression = text(input.expression, "expression", 512);
  const timezone = kind === "cron" ? text(input.timezone, "timezone", 128) : undefined;
  if (kind === "once" && input.timezone !== undefined) {
    throw new Error("once Topic activation schedule must not define timezone");
  }
  return {
    kind,
    expression,
    ...(timezone === undefined ? {} : { timezone }),
    misfirePolicy: input.misfirePolicy ?? "run_once" as const,
    misfireGraceMilliseconds: input.misfireGraceMilliseconds ?? 60_000,
    candidatePolicy: input.candidatePolicy ?? "deterministic_one" as const,
    intentPolicy: input.intentPolicy ?? { kind: "continue_recent" as const },
    turnBudget: input.turnBudget ?? 3
  };
}

function intentPolicy(value: unknown): TopicActivationIntentPolicy {
  const record = object(value, "intentPolicy");
  const kind = oneOf(
    record.kind, ["continue_recent", "choose_from_themes", "fixed_directed"] as const, "intentPolicy.kind"
  );
  return kind === "fixed_directed"
    ? { kind, brief: text(record.brief, "intentPolicy.brief", 4_096) }
    : { kind };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new Error(`${field} must contain 1-${max} characters`);
  }
  return value;
}
function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}
function iso(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be a valid instant`);
  }
  return new Date(value).toISOString();
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${field} is unsupported`);
  }
  return value as T;
}
