import type { TriggerOccurrenceEnvelope } from
  "../../modules/steward/source-contract.js";
import type {
  BoundScheduleRevision,
  ScheduleOccurrence,
  ScheduleOccurrenceAdmissionReceipt
} from "./model.js";
import type { ScheduleRunBindingAdapter } from "./bound-runtime.js";
import type { ScheduledTaskStore } from "./store.js";

export function activateScheduleOccurrenceInTransaction(input: {
  readonly store: ScheduledTaskStore;
  readonly adapter: ScheduleRunBindingAdapter;
  readonly occurrence: ScheduleOccurrence;
  readonly revision: BoundScheduleRevision;
  readonly freshnessEvidence: readonly string[];
  readonly at: string;
}): ScheduleOccurrence {
  const { occurrence, revision } = input;
  if (occurrence.agentRunId === undefined ||
    occurrence.agentRunId !== revision.sourceBinding.runId) {
    throw new Error("Schedule occurrence does not match its bound Agent Run");
  }
  const envelope: TriggerOccurrenceEnvelope = {
    schemaVersion: "TriggerOccurrenceEnvelope@1",
    source: revision.sourceBinding.source,
    occurrenceKey: occurrence.occurrenceKey,
    sourceRevision: `${revision.sourceBinding.source.definitionRevision}:${occurrence.occurrenceKey}`,
    observedAt: input.at,
    observation: {
      scheduledFor: occurrence.scheduledFor,
      ...(occurrence.coalescedThrough === undefined
        ? {}
        : { coalescedThrough: occurrence.coalescedThrough })
    },
    freshnessEvidence: input.freshnessEvidence,
    binding: {
      runId: revision.sourceBinding.runId,
      seriesKey: revision.sourceBinding.seriesKey,
      authorityDigest: revision.sourceBinding.authorityDigest
    }
  };
  const activated = input.adapter.activateOccurrenceInTransaction({
    agentRunId: occurrence.agentRunId,
    envelope,
    at: input.at
  });
  const admissionReceipt: ScheduleOccurrenceAdmissionReceipt = {
    schemaVersion: "ScheduleOccurrenceAdmissionReceipt@1",
    scheduleId: occurrence.scheduleId,
    occurrenceId: occurrence.runId,
    agentRunId: occurrence.agentRunId,
    cycleId: activated.cycleId,
    orchestratorEventId: activated.orchestratorEventId,
    orchestratorExecutionId: activated.orchestratorExecutionId,
    admittedAt: input.at
  };
  return input.store.patchRun(occurrence.runId, {
    status: "running",
    admittedAt: input.at,
    cycleId: activated.cycleId,
    admissionReceipt
  }, input.at);
}
