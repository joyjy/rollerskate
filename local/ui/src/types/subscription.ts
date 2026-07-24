export type SubscriptionStatus =
  | "active"
  | "paused"
  | "running"
  | "triggered"
  | "completed"
  | "failed"
  | "unknown"
  | "cancelled"
  | "expired";

export interface Subscription {
  readonly id: string;
  readonly status: SubscriptionStatus;
  readonly owner: {
    readonly agentId: string;
    readonly handle: string;
    readonly client: "codex";
  };
  readonly callback: {
    readonly providerSessionId: string;
    readonly adapterId: string;
    readonly workspace: string;
    readonly localSessionId: string | null;
    readonly prompt: string;
  };
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
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly fireEventId: string | null;
  readonly latestError: string | null;
}

export type ConsoleView = "runtime" | "agents" | "subscriptions" | "events" | "chats";
