import type { LocalAgentClient } from "./local";

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
  readonly title: string;
  readonly status: SubscriptionStatus;
  readonly owner: {
    readonly agentId: string;
    readonly handle: string;
    readonly client: LocalAgentClient;
  };
  readonly callback: {
    readonly providerSessionId: string;
    readonly adapterId: string;
    readonly workspace: string;
    readonly localSessionId: string | null;
    readonly prompt: string;
  };
  readonly probe: {
    readonly plugin: {
      readonly id: string;
      readonly path: string;
      readonly schemaVersion: number;
    };
    readonly policy: {
      readonly allowedHttpOrigins: readonly string[];
      readonly allowedExecutables: readonly string[];
      readonly allowedEnvironment: readonly string[];
      readonly timeoutMilliseconds: number;
      readonly maxOutputBytes: number;
    };
  };
  readonly schedule: {
    readonly intervalMilliseconds: number;
    readonly maxWaitMilliseconds: number;
    readonly maxAttempts: number;
    readonly attemptCount: number;
    readonly deadlineAt: string;
    readonly nextPollAt: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly fireEventId: string | null;
  readonly latestError: string | null;
}

export type ConsoleView =
  | "runtime"
  | "events"
  | "agents"
  | "chats"
  | "reviews"
  | "schedules"
  | "subscriptions";
