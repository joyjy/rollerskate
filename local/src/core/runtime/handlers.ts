import {
  isAgentInputEvent,
  isAgentResultEvent,
  type AgentInputEvent,
  type AgentResultEvent,
  type Event,
  type ChatDispatchEvent,
  type ChatMessageEvent
} from "../event/model.js";
import type {
  RuntimeExecution,
  RuntimeDelivery,
  RuntimeDestination,
  RuntimeHandlerKind,
  RuntimeSession
} from "./model.js";
import { RuntimeStore } from "./store.js";

export interface RuntimeAgentAdapter {
  readonly adapterId: string;
  readonly workspace: string;
  invoke(input: {
    readonly event: AgentInputEvent | ChatDispatchEvent;
    readonly providerSessionId?: string;
  }): Promise<{
    readonly providerSessionId: string;
    readonly outcome:
      | { readonly kind: "message"; readonly body: string }
      | { readonly kind: "silent" };
  }>;
}

export class AgentHandler {
  public readonly kind = "agent" as const;
  readonly #adapterForAgent: (
    agentId: string,
    workspace?: string
  ) => RuntimeAgentAdapter | undefined;
  readonly #store: RuntimeStore;
  readonly #retryBaseMilliseconds: number;

  public constructor(options: {
    readonly store: RuntimeStore;
    readonly adapters?: ReadonlyMap<string, RuntimeAgentAdapter>;
    readonly adapterForAgent?: (
      agentId: string,
      workspace?: string
    ) => RuntimeAgentAdapter | undefined;
    readonly retryBaseMilliseconds?: number;
  }) {
    this.#store = options.store;
    if (options.adapters !== undefined && options.adapterForAgent !== undefined) {
      throw new Error("AgentHandler accepts adapters or adapterForAgent, not both");
    }
    if (options.adapters === undefined && options.adapterForAgent === undefined) {
      throw new Error("AgentHandler requires an Agent adapter source");
    }
    this.#adapterForAgent = options.adapterForAgent ??
      ((agentId) => options.adapters!.get(agentId));
    this.#retryBaseMilliseconds = options.retryBaseMilliseconds ?? 1_000;
  }

  public async handle(
    execution: RuntimeExecution,
    at = new Date().toISOString()
  ): Promise<AgentResultEvent | ChatMessageEvent | undefined> {
    if (execution.handler !== "agent" || execution.status !== "running") {
      throw new Error(`AgentHandler cannot process Execution: ${execution.executionId}`);
    }
    const event = this.#store.event(execution.eventId);
    if (event === undefined) throw new Error(`Event not found: ${execution.eventId}`);
    if (!isAgentInputEvent(event)) {
      throw new Error(`AgentHandler requires an Agent input Event: ${event.eventId}`);
    }
    try {
      const sessionId = event.sessionId ??
        (event.type === "chat.dispatch"
          ? this.#store.currentLocalAgentSession(event.agentId)?.sessionId
          : undefined);
      const session = sessionId === undefined ? undefined : this.#session(sessionId);
      const adapter = this.#adapterForAgent(event.agentId, session?.workspace);
      if (adapter === undefined) throw new Error(`Agent adapter not available: ${event.agentId}`);
      if (session !== undefined && (session.agentId !== event.agentId ||
        session.adapterId !== adapter.adapterId || session.workspace !== adapter.workspace)) {
        throw new Error(
          `Session does not belong to Agent adapter: ${session.sessionId}; ` +
          `agent=${session.agentId === event.agentId ? "match" : "mismatch"}, ` +
          `adapter=${session.adapterId === adapter.adapterId ? "match" : "mismatch"}, ` +
          `workspace=${session.workspace === adapter.workspace ? "match" : "mismatch"}`
        );
      }
      const receipt = await adapter.invoke({
        event,
        ...(session === undefined ? {} : { providerSessionId: session.providerSessionId })
      });
      return this.#store.completeExecution(execution.executionId, {
        adapterId: adapter.adapterId,
        workspace: adapter.workspace,
        providerSessionId: receipt.providerSessionId,
        ...(session === undefined ? {} : { sessionId: session.sessionId }),
        ...(receipt.outcome.kind === "message" ? { output: receipt.outcome.body } : {})
      }, at);
    } catch (error) {
      return this.#store.failExecution(
        execution.executionId,
        message(error),
        at,
        this.#retryBaseMilliseconds
      ).resultEvent;
    }
  }

  #session(sessionId: string): RuntimeSession {
    const session = this.#store.session(sessionId);
    if (session === undefined) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}

