import { randomBytes } from "node:crypto";
import type { AgentRunContext } from "../runtime/model.js";

export const eventTypes = [
  "agent.request",
  "subscription.fire",
  "agent.result",
  "chat.activation",
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
  readonly runContext?: AgentRunContext;
}

export interface SubscriptionFireObservation {
  readonly version: string;
  readonly terminalKey?: string;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly terminal: "success" | "failure" | "cancelled";
  readonly summary?: string;
}

export interface SubscriptionFireEvent extends EventBase {
  readonly type: "subscription.fire";
  readonly agentId: string;
  readonly prompt: string;
  readonly observation?: SubscriptionFireObservation;
  readonly invocation?: SubscriptionAgentInvocation;
}

export interface SubscriptionAgentInvocation {
  readonly schemaVersion: "SubscriptionAgentInvocation@1";
  readonly resultSchema: "SubscriptionAgentResult@1";
  readonly workspaceGrant: import("../runtime/model.js").ExternalWorkspaceGrant;
  readonly networkAccess: boolean;
}

export type AgentInputEvent = AgentRequestEvent | SubscriptionFireEvent;

export interface AgentResultEvent extends EventBase {
  readonly type: "agent.result";
  readonly agentId: string;
  readonly outcome: "succeeded" | "failed";
  readonly output?: string;
  readonly error?: string;
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
  readonly replyToEventId?: string;
  readonly conversation?: {
    readonly strategyId: "human-message" | "participant-message";
    readonly turnBudget: number;
  };
  readonly targets?: readonly ChatMessageTarget[];
  readonly dispatchCard?: {
    readonly sourceMessageEventId: string;
    readonly candidates: readonly {
      readonly principalId: string;
      readonly handle: string;
    }[];
  };
  readonly runProposalDecision?: ChatRunProposalDecision;
}

export interface ChatRunProposalDecision {
  readonly schema: "ChatRunProposalDecision@1";
  readonly sourceMessageEventId: string;
  readonly dispatchEventId: string;
  readonly action: "declined";
  readonly actor: {
    readonly kind: "owner";
    readonly principalId: string;
  };
  readonly decidedAt: string;
}

export interface ChatMessageTarget {
  readonly principalId: string;
  readonly handleSnapshot: string;
}

export function parseChatMessageTargets(
  payload: Readonly<Record<string, unknown>>,
  eventId: string
): readonly ChatMessageTarget[] | undefined {
  const current = payload.targets;
  const legacy = payload.target;
  if (current !== undefined && legacy !== undefined) {
    throw new Error(`Chat message has both target and targets: ${eventId}`);
  }
  const values = current === undefined
    ? legacy === undefined ? undefined : [legacy]
    : current;
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length === 0 || values.length > 64 ||
    values.some((value) => !isRecord(value) ||
      typeof value.principalId !== "string" || value.principalId.trim() === "" ||
      typeof value.handleSnapshot !== "string" || value.handleSnapshot.trim() === "")) {
    throw new Error(`Chat message targets are malformed: ${eventId}`);
  }
  const targets = values.map((value) => ({
    principalId: (value as { principalId: string }).principalId,
    handleSnapshot: (value as { handleSnapshot: string }).handleSnapshot
  }));
  if (new Set(targets.map((target) => target.principalId)).size !== targets.length) {
    throw new Error(`Chat message targets contain duplicates: ${eventId}`);
  }
  return targets;
}

export function parseChatRunProposalDecision(
  value: unknown,
  eventId: string
): ChatRunProposalDecision | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.schema !== "ChatRunProposalDecision@1" ||
    typeof value.sourceMessageEventId !== "string" ||
    typeof value.dispatchEventId !== "string" || value.action !== "declined" ||
    !isRecord(value.actor) || value.actor.kind !== "owner" ||
    typeof value.actor.principalId !== "string" ||
    typeof value.decidedAt !== "string") {
    throw new Error(`Chat Run proposal decision is malformed: ${eventId}`);
  }
  return {
    schema: "ChatRunProposalDecision@1",
    sourceMessageEventId: value.sourceMessageEventId,
    dispatchEventId: value.dispatchEventId,
    action: "declined",
    actor: { kind: "owner", principalId: value.actor.principalId },
    decidedAt: value.decidedAt
  };
}

export type ChatActivationReason =
  | "topic_opened"
  | "manual"
  | "scheduled"
  | "participant_message"
  | "resumed"
  | "work_result";

export type ChatActivationStrategy =
  | "starter"
  | "manual"
  | "scheduled"
  | "participant-message"
  | "work-result";

export interface ChatActivationEvent extends EventBase {
  readonly type: "chat.activation";
  readonly topicId: string;
  readonly reason: ChatActivationReason;
  readonly strategyId: ChatActivationStrategy;
  readonly strategyRevision: number;
  readonly contextRevision: number;
  readonly conversationIntent: import("../chat/model.js").ConversationIntentSnapshot;
  readonly candidateAgentIds: readonly string[];
  readonly sequentialDispatch?: boolean;
  readonly sourceEventId?: string;
  readonly turnBudget: number;
  readonly expiresAt: string;
}

export interface ChatDispatchEvent extends EventBase {
  readonly type: "chat.dispatch";
  readonly agentId: string;
  readonly topicId: string;
  readonly sourceAttentionEventId: string;
  /** Present for message-triggered dispatches stored before/after v0.5.1. */
  readonly sourceMessageEventId?: string;
  readonly targetHandleSnapshot: string;
  readonly promptResourceId: string;
  readonly prompt: string;
  readonly admissionSnapshot?: {
    readonly revision: number;
    readonly participantRevision: number;
  };
  readonly profileContext?: import("../chat/model.js").ChatProfileContext;
}

export type Event =
  | AgentInputEvent
  | AgentResultEvent
  | ChatActivationEvent
  | ChatMessageEvent
  | ChatDispatchEvent;

export interface CreateEvent {
  readonly eventId?: string;
  readonly type: "agent.request" | "subscription.fire";
  readonly source: EventSource;
  readonly agentId: string;
  readonly prompt: string;
  readonly observation?: SubscriptionFireObservation;
  readonly subscriptionInvocation?: SubscriptionAgentInvocation;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
