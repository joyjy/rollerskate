import type { TriggerOccurrenceEnvelope } from
  "../../modules/steward/source-contract.js";
import type {
  BoundScheduleRevision,
  ScheduleOccurrence,
  ScheduleOccurrenceAdmissionReceipt,
  TargetedScheduleRevision
} from "./model.js";
import { proactiveTargetRunBinding } from "../../modules/proactive/target.js";
import type { ScheduleRunBindingAdapter } from "./bound-runtime.js";
import type { ScheduledTaskStore } from "./store.js";

export function activateScheduleOccurrenceInTransaction(input: {
  readonly store: ScheduledTaskStore;
  readonly adapter: ScheduleRunBindingAdapter;
  readonly occurrence: ScheduleOccurrence;
  readonly revision: BoundScheduleRevision | TargetedScheduleRevision;
  readonly freshnessEvidence: readonly string[];
  readonly at: string;
}): ScheduleOccurrence {
  const { occurrence, revision } = input;
  const sourceBinding = revision.schemaVersion === "ScheduleRevision@2"
    ? revision.sourceBinding
    : proactiveTargetRunBinding(revision.target);
  if (sourceBinding === undefined) {
    throw new Error("Schedule occurrence requires a Steward Run target");
  }
  if (occurrence.agentRunId === undefined ||
    occurrence.agentRunId !== sourceBinding.runId) {
    throw new Error("Schedule occurrence does not match its bound Agent Run");
  }
  const envelope: TriggerOccurrenceEnvelope = {
    schemaVersion: "TriggerOccurrenceEnvelope@1",
    source: sourceBinding.source,
    occurrenceKey: occurrence.occurrenceKey,
    sourceRevision: `${sourceBinding.source.definitionRevision}:${occurrence.occurrenceKey}`,
    observedAt: input.at,
    observation: {
      scheduledFor: occurrence.scheduledFor,
      ...(occurrence.coalescedThrough === undefined
        ? {}
        : { coalescedThrough: occurrence.coalescedThrough })
    },
    freshnessEvidence: input.freshnessEvidence,
    binding: {
      runId: sourceBinding.runId,
      seriesKey: sourceBinding.seriesKey,
      authorityDigest: sourceBinding.authorityDigest
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