export class ResultHandler {
  public readonly kind = "result" as const;
  readonly #store: RuntimeStore;

  public constructor(store: RuntimeStore) {
    this.#store = store;
  }

  public handle(
    execution: RuntimeExecution,
    at = new Date().toISOString()
  ): readonly RuntimeDelivery[] {
    if (execution.handler !== "result" || execution.status !== "running") {
      throw new Error(`ResultHandler cannot process Execution: ${execution.executionId}`);
    }
    const event = this.#store.event(execution.eventId);
    if (event === undefined || !isAgentResultEvent(event)) {
      throw new Error(`ResultHandler requires agent.result: ${execution.eventId}`);
    }
    return this.#store.completeResultExecution(execution.executionId, at);
  }
}

export interface RuntimeEventHandler {
  readonly kind: RuntimeHandlerKind;
  handle(execution: RuntimeExecution, at?: string): unknown;
}

export interface RuntimeDestinationAdapter {
  readonly kind: RuntimeDestination["kind"];
  deliver(input: {
    readonly delivery: RuntimeDelivery;
    readonly destination: RuntimeDestination;
    readonly resultEvent: AgentResultEvent;
    readonly requestEvent: Event;
  }): Promise<{ readonly receipt: string }>;
}

export class DeliveryHandler {
  readonly #adapters: ReadonlyMap<RuntimeDestination["kind"], RuntimeDestinationAdapter>;
  readonly #retryBaseMilliseconds: number;
  readonly #store: RuntimeStore;

  public constructor(options: {
    readonly store: RuntimeStore;
    readonly adapters: ReadonlyMap<RuntimeDestination["kind"], RuntimeDestinationAdapter>;
    readonly retryBaseMilliseconds?: number;
  }) {
    this.#store = options.store;
    this.#adapters = options.adapters;
    this.#retryBaseMilliseconds = options.retryBaseMilliseconds ?? 1_000;
  }

  public async handle(
    delivery: RuntimeDelivery,
    at = new Date().toISOString()
  ): Promise<RuntimeDelivery> {
    if (delivery.status !== "delivering") {
      throw new Error(`DeliveryHandler cannot process Delivery: ${delivery.deliveryId}`);
    }
    try {
      const destination = this.#store.destination(delivery.destinationId);
      if (destination === undefined) {
        throw new Error(`Destination not found: ${delivery.destinationId}`);
      }
      const resultEvent = this.#store.event(delivery.resultEventId);
      if (resultEvent === undefined || !isAgentResultEvent(resultEvent)) {
        throw new Error(`Result Event not found: ${delivery.resultEventId}`);
      }
      const parentEventId = resultEvent.causality.parentEventId;
      if (parentEventId === undefined) {
        throw new Error(`Result Event has no parent: ${resultEvent.eventId}`);
      }
      const requestEvent = this.#store.event(parentEventId);
      if (requestEvent === undefined) throw new Error(`Request Event not found: ${parentEventId}`);
      const adapter = this.#adapters.get(destination.kind);
      if (adapter === undefined) {
        throw new Error(`Destination adapter not available: ${destination.kind}`);
      }
      const receipt = await adapter.deliver({ delivery, destination, resultEvent, requestEvent });
      return this.#store.deliverySucceeded(delivery.deliveryId, receipt.receipt, at);
    } catch (error) {
      return this.#store.deliveryFailed(
        delivery.deliveryId,
        message(error),
        at,
        this.#retryBaseMilliseconds
      );
    }
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}
