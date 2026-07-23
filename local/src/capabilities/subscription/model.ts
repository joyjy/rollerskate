export type SubscriptionStatus =
  | "active"
  | "paused"
  | "completed"
  | "cancelled"
  | "expired"
  | "revoked";

export interface ProbeExecutionPolicy {
  readonly workspaceRoot: string;
  readonly allowedHttpOrigins: readonly string[];
  readonly allowedExecutables: readonly string[];
  readonly allowedEnvironment: readonly string[];
  readonly timeoutMilliseconds: number;
  readonly maxOutputBytes: number;
}

export interface SubscriptionCallback {
  readonly sessionId: string;
  readonly prompt: string;
}

export interface CreatePollSubscription {
  readonly subscriptionId: string;
  readonly pluginPath: string;
  readonly pluginId: string;
  readonly pluginSchemaVersion: 1;
  readonly pluginConfig: unknown;
  readonly policy: ProbeExecutionPolicy;
  readonly intervalMilliseconds: number;
  readonly maxWaitMilliseconds: number;
  readonly maxAttempts: number;
  readonly callback: SubscriptionCallback;
}

export interface PollSubscription extends CreatePollSubscription {
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
