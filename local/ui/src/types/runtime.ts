export type RuntimeStatus = "running" | "paused" | "degraded" | "stopped";
export type RuntimeLoopPhase = "idle" | "in_cycle";
export type RuntimeWorkloadState = "idle" | "running" | "queued" | "retrying";
export type RuntimeFailureOwner =
  | "runtime"
  | "agent"
  | "event"
  | "chat"
  | "subscription"
  | "schedule"
  | "review"
  | "notice";
export type RuntimeFailureSeverity = "warning" | "error";
export type RuntimeFailureActionKind = "inspect" | "recover" | "reconcile" | "configure";
export type RuntimeControlAction = "pause" | "resume" | "recover";
export type RuntimeControlStatus = "succeeded" | "failed";

export interface RuntimeControlAvailability {
  readonly pause: boolean;
  readonly resume: boolean;
  readonly recover: boolean;
}

export interface RuntimeControlResult {
  readonly kind: RuntimeControlAction;
  readonly status: RuntimeControlStatus;
  readonly message: string;
  readonly recovered?: number;
  readonly leftUnknown?: number;
  readonly failed?: number;
}

export interface RuntimeLoopHealth {
  readonly phase: RuntimeLoopPhase;
  readonly totalCycles: number;
  readonly lastCycleStartAt: string | null;
  readonly lastCycleEndAt: string | null;
  readonly lastCycleDurationMs: number | null;
  readonly currentPhaseSummary: string | null;
}

export interface RuntimeWorkload {
  readonly state: RuntimeWorkloadState;
  readonly ready: number;
  readonly running: number;
  readonly retrying: number;
  readonly total: number;
  readonly asOf: string;
}

export interface RuntimeFailureAction {
  readonly kind: RuntimeFailureActionKind;
  readonly available: boolean;
  readonly consoleRoute?: string;
  readonly cliHint: string;
}

export interface RuntimeFailure {
  readonly failureRef: string;
  readonly owner: RuntimeFailureOwner;
  readonly severity: RuntimeFailureSeverity;
  readonly reason: string;
  readonly objectRef: string;
  readonly eventId?: string;
  readonly relatedRef?: string;
  readonly occurredAt: string;
  readonly action: RuntimeFailureAction;
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
  readonly controls: RuntimeControlAvailability;
  readonly workload: RuntimeWorkload;
  readonly failures: readonly RuntimeFailure[];
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
    | "review.requested"
    | "review.decision"
    | "chat.message"
    | "chat.dispatch";
  readonly source: {
    readonly kind: "cli" | "subscription" | "schedule" | "matrix" | "server" | "handler";
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
  readonly promptResourceId?: string;
}

export interface RuntimeExecution {
  readonly executionId: string;
  readonly handler: "agent" | "result" | "review" | "chat";
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
  readonly chat?: {
    readonly promptResourceId?: string;
    readonly attentionReceipts: readonly {
      readonly sourceMessageEventId: string;
      readonly agentId: string;
      readonly outcome: "dispatched" | "skipped";
      readonly reason: string;
      readonly presenceSnapshot: {
        readonly global: ChatPresence;
        readonly topic: ChatPresence;
      };
      readonly dispatchEventId?: string;
      readonly promptResourceId?: string;
      readonly createdAt: string;
    }[];
    readonly decisionReceipt?: {
      readonly dispatchEventId: string;
      readonly speechAction: "reply" | "silent";
      readonly presenceTransition: ChatPresence;
      readonly replyEventId?: string;
      readonly createdAt: string;
    };
  };
  readonly lifecycleChangedAt: string;
  readonly reasonForIntervention: string | null;
  readonly directChildren: readonly { readonly eventId: string; readonly type: string; readonly status: string }[];
  readonly causalityBoundary: "complete" | "missing-parent" | "cross-runtime" | null;
}

export interface ChatPresence {
  readonly scope: "topic" | "global";
  readonly mode: "available" | "snoozed";
  readonly until?: string;
  readonly wakeKeywords: readonly string[];
}
