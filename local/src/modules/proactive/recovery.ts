import type { ExternalWorkflowExecutionReceipt, TriggerSourceRef } from "./target.js";

export interface ExternalWorkflowRecoveryRequest {
  readonly source: TriggerSourceRef;
  readonly executionId: string;
  readonly expectedAttemptCount: number;
  readonly requestId: string;
  readonly action: "retry" | "resolve-succeeded" | "resolve-failed";
  readonly reason: string;
  readonly retrySafe?: true;
}

/** Immutable Owner decision; retained even when the same execution is retried. */
export interface ExternalWorkflowRecoveryReceipt {
  readonly schemaVersion: "ExternalWorkflowRecoveryReceipt@1";
  readonly request: ExternalWorkflowRecoveryRequest;
  readonly occurrenceKey: string;
  readonly previousReceipt: ExternalWorkflowExecutionReceipt;
  readonly previousUnknownReceipt?: ExternalWorkflowExecutionReceipt;
  readonly outcome: "queued" | "succeeded" | "failed";
  readonly resolvedReceipt?: ExternalWorkflowExecutionReceipt;
  readonly acceptedAt: string;
}
