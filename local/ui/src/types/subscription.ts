export type SubscriptionStatus =
  | "active"
  | "paused"
  | "running"
  | "triggered"
  | "completed"
  | "failed"
  | "unknown"
  | "cancelled"
  | "expired"
  | "revoked";

export interface Subscription {
  readonly id: string;
  readonly status: SubscriptionStatus;
  readonly sessionId: string;
  readonly plugin: { readonly id: string; readonly path: string; readonly schemaVersion: number };
  readonly schedule: {
    readonly intervalMilliseconds: number;
    readonly maxWaitMilliseconds: number;
    readonly maxAttempts: number;
    readonly attemptCount: number;
    readonly deadlineAt: string;
    readonly nextPollAt: string;
  };
  readonly executionPolicy: {
    readonly allowedHttpOrigins: readonly string[];
    readonly allowedExecutables: readonly string[];
    readonly allowedEnvironment: readonly string[];
    readonly timeoutMilliseconds: number;
    readonly maxOutputBytes: number;
  };
  readonly prompt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly fireEventId: string | null;
  readonly latestError: string | null;
}

export type ConsoleView = "runtime" | "agents" | "subscriptions" | "events" | "rooms";
