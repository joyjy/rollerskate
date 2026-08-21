import type { ProactiveCallbackDefinition } from "../../modules/callback/proactive-model.js";
import type { ExternalRefTriggerBinding } from
  "../../modules/external-resource/trigger-binding.js";
import type { ProbeExecutionPolicy } from "./model.js";
import type { PollObservation } from "./plugin-contract.js";

export interface ContinuousSubscriptionDefinition {
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

export interface ContinuousSubscription {
  readonly subscriptionId: string;
  readonly definition: ContinuousSubscriptionDefinition;
  readonly status: "active" | "paused" | "blocked" | "cancelled";
  readonly pollCount: number;
  readonly nextPollAt: string;
  readonly checkpointOccurrenceKey?: string;
  readonly checkpointObservation?: PollObservation;
  readonly pendingOccurrenceKey?: string;
  readonly pendingObservation?: PollObservation;
  readonly latestError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
