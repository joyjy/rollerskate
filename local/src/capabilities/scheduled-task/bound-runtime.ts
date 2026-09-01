import type { ExternalRefTriggerGuard } from
  "../../modules/external-resource/trigger-binding.js";
import type { TriggerOccurrenceEnvelope } from
  "../../modules/steward/source-contract.js";
import type {
  BoundScheduleRevision,
  Schedule,
  ScheduledRun
} from "./model.js";
import { activateScheduleOccurrenceInTransaction } from "./run-binding.js";
import type { ScheduledTaskStore } from "./store.js";
import { latestCronOccurrence } from "./time.js";

export interface ScheduleRunBindingAdapter {
  readonly activateOccurrenceInTransaction: (input: {
    readonly agentRunId: string;
    readonly envelope: TriggerOccurrenceEnvelope;
    readonly at: string;
  }) => {
    readonly cycleId: string;
    readonly orchestratorEventId: string;
    readonly orchestratorExecutionId: string;
  };
  readonly runState: (runId: string) => {
    readonly status: string;
    readonly activeCycleId?: string;
  } | undefined;
  readonly cycleState: (cycleId: string) => {
    readonly status: string;
    readonly terminalSummary?: string;
    readonly completedAt?: string;
  } | undefined;
}

export type BoundScheduleDecision =
  | { readonly kind: "admit"; readonly run: ScheduledRun }
  | { readonly kind: "failed"; readonly run: ScheduledRun }
  | { readonly kind: "skip"; readonly run: ScheduledRun }
  | { readonly kind: "queue"; readonly run: ScheduledRun };

export class BoundScheduleRuntime {
  readonly #store: ScheduledTaskStore;
  readonly #externalRefGuard: ExternalRefTriggerGuard | undefined;
  readonly #runBinding: ScheduleRunBindingAdapter | undefined;

  public constructor(options: {
    readonly store: ScheduledTaskStore;
    readonly externalRefGuard?: ExternalRefTriggerGuard;
    readonly runBinding?: ScheduleRunBindingAdapter;
  }) {
    this.#store = options.store;
    this.#externalRefGuard = options.externalRefGuard;
    this.#runBinding = options.runBinding;
  }

