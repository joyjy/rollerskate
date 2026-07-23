import { randomBytes } from "node:crypto";

export const eventTypes = ["agent.request", "subscription.fire", "agent.result"] as const;
export type EventType = (typeof eventTypes)[number];
export type AgentInputEventType = Exclude<EventType, "agent.result">;

export const eventSourceKinds = ["cli", "subscription", "matrix", "server", "handler"] as const;
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
  readonly agentId: string;
  readonly sessionId?: string;
  readonly destinationIds: readonly string[];
  readonly causality: EventCausality;
  readonly createdAt: string;
}

export interface AgentInputEvent extends EventBase {
  readonly type: AgentInputEventType;
  readonly prompt: string;
}

export interface AgentResultEvent extends EventBase {
  readonly type: "agent.result";
  readonly outcome: "succeeded" | "failed";
  readonly output?: string;
  readonly error?: string;
}

export type Event = AgentInputEvent | AgentResultEvent;

export interface CreateEvent {
  readonly eventId?: string;
  readonly type: AgentInputEventType;
  readonly source: EventSource;
  readonly agentId: string;
  readonly prompt: string;
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

export function isAgentInputEvent(event: Event): event is AgentInputEvent {
  return event.type !== "agent.result";
}

export function isAgentResultEvent(event: Event): event is AgentResultEvent {
  return event.type === "agent.result";
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
