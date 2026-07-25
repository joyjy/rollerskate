import { localId, requireLocalId } from "../../core/id.js";

export type ScheduleStatus = "active" | "paused" | "completed" | "cancelled";
export type ScheduleKind = "once" | "cron";
export type ScheduleExpressionVersion = "once-rfc3339-v1" | "cron-v1";
export type ScheduleMisfirePolicy = "skip" | "run_once";
export type ScheduleOverlapPolicy = "skip" | "queue";
export type ScheduleSessionPolicy = "new_each_run" | "fixed";
export type ScheduledRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "unknown";

export interface ScheduleDefinition {
  readonly scheduleId: string;
  readonly ownerPrincipalId: string;
  readonly status: ScheduleStatus;
  readonly currentRevision: number;
  readonly nextRunAt?: string;
  readonly nextOccurrenceKey?: string;
  readonly nextOccurrenceMissing: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScheduleRevision {
  readonly scheduleId: string;
  readonly revision: number;
  readonly agentId: string;
  readonly kind: ScheduleKind;
  readonly expression: string;
  readonly expressionVersion: ScheduleExpressionVersion;
  readonly timezone?: string;
  readonly misfirePolicy: ScheduleMisfirePolicy;
  readonly overlapPolicy: ScheduleOverlapPolicy;
  readonly misfireGraceMilliseconds: number;
  readonly sessionPolicy: ScheduleSessionPolicy;
  readonly fixedSessionId?: string;
  readonly prompt: string;
  readonly workspace: string;
  readonly createdAt: string;
}

export interface Schedule {
  readonly definition: ScheduleDefinition;
  readonly revision: ScheduleRevision;
}

export interface ScheduledRun {
  readonly runId: string;
  readonly scheduleId: string;
  readonly occurrenceKey: string;
  readonly scheduledFor: string;
  readonly scheduleRevision: number;
  readonly coalescedThrough?: string;
  readonly admittedAt?: string;
  readonly status: ScheduledRunStatus;
  readonly eventId?: string;
  readonly executionId?: string;
  readonly sessionId?: string;
  readonly decisionReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
}

export interface ScheduleRevisionInput {
  readonly agentId: string;
  readonly kind: ScheduleKind;
  readonly expression: string;
  readonly timezone?: string;
  readonly misfirePolicy: ScheduleMisfirePolicy;
  readonly overlapPolicy: ScheduleOverlapPolicy;
  readonly misfireGraceMilliseconds: number;
  readonly sessionPolicy: ScheduleSessionPolicy;
  readonly fixedSessionId?: string;
  readonly prompt: string;
  readonly workspace: string;
}

export interface CreateScheduleInput extends ScheduleRevisionInput {
  readonly ownerPrincipalId: string;
}

export interface UpdateScheduleInput extends ScheduleRevisionInput {
  readonly expectedRevision: number;
}

export function newScheduleId(): string {
  return localId("sch");
}

export function newScheduledRunId(): string {
  return localId("run");
}

export function requireScheduleId(value: string, field = "scheduleId"): string {
  return requireLocalId(value, "sch", field);
}

export function requireScheduledRunId(value: string, field = "runId"): string {
  return requireLocalId(value, "run", field);
}

export function requireScheduleRevision(value: number, field = "revision"): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}
