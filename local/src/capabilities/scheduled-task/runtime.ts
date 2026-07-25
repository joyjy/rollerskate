import type { RuntimeExecutionStatus } from "../../core/runtime/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import type {
  ScheduledRun,
  Schedule,
  ScheduleRevision
} from "./model.js";
import { ScheduledTaskStore } from "./store.js";
import { latestCronOccurrence } from "./time.js";

export interface ScheduledTaskCycleResult {
  readonly projected: readonly string[];
  readonly admitted: readonly string[];
  readonly skipped: readonly string[];
  readonly queued: readonly string[];
  readonly failed: readonly string[];
}

export class ScheduledTaskRuntime {
  readonly #runtime: RuntimeStore;
  readonly #store: ScheduledTaskStore;
  readonly #validateTarget: (revision: ScheduleRevision) => string | undefined;

  public constructor(options: {
    readonly store: ScheduledTaskStore;
    readonly runtime: RuntimeStore;
    readonly validateTarget: (revision: ScheduleRevision) => string | undefined;
  }) {
    this.#store = options.store;
    this.#runtime = options.runtime;
    this.#validateTarget = options.validateTarget;
  }

  public runCycle(at = new Date().toISOString()): ScheduledTaskCycleResult {
    const now = iso(at);
    const projected = this.#projectRuns(now);
    const admitted: string[] = [];
    const skipped: string[] = [];
    const queued: string[] = [];
    const failed: string[] = [];

    for (const run of this.#store.pendingRuns()) {
      const result = this.#admitPending(run, now);
      if (result === "admitted") admitted.push(run.runId);
      if (result === "failed") failed.push(run.runId);
      if (result === "skipped") skipped.push(run.runId);
    }

    for (const schedule of this.#store.due(now)) {
      const decision = this.#decideDue(schedule, now);
      if (decision.kind === "admit") {
        const result = this.#admitPending(decision.run, now);
        if (result === "admitted") admitted.push(decision.run.runId);
        if (result === "failed") failed.push(decision.run.runId);
      } else if (decision.kind === "skip") {
        skipped.push(decision.run.runId);
      } else if (decision.kind === "queue") {
        queued.push(decision.run.runId);
      }
    }
    return { projected, admitted, skipped, queued, failed };
  }

