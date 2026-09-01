import type { RuntimeExecutionStatus } from "../../core/runtime/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import type {
  ScheduledRun,
  Schedule,
  ScheduleRevision
} from "./model.js";
import { ScheduledTaskStore } from "./store.js";
import { latestCronOccurrence } from "./time.js";
import type { ExternalRefTriggerGuard } from
  "../../modules/external-resource/trigger-binding.js";
import {
  BoundScheduleRuntime,
  type ScheduleRunBindingAdapter
} from "./bound-runtime.js";

export type { ScheduleRunBindingAdapter } from "./bound-runtime.js";

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
  readonly #externalRefGuard: ExternalRefTriggerGuard | undefined;
  readonly #bound: BoundScheduleRuntime;

  public constructor(options: {
    readonly store: ScheduledTaskStore;
    readonly runtime: RuntimeStore;
    readonly validateTarget: (revision: ScheduleRevision) => string | undefined;
    readonly externalRefGuard?: ExternalRefTriggerGuard;
    readonly runBinding?: ScheduleRunBindingAdapter;
  }) {
    this.#store = options.store;
    this.#runtime = options.runtime;
    this.#validateTarget = options.validateTarget;
    this.#externalRefGuard = options.externalRefGuard;
    this.#bound = new BoundScheduleRuntime({
      store: options.store,
      ...(options.externalRefGuard === undefined
        ? {}
        : { externalRefGuard: options.externalRefGuard }),
      ...(options.runBinding === undefined ? {} : { runBinding: options.runBinding })
    });
  }

  public async runCycle(at = new Date().toISOString()): Promise<ScheduledTaskCycleResult> {
    const now = iso(at);
    const projected = this.#projectRuns(now);
    const admitted: string[] = [];
    const skipped: string[] = [];
    const queued: string[] = [];
    const failed: string[] = [];

    for (const run of this.#store.pendingRuns()) {
      const result = await this.#admitPending(run, now);
      if (result === "admitted") admitted.push(run.runId);
      if (result === "failed") failed.push(run.runId);
      if (result === "skipped") skipped.push(run.runId);
    }

    for (const schedule of this.#store.due(now)) {
      if (schedule.revision.schemaVersion === "ScheduleRevision@2") {
        const result = await this.#bound.decideDue(schedule, now);
        if (result.kind === "admit") admitted.push(result.run.runId);
        if (result.kind === "failed") failed.push(result.run.runId);
        if (result.kind === "skip") skipped.push(result.run.runId);
        if (result.kind === "queue") queued.push(result.run.runId);
        continue;
      }
      const decision = this.#decideDue(schedule, now);
      if (decision.kind === "admit") {
        const result = await this.#admitPending(decision.run, now);
        if (result === "admitted") admitted.push(decision.run.runId);
        if (result === "failed") failed.push(decision.run.runId);
        if (result === "skipped") skipped.push(decision.run.runId);
      } else if (decision.kind === "skip") {
        skipped.push(decision.run.runId);
      } else if (decision.kind === "queue") {
        queued.push(decision.run.runId);
      }
    }
    return { projected, admitted, skipped, queued, failed };
  }

  #projectRuns(at: string): string[] {
    this.#store.reconcileCallbacks(at);
    const projected: string[] = [];
    for (const schedule of this.#store.list()) {
      for (const run of this.#store.unterminatedRuns(schedule.definition.scheduleId)) {
        if (run.status === "unknown") continue;
        if (run.agentRunId !== undefined) {
          if (this.#bound.projectOccurrence(run, schedule, at)) {
            projected.push(run.runId);
          }
          continue;
        }
        if (run.status === "running") {
          const callbacks = this.#store.callbackOccurrences(run);
          if (callbacks.length === 0 && run.eventId === undefined) {
            this.#store.patchRun(run.runId, {
              status: "unknown",
              decisionReason: "callback-occurrence-missing"
            }, at);
            projected.push(run.runId);
            continue;
          }
          if (callbacks.length > 0) {
            const agentCallback = callbacks.find(({ eventId }) => eventId !== undefined);
            const audit = agentCallback?.eventId === undefined
              ? undefined
              : this.#runtime.audit(agentCallback.eventId);
            const active = callbacks.some(({ status }) =>
              status === "pending" || status === "started"
            );
            if (active) {
              if (agentCallback?.eventId !== undefined && run.eventId === undefined) {
                this.#store.patchRun(run.runId, {
                  status: "running",
                  eventId: agentCallback.eventId,
                  ...(audit?.execution === undefined
                    ? {}
                    : { executionId: audit.execution.executionId }),
                  ...(audit?.session === undefined ? {} : { sessionId: audit.session.sessionId })
                }, at);
                projected.push(run.runId);
              }
              continue;
            }
            const status = callbacks.some(({ status }) => status === "unknown")
              ? "unknown"
              : callbacks.some(({ status }) => status === "failed" || status === "blocked")
                ? "failed"
                : "succeeded";
            this.#store.patchRun(run.runId, {
              status,
              ...(agentCallback?.eventId === undefined ? {} : { eventId: agentCallback.eventId }),
              ...(audit?.execution === undefined
                ? {}
                : { executionId: audit.execution.executionId }),
              ...(audit?.session === undefined ? {} : { sessionId: audit.session.sessionId }),
              decisionReason: `callbacks-${status}`,
              completedAt: at
            }, at);
            projected.push(run.runId);
            continue;
          }
        }
        if (run.eventId === undefined) continue;
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
    if (schedule.revision.schemaVersion !== "ScheduleRevision@1") {
      throw new Error("ScheduleRevision@2 must use Run occurrence admission");
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

  async #admitPending(
    run: ScheduledRun,
    at: string
  ): Promise<"admitted" | "deferred" | "failed" | "skipped"> {
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
    const revision = this.#store.requireRevision(
      current.scheduleId,
      current.scheduleRevision
    );
    if (revision.schemaVersion === "ScheduleRevision@2") {
      return this.#bound.admitPending(current, revision, at);
    }
    if (schedule.definition.status === "paused" &&
      !current.occurrenceKey.startsWith("manual:")) {
      return "deferred";
    }
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
    if (revision.externalRefBinding !== undefined) {
      if (this.#externalRefGuard === undefined) {
        this.#store.patchRun(current.runId, {
          status: "failed",
          decisionReason: "external-ref-trigger:guard-unavailable",
          completedAt: at
        }, at);
        return "failed";
      }
      try {
        const checked = await this.#externalRefGuard(revision.externalRefBinding);
        if (checked.status === "rejected") {
          this.#store.patchRun(current.runId, {
            status: "skipped",
            decisionReason: `external-ref-trigger:${checked.reason}`,
            completedAt: at
          }, at);
          return "skipped";
        }
      } catch (error) {
        this.#store.patchRun(current.runId, {
          status: "failed",
          decisionReason: `external-ref-trigger-read:${message(error)}`,
          completedAt: at
        }, at);
        return "failed";
      }
    }
    const admitted = this.#store.admitCallbackRun(current.runId, at);
    const callback = this.#store.admitSingleAgentCallback(admitted, at);
    if (callback?.eventId !== undefined) {
      const audit = this.#runtime.audit(callback.eventId);
      this.#store.patchRun(current.runId, {
        status: audit?.execution === undefined
          ? "running"
          : projectedStatus(audit.execution.status),
        eventId: callback.eventId,
        ...(audit?.execution === undefined ? {} : { executionId: audit.execution.executionId }),
        admittedAt: at
      }, at);
    }
    return "admitted";
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
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
