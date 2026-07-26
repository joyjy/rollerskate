import { randomBytes } from "node:crypto";
import type { EventType } from "../event/model.js";

export const runtimeHandlerKinds = [
  "agent",
  "result",
  "review",
  "chat"
] as const;
export type RuntimeHandlerKind = (typeof runtimeHandlerKinds)[number];

export interface RuntimeRoute {
  readonly eventType: EventType;
  readonly handler: RuntimeHandlerKind;
}

const runtimeRoutes: Readonly<Record<EventType, RuntimeRoute>> = {
  "agent.request": { eventType: "agent.request", handler: "agent" },
  "subscription.fire": { eventType: "subscription.fire", handler: "agent" },
  "agent.result": { eventType: "agent.result", handler: "result" },
  "review.requested": { eventType: "review.requested", handler: "review" },
  "review.decision": { eventType: "review.decision", handler: "review" },
  "chat.dispatch": { eventType: "chat.dispatch", handler: "agent" },
  "chat.message": { eventType: "chat.message", handler: "chat" }
};

export function runtimeRoute(eventType: EventType): RuntimeRoute {
  return runtimeRoutes[eventType];
}

export type RuntimeExecutionStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RuntimeExecution {
  readonly executionId: string;
  readonly eventId: string;
  readonly handler: RuntimeHandlerKind;
  readonly status: RuntimeExecutionStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: string;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly updatedAt: string;
}

export interface RuntimeSession {
  readonly sessionId: string;
  readonly agentId: string;
  readonly runId?: string;
  readonly adapterId: string;
  readonly providerSessionId: string;
  readonly workspace: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExternalWorkspaceGrant {
  readonly schemaVersion: "ExternalWorkspaceGrant@1";
  readonly root: string;
  readonly access: "read" | "write";
  readonly revision: string;
}

export interface AgentCompletionBinding {
  readonly schemaVersion: "AgentCompletionBinding@1";
  readonly callerAgentId: string;
  readonly callerSessionId: string;
  readonly callerStepId: string;
  readonly callerRequestEventId: string;
}

export interface AgentStepCompletion {
  readonly schemaVersion: "AgentStepCompletion@1";
  readonly childAgentId: string;
  readonly childStepId: string;
  readonly childRequestEventId: string;
  readonly childResultEventId: string;
  readonly childExecutionId: string;
  readonly outcome: "succeeded" | "failed" | "needs_human";
  readonly summary: string;
  readonly artifactRefs: readonly string[];
  readonly observedWorkspaceRevision?: string;
}

export interface AgentRunContext {
  readonly schemaVersion: "AgentRunContext@1";
  readonly resultContractId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly depth: number;
  readonly parentStepId?: string;
  readonly workspaceGrant?: ExternalWorkspaceGrant;
  readonly completionBinding?: AgentCompletionBinding;
  readonly stepCompletion?: AgentStepCompletion;
}

export interface RuntimeDestination {
  readonly destinationId: string;
  readonly kind: "matrix" | "macos-notification";
  readonly address: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuntimeDelivery {
  readonly deliveryId: string;
  readonly resultEventId: string;
  readonly destinationId: string;
  readonly status: "pending" | "delivering" | "retry_wait" | "delivered" | "failed";
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: string;
  readonly receipt?: string;
  readonly lastError?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function runtimeId(prefix: "exe" | "ses" | "dst" | "del"): string {
  const bytes = randomBytes(16);
  const milliseconds = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number((milliseconds >> BigInt((5 - index) * 8)) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function requireRuntimeId(value: string, prefix: string, field: string): string {
  if (!new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
    .test(value)) {
    throw new Error(`${field} must be a ${prefix}_ UUIDv7`);
  }
  return value;
}
