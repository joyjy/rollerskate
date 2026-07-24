export type RuntimeStatus = "running" | "paused" | "degraded";

export interface RuntimeControlResult {
  readonly kind: "none" | "pause" | "resume" | "recover";
  readonly status: "idle" | "in-progress" | "succeeded" | "failed";
  readonly message: string;
  readonly recovered?: number;
  readonly leftUnknown?: number;
  readonly failed?: number;
}

export interface RuntimeLoopHealth {
  readonly state: "idle" | "ticking" | "paused" | "degraded";
  readonly totalCycles: number;
  readonly lastCycleStartAt: string | null;
  readonly lastCycleEndAt: string | null;
  readonly lastCycleDurationMs: number | null;
  readonly nextCycleAt: string | null;
  readonly inCycle: boolean;
  readonly currentPhaseSummary: string | null;
}

export interface RuntimeWorkload {
  readonly queuedExecutions: number;
  readonly runningExecutions: number;
  readonly retryWaitExecutions: number;
  readonly failedExecutions: number;
  readonly agentResultSucceeded: number;
  readonly agentResultFailed: number;
  readonly pendingDeliveries: number;
  readonly retryingDeliveries: number;
  readonly failedDeliveries: number;
}

export interface RuntimeIsolation {
  readonly occurredAt: string;
  readonly eventId: string;
  readonly executionId?: string;
  readonly subscriptionId?: string;
  readonly destinationId?: string;
  readonly boundedError: string;
  readonly loopContinued: boolean;
}

export interface RuntimeAgentSummary {
  readonly registered: number;
  readonly callable: number;
  readonly unavailable: number;
}

export interface RuntimeEventSummary {
  readonly lastReceivedAt: string | null;
  readonly waiting: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
}

export interface RuntimeSessionSummary {
  readonly total: number;
  readonly lastResumedAt: string | null;
  readonly mismatched: number;
}

export interface RuntimeSubscriptionSummary {
  readonly active: number;
  readonly paused: number;
  readonly expired: number;
  readonly failedUnknown: number;
}

export interface RuntimeDestinationSummary {
  readonly available: number;
  readonly pending: number;
  readonly retrying: number;
  readonly failed: number;
}

export interface RuntimeCapability {
  readonly name: string;
  readonly version: string;
  readonly available: boolean;
}

export interface RuntimeIntegration {
  readonly name: string;
  readonly kind: "adapter" | "control-plane" | "ingress" | "delivery";
  readonly status: "connected" | "degraded" | "disconnected";
  readonly lastSuccessAt: string | null;
  readonly failureReason: string | null;
}

export interface RuntimeLogEntry {
  readonly timestamp: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly subsystem: string;
  readonly message: string;
  readonly objectId: string | null;
}

export interface RuntimeInfo {
  readonly status: RuntimeStatus;
  readonly statusReason: string;
  readonly recommendedAction: string;
  readonly statusSince: string;
  readonly version: string;
  readonly runtimeRoot: string;
  readonly workspaceRoot: string;
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly schemaVersion: number | null;
  readonly consoleAddress: string;
  readonly lastRefreshedAt: string;
  readonly stale: boolean;
  readonly loop: RuntimeLoopHealth;
  readonly workload: RuntimeWorkload;
  readonly recentIsolations: readonly RuntimeIsolation[];
  readonly agents: RuntimeAgentSummary;
  readonly events: RuntimeEventSummary;
  readonly sessions: RuntimeSessionSummary;
  readonly subscriptions: RuntimeSubscriptionSummary;
  readonly destinations: RuntimeDestinationSummary;
  readonly capabilities: readonly RuntimeCapability[];
  readonly integrations: readonly RuntimeIntegration[];
  readonly recentLogs: readonly RuntimeLogEntry[];
  readonly controlResult: RuntimeControlResult | null;
}

export interface Causality {
  readonly rootEventId: string;
  readonly parentEventId?: string;
  readonly hop: number;
}

export interface RuntimeEvent {
  readonly eventId: string;
  readonly type:
    | "agent.request"
    | "subscription.fire"
    | "agent.result"
    | "chat.message"
    | "chat.dispatch";
  readonly source: {
    readonly kind: "cli" | "subscription" | "matrix" | "server" | "handler";
    readonly externalId?: string;
  };
  readonly agentId?: string;
  readonly prompt?: string;
  readonly boundedPromptSummary?: string;
  readonly outcome?: "succeeded" | "failed";
  readonly output?: string;
  readonly error?: string;
  readonly sessionId?: string;
  readonly destinationIds: readonly string[];
  readonly causality: Causality;
  readonly createdAt: string;
  readonly topicId?: string;
  readonly sender?: {
    readonly kind: "owner" | "agent" | "system";
    readonly principalId?: string;
    readonly handleSnapshot: string;
  };
  readonly body?: string;
  readonly target?: {
    readonly principalId: string;
    readonly handleSnapshot: string;
  };
  readonly dispatchCard?: {
    readonly sourceMessageEventId: string;
    readonly candidates: readonly {
      readonly principalId: string;
      readonly handle: string;
    }[];
  };
  readonly sourceMessageEventId?: string;
  readonly targetHandleSnapshot?: string;
}

export interface RuntimeExecution {
  readonly executionId: string;
  readonly handler: "agent" | "result";
  readonly status: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly firstStartedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly completedAt: string | null;
  readonly nextAttemptAt: string;
  readonly lastError?: string;
}

export interface RuntimeResultEvent {
  readonly eventId: string;
  readonly type: "agent.result";
  readonly outcome: "succeeded" | "failed";
  readonly sessionId?: string;
  readonly output?: string;
  readonly error?: string;
  readonly causality: Causality;
  readonly createdAt: string;
}

export interface RuntimeSession {
  readonly sessionId: string;
  readonly agentId: string;
  readonly adapterId: string;
  readonly providerSessionId: string;
  readonly workspace: string;
  readonly createdAt: string;
  readonly resumedAt: string | null;
}

export interface RuntimeDelivery {
  readonly delivery: {
    readonly deliveryId: string;
    readonly resultEventId: string;
    readonly status: string;
    readonly attemptCount: number;
    readonly source: string;
    readonly createdAt: string;
    readonly attemptedAt: string | null;
    readonly deliveredAt: string | null;
    readonly receipt?: string;
    readonly boundedError?: string;
    readonly lastError?: string;
  };
  readonly destination: {
    readonly destinationId: string;
    readonly kind: "matrix";
    readonly address: Readonly<Record<string, string>>;
  };
}

export interface RuntimeAudit {
  readonly event: RuntimeEvent;
  readonly execution?: RuntimeExecution;
  readonly resultEvent?: RuntimeResultEvent;
  readonly resultExecution?: RuntimeExecution;
  readonly session?: RuntimeSession;
  readonly deliveries: readonly RuntimeDelivery[];
  readonly lifecycleChangedAt: string;
  readonly reasonForIntervention: string | null;
  readonly directChildren: readonly { readonly eventId: string; readonly type: string; readonly status: string }[];
  readonly causalityBoundary: "complete" | "missing-parent" | "cross-runtime" | null;
}