  public projectOccurrence(run: ScheduledRun, schedule: Schedule, at: string): boolean {
    if (run.agentRunId === undefined || this.#runBinding === undefined) return false;
    if (run.cycleId === undefined) return false;
    const cycle = this.#runBinding.cycleState(run.cycleId);
    if (cycle === undefined) {
      this.#store.patchRun(run.runId, {
        status: "unknown",
        decisionReason: "run-cycle-missing"
      }, at);
      return true;
    }
    if (cycle.status === "active") {
      if (run.status === "running") return false;
      this.#store.patchRun(run.runId, {
        status: "running",
        decisionReason: "run-cycle-active"
      }, at);
      return true;
    }
    const status = cycle.status === "succeeded"
      ? "succeeded"
      : cycle.status === "failed"
        ? "failed"
        : cycle.status === "cancelled" || cycle.status === "superseded"
          ? "skipped"
          : "unknown";
    this.#store.patchRun(run.runId, {
      status,
      decisionReason: `run-cycle-${cycle.status}`,
      ...(status === "unknown" ? {} : { completedAt: cycle.completedAt ?? at })
    }, at);
    this.#reconcileSourceLifecycle(schedule, run.agentRunId, at);
    return true;
  }

  public async decideDue(schedule: Schedule, at: string): Promise<BoundScheduleDecision> {
    if (schedule.revision.schemaVersion !== "ScheduleRevision@2") {
      throw new Error("ScheduleRevision@2 is required for Run occurrence admission");
    }
    const freshness = await this.#freshness(schedule.revision);
    return this.#store.withImmediateTransaction(() => {
      const current = this.#store.require(schedule.definition.scheduleId);
      if (current.revision.schemaVersion !== "ScheduleRevision@2" ||
        current.definition.currentRevision !== schedule.definition.currentRevision ||
        current.definition.nextOccurrenceKey !== schedule.definition.nextOccurrenceKey) {
        throw new Error(`Schedule occurrence changed before admission: ${schedule.definition.scheduleId}`);
      }
      const firstAt = current.definition.nextRunAt;
      const occurrenceKey = current.definition.nextOccurrenceKey;
      if (firstAt === undefined || occurrenceKey === undefined) {
        throw new Error(`Active Schedule has no next occurrence: ${current.definition.scheduleId}`);
      }
      const latest = current.revision.kind === "cron"
        ? latestCronOccurrence(current.revision.expression, current.revision.timezone!, at)
        : { scheduledFor: firstAt, occurrenceKey, missingLocalTime: false };
      const lastAt = Date.parse(latest.scheduledFor) >= Date.parse(firstAt)
        ? latest.scheduledFor
        : firstAt;
      const coalescedThrough = lastAt === firstAt ? undefined : lastAt;
      const common = {
        scheduleId: current.definition.scheduleId,
        occurrenceKey,
        scheduledFor: firstAt,
        scheduleRevision: current.definition.currentRevision,
        agentRunId: current.revision.sourceBinding.runId,
        ...(coalescedThrough === undefined ? {} : { coalescedThrough }),
        createdAt: at
      } as const;
      const misfire = current.definition.nextOccurrenceMissing ||
        Date.parse(at) > Date.parse(firstAt) + current.revision.misfireGraceMilliseconds;
      let result: BoundScheduleDecision;
      if (freshness.status !== "matched") {
        const status = freshness.status === "rejected" ? "skipped" : "failed";
        result = {
          kind: status === "skipped" ? "skip" : "failed",
          run: this.#store.insertDueRunInTransaction({
            ...common,
            status,
            decisionReason: freshness.reason
          }).run
        };
      } else if (misfire && current.revision.misfirePolicy === "skip") {
        result = {
          kind: "skip",
          run: this.#store.insertDueRunInTransaction({
            ...common,
            status: "skipped",
            decisionReason: current.definition.nextOccurrenceMissing
              ? "misfire-dst-missing-skip"
              : "misfire-skip"
          }).run
        };
      } else {
        const runState = this.#requireRunState(current.revision);
        const terminal = isTerminalRunState(runState.status);
        const active = !terminal && (runState.status !== "awaiting_source" ||
          runState.activeCycleId !== undefined);
        if (terminal) {
          result = {
            kind: "skip",
            run: this.#store.insertDueRunInTransaction({
              ...common,
              status: "skipped",
              decisionReason: `bound-run-${runState.status}`
            }).run
          };
          this.#reconcileSourceLifecycle(
            current,
            current.revision.sourceBinding.runId,
            at
          );
        } else if (active && current.revision.overlapPolicy === "skip") {
          result = {
            kind: "skip",
            run: this.#store.insertDueRunInTransaction({
              ...common,
              status: "skipped",
              decisionReason: "overlap-skip"
            }).run
          };
        } else if (active) {
          const pending = this.#store.pendingRuns().find(
            (candidate) => candidate.scheduleId === current.definition.scheduleId
          );
          const occurrence = pending === undefined
            ? this.#store.insertDueRunInTransaction({
                ...common,
                status: "queued",
                decisionReason: "overlap-queued"
              }).run
            : this.#store.patchRun(pending.runId, {
                coalescedThrough: latestCoalesced(pending, lastAt),
                decisionReason: "overlap-coalesced"
              }, at);
          result = { kind: "queue", run: occurrence };
        } else {
          const occurrence = this.#store.insertDueRunInTransaction({
            ...common,
            status: "queued",
            decisionReason: misfire ? "misfire-run-once" : "due"
          }).run;
          if (this.#runBinding === undefined) {
            throw new Error("ScheduleRevision@2 Run binding adapter is unavailable");
          }
          result = {
            kind: "admit",
            run: activateScheduleOccurrenceInTransaction({
              store: this.#store,
              adapter: this.#runBinding,
              occurrence,
              revision: current.revision,
              freshnessEvidence: freshness.evidence,
              at
            })
          };
        }
      }
      this.#store.advanceExpected(current.definition.scheduleId, at, at, {
        revision: current.definition.currentRevision,
        occurrenceKey
      });
      return result;
    });
  }

  public async admitPending(
    run: ScheduledRun,
    revision: BoundScheduleRevision,
    at: string
  ): Promise<"admitted" | "deferred" | "failed" | "skipped"> {
    if (this.#runBinding === undefined) {
      this.#store.patchRun(run.runId, {
        status: "failed",
        decisionReason: "run-binding-adapter-unavailable",
        completedAt: at
      }, at);
      return "failed";
    }
    const freshness = await this.#freshness(revision);
    return this.#store.withImmediateTransaction(() => {
      const current = this.#store.requireRun(run.runId);
      if (current.status !== "queued" || current.cycleId !== undefined) return "deferred";
      const schedule = this.#store.require(current.scheduleId);
      if (schedule.definition.status === "cancelled") {
        this.#store.patchRun(current.runId, {
          status: "skipped",
          decisionReason: "schedule-cancelled",
          completedAt: at
        }, at);
        return "skipped";
      }
      if (freshness.status !== "matched") {
        const status = freshness.status === "rejected" ? "skipped" : "failed";
        this.#store.patchRun(current.runId, {
          status,
          decisionReason: freshness.reason,
          completedAt: at
        }, at);
        return status === "skipped" ? "skipped" : "failed";
      }
      const runState = this.#requireRunState(revision);
      if (isTerminalRunState(runState.status)) {
        this.#store.patchRun(current.runId, {
          status: "skipped",
          decisionReason: `bound-run-${runState.status}`,
          completedAt: at
        }, at);
        this.#reconcileSourceLifecycle(schedule, revision.sourceBinding.runId, at);
        return "skipped";
      }
      if (schedule.definition.status === "paused" &&
        !current.occurrenceKey.startsWith("manual:")) {
        return "deferred";
      }
      if (runState.status !== "awaiting_source" || runState.activeCycleId !== undefined) {
        return "deferred";
      }
      activateScheduleOccurrenceInTransaction({
        store: this.#store,
        adapter: this.#runBinding!,
        occurrence: current,
        revision,
        freshnessEvidence: freshness.evidence,
        at
      });
      return "admitted";
    });
  }

  async #freshness(revision: BoundScheduleRevision): Promise<
    | { readonly status: "matched"; readonly evidence: readonly string[] }
    | { readonly status: "rejected" | "failed"; readonly reason: string }
  > {
    if (revision.externalRefBinding === undefined) {
      return {
        status: "matched",
        evidence: [`schedule-definition:${revision.sourceBinding.source.definitionRevision}`]
      };
    }
    if (this.#externalRefGuard === undefined) {
      return { status: "failed", reason: "external-ref-trigger:guard-unavailable" };
    }
    try {
      const checked = await this.#externalRefGuard(revision.externalRefBinding);
      if (checked.status === "rejected") {
        return { status: "rejected", reason: `external-ref-trigger:${checked.reason}` };
      }
      return {
        status: "matched",
        evidence: [
          `schedule-definition:${revision.sourceBinding.source.definitionRevision}`,
          `external-ref:${revision.externalRefBinding.ref.revision}`
        ]
      };
    } catch (error) {
      return { status: "failed", reason: `external-ref-trigger-read:${message(error)}` };
    }
  }

  #requireRunState(revision: BoundScheduleRevision): NonNullable<
    ReturnType<ScheduleRunBindingAdapter["runState"]>
  > {
    if (this.#runBinding === undefined) {
      throw new Error("ScheduleRevision@2 Run binding adapter is unavailable");
    }
    const state = this.#runBinding.runState(revision.sourceBinding.runId);
    if (state === undefined) {
      throw new Error(`Bound Agent Run not found: ${revision.sourceBinding.runId}`);
    }
    return state;
  }

  #reconcileSourceLifecycle(schedule: Schedule, agentRunId: string, at: string): void {
    if (schedule.revision.schemaVersion !== "ScheduleRevision@2" ||
      this.#runBinding === undefined) return;
    const state = this.#runBinding.runState(agentRunId);
    if (state === undefined || !isTerminalRunState(state.status)) return;
    if (schedule.definition.status !== "active" && schedule.definition.status !== "paused") {
      return;
    }
    const action = schedule.revision.sourceBinding.cancellationPolicy === "cancel_source"
      ? "cancel"
      : schedule.definition.status === "active"
        ? "pause"
        : undefined;
    if (action !== undefined) this.#store.setStatus(schedule.definition.scheduleId, action, at);
  }
}

function latestCoalesced(run: ScheduledRun, candidate: string): string {
  const current = run.coalescedThrough ?? run.scheduledFor;
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

function isTerminalRunState(status: string): boolean {
  return ["succeeded", "failed", "needs_human", "cancelled"].includes(status);
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 512);
}
