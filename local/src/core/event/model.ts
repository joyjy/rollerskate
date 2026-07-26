import { randomBytes } from "node:crypto";
import type { AgentRunContext } from "../runtime/model.js";

export const eventTypes = [
  "agent.request",
  "subscription.fire",
  "agent.result",
  "review.requested",
  "review.decision",
  "chat.message",
  "chat.dispatch"
] as const;
export type EventType = (typeof eventTypes)[number];
export type AgentInputEventType = "agent.request" | "subscription.fire" | "chat.dispatch";

export const eventSourceKinds = [
  "cli",
  "subscription",
  "schedule",
  "matrix",
  "server",
  "handler"
] as const;
export type EventSourceKind = (typeof eventSourceKinds)[number];

export interface EventSource {
  readonly kind: EventSourceKind;
  readonly externalId?: string;
}

export interface EventCausality {
  readonly rootEventId: string;
  readonly parentEventId?: string;
  readonly hop: number;
}

interface EventBase {
  readonly eventId: string;
  readonly type: EventType;
  readonly source: EventSource;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly destinationIds: readonly string[];
  readonly causality: EventCausality;
  readonly createdAt: string;
}

export interface AgentRequestEvent extends EventBase {
  readonly type: "agent.request";
  readonly agentId: string;
  readonly prompt: string;
  readonly reviewInvocation?: ReviewAgentInvocation;
  readonly runContext?: AgentRunContext;
}

export interface ReviewReference {
  readonly kind: "acceptance";
  readonly ref: string;
  readonly revision: string;
}

export interface ReviewEvidenceReference {
  readonly kind: "workspace";
  readonly ref: string;
  readonly revision: string;
}

export interface ReviewAgentInvocation {
  readonly schemaVersion: "review-invocation@1";
  readonly role: "reviewer" | "implementer";
  readonly rootEventId: string;
  readonly cycleIndex: number;
  readonly subject: ReviewReference;
  readonly artifactRef: string;
  readonly artifactRevision?: string;
  readonly evidence: readonly ReviewEvidenceReference[];
  readonly implementationRevision: string;
  readonly workspaceAccess: "read" | "write";
  readonly writableRoot?: string;
  readonly resultSchema: "ReviewerResult@1" | "ImplementerResult@1";
}

export interface SubscriptionFireObservation {
  readonly version: string;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly terminal: "success" | "failure" | "cancelled";
  readonly summary?: string;
}

export interface SubscriptionFireEvent extends EventBase {
  readonly type: "subscription.fire";
  readonly agentId: string;
  readonly prompt: string;
  readonly observation?: SubscriptionFireObservation;
}

export type AgentInputEvent = AgentRequestEvent | SubscriptionFireEvent;

export interface AgentResultEvent extends EventBase {
  readonly type: "agent.result";
  readonly agentId: string;
  readonly outcome: "succeeded" | "failed";
  readonly output?: string;
  readonly error?: string;
}

export interface ReviewRequestedEvent extends EventBase {
  readonly type: "review.requested";
  readonly cycleIndex: number;
  readonly subject: ReviewReference;
  readonly artifactRef: string;
  readonly artifactRevision?: string;
  readonly evidence: readonly ReviewEvidenceReference[];
  readonly implementationRevision: string;
  readonly reviewerAgentId: string;
  readonly implementerAgentId: string;
  readonly reworkLimit: number;
}

export interface ReviewDecisionEvent extends EventBase {
  readonly type: "review.decision";
  readonly cycleIndex: number;
  readonly requestedEventId: string;
  readonly reviewerResultEventId: string;
  readonly decision: "passed" | "findings" | "blocked";
  readonly boundedSummary: string;
  readonly revisionsRead: {
    readonly subject: string;
    readonly artifact?: string;
    readonly evidence: readonly ReviewEvidenceReference[];
  };
  readonly artifactRevision: string;
  readonly openFindingCount: number;
  readonly blockedReason?: string;
}

export interface ChatMessageEvent extends EventBase {
  readonly type: "chat.message";
  readonly topicId: string;
  readonly sender: {
    readonly kind: "owner" | "agent" | "system";
    readonly principalId?: string;
    readonly handleSnapshot: string;
  };
  readonly body: string;
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
}

export interface ChatDispatchEvent extends EventBase {
  readonly type: "chat.dispatch";
  readonly agentId: string;
  readonly topicId: string;
  readonly sourceMessageEventId: string;
  readonly targetHandleSnapshot: string;
  readonly promptResourceId: string;
  readonly prompt: string;
}

export type Event =
  | AgentInputEvent
  | AgentResultEvent
  | ReviewRequestedEvent
  | ReviewDecisionEvent
  | ChatMessageEvent
  | ChatDispatchEvent;

export interface CreateEvent {
  readonly eventId?: string;
  readonly type: "agent.request";
  readonly source: EventSource;
  readonly agentId: string;
  readonly prompt: string;
  readonly reviewInvocation?: ReviewAgentInvocation;
  readonly runContext?: AgentRunContext;
  readonly sessionId?: string;
  readonly destinationIds?: readonly string[];
  readonly parent?: {
    readonly eventId: string;
    readonly rootEventId: string;
    readonly hop: number;
  };
  readonly createdAt?: string;
  readonly maxAttempts?: number;
}

export function isAgentInputEvent(
  event: Event
): event is AgentInputEvent | ChatDispatchEvent {
  return event.type === "agent.request" ||
    event.type === "subscription.fire" ||
    event.type === "chat.dispatch";
}

export function isAgentResultEvent(event: Event): event is AgentResultEvent {
  return event.type === "agent.result";
}

export function isChatMessageEvent(event: Event): event is ChatMessageEvent {
  return event.type === "chat.message";
}

export function newEventId(): string {
  return prefixedUuidV7("evt");
}

export function requireEventId(value: string, field = "eventId"): string {
  if (!/^evt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(`${field} must be an evt_ UUIDv7`);
  }
  return value;
}

function prefixedUuidV7(prefix: "evt"): string {
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
