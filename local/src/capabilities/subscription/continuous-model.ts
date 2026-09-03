import type { ProactiveCallbackDefinition } from "../../modules/callback/proactive-model.js";
import type { ExternalRefTriggerBinding } from
  "../../modules/external-resource/trigger-binding.js";
import type {
  ProbeExecutionPolicy,
  SubscriptionOccurrenceAdmissionReceipt
} from "./model.js";
import type { RunSourceBinding } from "../../modules/steward/source-contract.js";
import type {
  DeterministicApplicationActionReceipt,
  ProactiveTarget
} from "../../modules/proactive/target.js";
import type { PollObservation } from "./plugin-contract.js";

export interface LegacyContinuousSubscriptionDefinition {
  readonly schemaVersion: "ContinuousSubscriptionDefinition@1";
  readonly revision: number;
  readonly title: string;
  readonly ownerAgentId: string;
  readonly probe: {
    readonly plugin: {
      readonly path: string;
      readonly id: string;
      readonly config: unknown;
    };
    readonly policy: ProbeExecutionPolicy;
  };
  readonly intervalMilliseconds: number;
  readonly callbacks: readonly ProactiveCallbackDefinition[];
  readonly externalRefBinding?: ExternalRefTriggerBinding;
}

export interface BoundContinuousSubscriptionDefinition {
  readonly schemaVersion: "ContinuousSubscriptionDefinition@2";
  readonly revision: number;
  readonly title: string;
  readonly probe: LegacyContinuousSubscriptionDefinition["probe"];
  readonly intervalMilliseconds: number;
  readonly sourceBinding: RunSourceBinding;
  readonly externalRefBinding?: ExternalRefTriggerBinding;
}

export interface TargetedContinuousSubscriptionDefinition extends Omit<
  BoundContinuousSubscriptionDefinition,
  "schemaVersion" | "sourceBinding"
> {
  readonly schemaVersion: "ContinuousSubscriptionDefinition@3";
  readonly target: ProactiveTarget;
}

export type ContinuousSubscriptionDefinition =
  | LegacyContinuousSubscriptionDefinition
  | BoundContinuousSubscriptionDefinition
  | TargetedContinuousSubscriptionDefinition;

export interface ContinuousSubscription {
  readonly subscriptionId: string;
  readonly definition: ContinuousSubscriptionDefinition;
  readonly status: "active" | "paused" | "blocked" | "cancelled";
  readonly archivedAt?: string;
  readonly pollCount: number;
  readonly nextPollAt: string;
  readonly checkpointOccurrenceKey?: string;
  readonly checkpointObservation?: PollObservation;
  readonly pendingOccurrenceKey?: string;
  readonly pendingObservation?: PollObservation;
  readonly agentRunId?: string;
  readonly pendingCycleId?: string;
  readonly pendingAdmissionReceipt?: SubscriptionOccurrenceAdmissionReceipt;
  readonly latestActionReceipt?: DeterministicApplicationActionReceipt;
  readonly latestError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
