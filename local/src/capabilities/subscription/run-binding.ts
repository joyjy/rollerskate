import type {
  RunSourceBinding,
  TriggerOccurrenceEnvelope
} from "../../modules/steward/source-contract.js";
import type { SubscriptionOccurrenceAdmissionReceipt } from "./model.js";

export interface SubscriptionRunBindingAdapter {
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

export function activateSubscriptionOccurrenceInTransaction(input: {
  readonly adapter: SubscriptionRunBindingAdapter;
  readonly binding: RunSourceBinding;
  readonly subscriptionId: string;
  readonly occurrenceKey: string;
  readonly observation: unknown;
  readonly freshnessEvidence: readonly string[];
  readonly at: string;
}): SubscriptionOccurrenceAdmissionReceipt {
  if (input.binding.runId.trim() === "" || input.binding.source.id !== input.subscriptionId) {
    throw new Error("Subscription occurrence does not match its bound Agent Run");
  }
  const envelope: TriggerOccurrenceEnvelope = {
    schemaVersion: "TriggerOccurrenceEnvelope@1",
    source: input.binding.source,
    occurrenceKey: input.occurrenceKey,
    sourceRevision: `${input.binding.source.definitionRevision}:${input.occurrenceKey}`,
    observedAt: input.at,
    observation: input.observation,
    freshnessEvidence: input.freshnessEvidence,
    binding: {
      runId: input.binding.runId,
      seriesKey: input.binding.seriesKey,
      authorityDigest: input.binding.authorityDigest
    }
  };
  const activated = input.adapter.activateOccurrenceInTransaction({
    agentRunId: input.binding.runId,
    envelope,
    at: input.at
  });
  return {
    schemaVersion: "SubscriptionOccurrenceAdmissionReceipt@1",
    subscriptionId: input.subscriptionId,
    occurrenceKey: input.occurrenceKey,
    agentRunId: input.binding.runId,
    cycleId: activated.cycleId,
    orchestratorEventId: activated.orchestratorEventId,
    orchestratorExecutionId: activated.orchestratorExecutionId,
    admittedAt: input.at
  };
}

export function terminalRunStatus(status: string): boolean {
  return ["succeeded", "failed", "needs_human", "cancelled"].includes(status);
}

export function parseSubscriptionOccurrenceAdmissionReceipt(
  value: unknown
): SubscriptionOccurrenceAdmissionReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Subscription occurrence admission receipt must be an object");
  }
  const input = value as Readonly<Record<string, unknown>>;
  const keys = [
    "schemaVersion", "subscriptionId", "occurrenceKey", "agentRunId", "cycleId",
    "orchestratorEventId", "orchestratorExecutionId", "admittedAt"
  ];
  if (Object.keys(input).some((key) => !keys.includes(key)) ||
    keys.some((key) => input[key] === undefined) ||
    input.schemaVersion !== "SubscriptionOccurrenceAdmissionReceipt@1") {
    throw new Error("Subscription occurrence admission receipt is invalid");
  }
  return {
    schemaVersion: "SubscriptionOccurrenceAdmissionReceipt@1",
    subscriptionId: text(input.subscriptionId, "receipt.subscriptionId"),
    occurrenceKey: text(input.occurrenceKey, "receipt.occurrenceKey"),
    agentRunId: text(input.agentRunId, "receipt.agentRunId"),
    cycleId: text(input.cycleId, "receipt.cycleId"),
    orchestratorEventId: text(input.orchestratorEventId, "receipt.orchestratorEventId"),
    orchestratorExecutionId: text(
      input.orchestratorExecutionId,
      "receipt.orchestratorExecutionId"
    ),
    admittedAt: iso(text(input.admittedAt, "receipt.admittedAt"))
  };
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function iso(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("receipt.admittedAt must be RFC 3339");
  return new Date(milliseconds).toISOString();
}
