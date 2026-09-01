import type { ProactiveCallbackDefinition } from "../../modules/callback/proactive-model.js";
import type { ExternalRefTriggerBinding } from
  "../../modules/external-resource/trigger-binding.js";
import type { RunSourceBinding } from "../../modules/steward/source-contract.js";

export type SubscriptionStatus =
  | "active"
  | "paused"
  | "completed"
  | "blocked"
  | "cancelled"
  | "expired";

export interface ProbeExecutionPolicy {
  readonly workspaceRoot: string;
  readonly allowedHttpOrigins: readonly string[];
  readonly allowedExecutables: readonly string[];
  readonly allowedEnvironment: readonly string[];
  readonly timeoutMilliseconds: number;
  readonly maxOutputBytes: number;
}

export interface SubscriptionPluginDefinition {
  readonly path: string;
  readonly id: string;
  readonly schemaVersion: 1;
  readonly config: unknown;
}

export interface SubscriptionProbeDefinition {
  readonly plugin: SubscriptionPluginDefinition;
  readonly policy: ProbeExecutionPolicy;
}

export interface FreeSubscriptionDefinition {
  readonly schemaVersion: 3;
  readonly revision: string;
  readonly title: string;
  readonly ownerAgentId: string;
  readonly probe: SubscriptionProbeDefinition & {
    readonly artifactRevision: string;
    readonly artifactDigest: string;
  };
  readonly intervalMilliseconds: number;
  readonly maxWaitMilliseconds: number;
  readonly maxAttempts: number;
  readonly callbacks: readonly FreeSubscriptionCallback[];
  readonly approvedGrantDigest: string;
  readonly externalRefBinding?: ExternalRefTriggerBinding;
}

export interface BoundSubscriptionDefinition {
  readonly schemaVersion: "SubscriptionDefinition@4";
  readonly revision: string;
  readonly title: string;
  readonly probe: SubscriptionProbeDefinition & {
    readonly artifactRevision: string;
    readonly artifactDigest: string;
  };
  readonly intervalMilliseconds: number;
  readonly maxWaitMilliseconds: number;
  readonly maxAttempts: number;
  readonly sourceBinding: RunSourceBinding;
  readonly externalRefBinding?: ExternalRefTriggerBinding;
}

export type FreeSubscriptionCallback = ProactiveCallbackDefinition;

export interface FreeSubscription {
  readonly subscriptionId: string;
  readonly definitionSchema: "SubscriptionDefinition@3" | "SubscriptionDefinition@4";
  readonly definitionRevision: string;
  readonly definitionDigest: string;
  readonly title: string;
  readonly ownerAgentId?: string;
  readonly sourceBinding?: RunSourceBinding;
  readonly agentRunId?: string;
  readonly cycleId?: string;
  readonly admissionReceipt?: SubscriptionOccurrenceAdmissionReceipt;
  readonly probe: FreeSubscriptionDefinition["probe"];
  readonly externalRefBinding?: ExternalRefTriggerBinding;
  readonly intervalMilliseconds: number;
  readonly maxWaitMilliseconds: number;
  readonly maxAttempts: number;
  readonly attemptCount: number;
  readonly status: SubscriptionStatus;
  readonly archivedAt?: string;
  readonly callbackPhaseStatus:
    | "pending"
    | "running"
    | "completed"
    | "blocked"
    | "completed_with_errors"
    | "completed_with_unknown";
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly nextPollAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestError?: string;
  readonly terminalKey?: string;
  readonly terminalObservation?: unknown;
}

export interface SubscriptionOccurrenceAdmissionReceipt {
  readonly schemaVersion: "SubscriptionOccurrenceAdmissionReceipt@1";
  readonly subscriptionId: string;
  readonly occurrenceKey: string;
  readonly agentRunId: string;
  readonly cycleId: string;
  readonly orchestratorEventId: string;
  readonly orchestratorExecutionId: string;
  readonly admittedAt: string;
}