  #projectRuns(at: string): string[] {
    const projected: string[] = [];
    for (const schedule of this.#store.list()) {
      for (const run of this.#store.unterminatedRuns(schedule.definition.scheduleId)) {
        if (run.eventId === undefined) continue;
        if (run.status === "unknown") continue;
        const audit = this.#runtime.audit(run.eventId);
        if (audit?.execution === undefined) {
          this.#store.patchRun(run.runId, {
            status: "unknown",
            decisionReason: "runtime-audit-missing"
          }, at);
          projected.push(run.runId);
          continue;
        }
        const status = projectedStatus(audit.execution.status);
        const sessionId = audit.session?.sessionId;
        if (status === run.status && sessionId === run.sessionId) continue;
        this.#store.patchRun(run.runId, {
          status,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(status === "succeeded" || status === "failed"
            ? { completedAt: audit.execution.completedAt ?? at }
            : {})
        }, at);
        projected.push(run.runId);
      }
    }
    return projected;
  }

  #decideDue(
    schedule: Schedule,
    at: string
  ):
    | { readonly kind: "admit"; readonly run: ScheduledRun }
    | { readonly kind: "skip"; readonly run: ScheduledRun }
    | { readonly kind: "queue"; readonly run: ScheduledRun } {
    const firstAt = schedule.definition.nextRunAt;
    const occurrenceKey = schedule.definition.nextOccurrenceKey;
    if (firstAt === undefined || occurrenceKey === undefined) {
      throw new Error(`Active Schedule has no next occurrence: ${schedule.definition.scheduleId}`);
    }
    const latest = schedule.revision.kind === "cron"
      ? latestCronOccurrence(
          schedule.revision.expression,
          schedule.revision.timezone!,
          at
        )
      : {
          scheduledFor: firstAt,
          occurrenceKey,
          missingLocalTime: false
        };
    const lastAt = Date.parse(latest.scheduledFor) >= Date.parse(firstAt)
      ? latest.scheduledFor
      : firstAt;
    const coalescedThrough = lastAt === firstAt ? undefined : lastAt;
    const misfire = schedule.definition.nextOccurrenceMissing ||
      Date.parse(at) > Date.parse(firstAt) + schedule.revision.misfireGraceMilliseconds;
    let decision:
      | { readonly kind: "admit"; readonly run: ScheduledRun }
      | { readonly kind: "skip"; readonly run: ScheduledRun }
      | { readonly kind: "queue"; readonly run: ScheduledRun };

    if (misfire && schedule.revision.misfirePolicy === "skip") {
      decision = {
        kind: "skip",
        run: this.#store.insertDueRun({
          scheduleId: schedule.definition.scheduleId,
          occurrenceKey,
          scheduledFor: firstAt,
          scheduleRevision: schedule.definition.currentRevision,
          status: "skipped",
          ...(coalescedThrough === undefined ? {} : { coalescedThrough }),
          decisionReason: schedule.definition.nextOccurrenceMissing
            ? "misfire-dst-missing-skip"
            : "misfire-skip",
          createdAt: at
        }).run
      };
    } else {
      const ownActive = this.#store.unterminatedRuns(schedule.definition.scheduleId)
        .some((run) => run.eventId !== undefined);
      const fixedActive = schedule.revision.fixedSessionId === undefined
        ? false
        : this.#store.hasActiveFixedSessionRun(schedule.revision.fixedSessionId);
      if (ownActive || fixedActive) {
        if (schedule.revision.overlapPolicy === "skip") {
          decision = {
            kind: "skip",
            run: this.#store.insertDueRun({
              scheduleId: schedule.definition.scheduleId,
              occurrenceKey,
              scheduledFor: firstAt,
              scheduleRevision: schedule.definition.currentRevision,
              status: "skipped",
              ...(coalescedThrough === undefined ? {} : { coalescedThrough }),
              decisionReason: "overlap-skip",
              createdAt: at
            }).run
          };
        } else {
          const pending = this.#store.pendingRuns().find(
            (run) => run.scheduleId === schedule.definition.scheduleId
          );
          const run = pending === undefined
            ? this.#store.insertDueRun({
                scheduleId: schedule.definition.scheduleId,
                occurrenceKey,
                scheduledFor: firstAt,
                scheduleRevision: schedule.definition.currentRevision,
                status: "queued",
                ...(coalescedThrough === undefined ? {} : { coalescedThrough }),
                decisionReason: "overlap-queued",
                createdAt: at
              }).run
            : this.#store.patchRun(pending.runId, {
                coalescedThrough: latestCoalesced(pending, lastAt),
                decisionReason: "overlap-coalesced"
              }, at);
          decision = { kind: "queue", run };
        }
      } else {
        decision = {
          kind: "admit",
          run: this.#store.insertDueRun({
            scheduleId: schedule.definition.scheduleId,
            occurrenceKey,
            scheduledFor: firstAt,
            scheduleRevision: schedule.definition.currentRevision,
            status: "queued",
            ...(coalescedThrough === undefined ? {} : { coalescedThrough }),
            decisionReason: misfire ? "misfire-run-once" : "due",
            createdAt: at
          }).run
        };
      }
    }
    this.#store.advanceExpected(schedule.definition.scheduleId, at, at, {
      revision: schedule.definition.currentRevision,
      occurrenceKey
    });
    return decision;
  }

  #admitPending(
    run: ScheduledRun,
    at: string
  ): "admitted" | "deferred" | "failed" | "skipped" {
    const current = this.#store.requireRun(run.runId);
    if (current.status !== "queued" || current.eventId !== undefined) return "deferred";
    const schedule = this.#store.require(current.scheduleId);
    if (schedule.definition.status === "cancelled") {
      this.#store.patchRun(current.runId, {
        status: "skipped",
        decisionReason: "schedule-cancelled",
        completedAt: at
      }, at);
      return "skipped";
    }
    if (schedule.definition.status === "paused" &&
      !current.occurrenceKey.startsWith("manual:")) {
      return "deferred";
    }
    const revision = this.#store.requireRevision(
      current.scheduleId,
      current.scheduleRevision
    );
    if (this.#store.hasOtherActiveRun(current) ||
      (revision.fixedSessionId !== undefined &&
        this.#store.hasOtherActiveFixedSessionRun(current, revision.fixedSessionId))) {
      return "deferred";
    }
    const invalid = this.#validateTarget(revision);
    if (invalid !== undefined) {
      this.#store.patchRun(current.runId, {
        status: "failed",
        decisionReason: `admission-failed:${invalid}`,
        completedAt: at
      }, at);
      return "failed";
    }
    const receipt = this.#runtime.appendEvent({
      type: "agent.request",
      source: {
        kind: "schedule",
        externalId: `scheduled-run:${current.runId}`
      },
      agentId: revision.agentId,
      prompt: revision.prompt,
      ...(revision.fixedSessionId === undefined
        ? {}
        : { sessionId: revision.fixedSessionId }),
      createdAt: at
    });
    this.#store.patchRun(current.runId, {
      status: projectedStatus(receipt.execution.status),
      eventId: receipt.event.eventId,
      executionId: receipt.execution.executionId,
      admittedAt: current.admittedAt ?? at
    }, at);
    return "admitted";
  }
}

function projectedStatus(
  status: RuntimeExecutionStatus
): "queued" | "running" | "succeeded" | "failed" {
  if (status === "running") return "running";
  if (status === "succeeded") return "succeeded";
  if (status === "failed") return "failed";
  return "queued";
}

function latestCoalesced(run: ScheduledRun, candidate: string): string {
  const current = run.coalescedThrough ?? run.scheduledFor;
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

function iso(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("at must be a valid instant");
  return new Date(milliseconds).toISOString();
}
