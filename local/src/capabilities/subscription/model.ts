export type SubscriptionStatus =
  | "active"
  | "paused"
  | "completed"
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

export interface SubscriptionCallback {
  readonly providerSessionId: string;
  readonly adapterId: string;
  readonly workspace: string;
  readonly localSessionId?: string;
  readonly prompt: string;
}

export interface CreatePollSubscription {
  readonly title: string;
  readonly ownerAgentId: string;
  readonly probe: SubscriptionProbeDefinition;
  readonly intervalMilliseconds: number;
  readonly maxWaitMilliseconds: number;
  readonly maxAttempts: number;
  readonly callback: SubscriptionCallback;
}

export interface PollSubscription extends CreatePollSubscription {
  readonly subscriptionId: string;
  readonly status: SubscriptionStatus;
  readonly attemptCount: number;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly nextPollAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestError?: string;
  readonly fireEventId?: string;
}
