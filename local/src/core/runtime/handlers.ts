import {
  isAgentInputEvent,
  isAgentResultEvent,
  type AgentInputEvent,
  type AgentResultEvent,
  type Event,
  type ChatDispatchEvent,
  type ChatMessageEvent
} from "../event/model.js";
import {
  availableChatDecision,
  chatMentionPromptResourceId,
  parseChatHistoryRequest,
  parseChatDecision,
  parseChatMentionDecision,
  silentChatMentionDecision,
  type ChatPromptHistory
} from "../chat/model.js";
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

export interface RuntimeAgentResultContinuation {
  readonly resultContractId: string;
  handleAgentResult(
    execution: RuntimeExecution,
    result: AgentResultEvent,
    request: import("../event/model.js").AgentRequestEvent,
    at: string
  ): boolean;
}

export interface RuntimeAgentExecutionGuard {
  readonly moduleId: string;
  canInvoke(event: import("../event/model.js").AgentRequestEvent): boolean;
}

export interface ChatHistoryPageInput {
  readonly topicId: string;
  readonly beforeEventId: string;
  readonly limit: number;
}

export class AgentHandler {
  public readonly kind = "agent" as const;
  readonly #adapterForAgent: (
    agentId: string,
    workspace?: string
  ) => RuntimeAgentAdapter | undefined;
  readonly #store: RuntimeStore;
  readonly #retryBaseMilliseconds: number;
  readonly #chatHistory: ((input: ChatHistoryPageInput) => ChatPromptHistory) | undefined;
  readonly #executionGuards: readonly RuntimeAgentExecutionGuard[];

  public constructor(options: {
    readonly store: RuntimeStore;
    readonly adapters?: ReadonlyMap<string, RuntimeAgentAdapter>;
    readonly adapterForAgent?: (
      agentId: string,
      workspace?: string
    ) => RuntimeAgentAdapter | undefined;
    readonly chatHistory?: (input: ChatHistoryPageInput) => ChatPromptHistory;
    readonly executionGuards?: readonly RuntimeAgentExecutionGuard[];
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
    this.#chatHistory = options.chatHistory;
    this.#executionGuards = options.executionGuards ?? [];
    this.#retryBaseMilliseconds = options.retryBaseMilliseconds ?? 1_000;
  }

  public async handle(
    execution: RuntimeExecution,
    at?: string
  ): Promise<AgentResultEvent | ChatMessageEvent | undefined> {
    if (execution.handler !== "agent" || execution.status !== "running") {
      throw new Error(`AgentHandler cannot process Execution: ${execution.executionId}`);
    }
    const event = this.#store.event(execution.eventId);
    if (event === undefined) throw new Error(`Event not found: ${execution.eventId}`);
    if (!isAgentInputEvent(event)) {
      throw new Error(`AgentHandler requires an Agent input Event: ${event.eventId}`);
    }
    if (event.type === "agent.request" && !this.#canInvoke(event)) {
      return this.#store.forceTerminalAgentFailure(
        execution.executionId,
        "agent_run_cancelled",
        at ?? new Date().toISOString()
      ).resultEvent;
    }
    try {
      const sessionId = event.sessionId ??
        (event.type === "chat.dispatch"
          ? this.#store.currentLocalAgentSession(event.agentId)?.sessionId
          : undefined);
      const session = sessionId === undefined ? undefined : this.#session(sessionId);
      const controlledWorkspace = event.type === "agent.request"
        ? event.runContext?.workspaceGrant?.root
        : undefined;
      const adapter = this.#adapterForAgent(
        event.agentId,
        controlledWorkspace ?? session?.workspace
      );
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
      let receipt = await adapter.invoke({
        event,
        ...(session === undefined ? {} : { providerSessionId: session.providerSessionId })
      });
      if (event.type === "chat.dispatch") {
        receipt = await this.#continueChatHistory(
          adapter,
          event,
          receipt
        );
      }
      const completedAt = at ?? new Date().toISOString();
      const chatDecision = event.type === "chat.dispatch"
        ? receipt.outcome.kind === "message"
          ? event.promptResourceId === chatMentionPromptResourceId
            ? parseChatMentionDecision(receipt.outcome.body)
            : parseChatDecision(receipt.outcome.body, completedAt)
          : event.promptResourceId === chatMentionPromptResourceId
            ? silentChatMentionDecision()
            : availableChatDecision()
        : undefined;
      return this.#store.completeExecution(execution.executionId, {
        adapterId: adapter.adapterId,
        workspace: adapter.workspace,
        providerSessionId: receipt.providerSessionId,
        ...(session === undefined ? {} : { sessionId: session.sessionId }),
        ...(event.type !== "chat.dispatch" && receipt.outcome.kind === "message"
          ? { output: receipt.outcome.body }
          : {}),
        ...(chatDecision === undefined ? {} : { chatDecision })
      }, completedAt);
    } catch (error) {
      if (event.type === "agent.request" && !this.#canInvoke(event)) {
        return this.#store.forceTerminalAgentFailure(
          execution.executionId,
          "agent_run_cancelled",
          at ?? new Date().toISOString()
        ).resultEvent;
      }
      return this.#store.failExecution(
        execution.executionId,
        message(error),
        at ?? new Date().toISOString(),
        this.#retryBaseMilliseconds
      ).resultEvent;
    }
  }

  #canInvoke(event: import("../event/model.js").AgentRequestEvent): boolean {
    return this.#executionGuards.every((guard) => guard.canInvoke(event));
  }

  #session(sessionId: string): RuntimeSession {
    const session = this.#store.session(sessionId);
    if (session === undefined) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  async #continueChatHistory(
    adapter: RuntimeAgentAdapter,
    event: ChatDispatchEvent,
    initialReceipt: Awaited<ReturnType<RuntimeAgentAdapter["invoke"]>>
  ): Promise<Awaited<ReturnType<RuntimeAgentAdapter["invoke"]>>> {
    let receipt = initialReceipt;
    if (receipt.outcome.kind !== "message") return receipt;
    let request = parseChatHistoryRequest(receipt.outcome.body);
    if (request === undefined) return receipt;
    if (this.#chatHistory === undefined) {
      throw new Error("Chat history recall is not available");
    }

    const initialHistory = this.#chatHistory({
      topicId: event.topicId,
      beforeEventId: event.sourceMessageEventId,
      limit: 50
    });
    let expectedCursor = initialHistory.hasEarlier
      ? initialHistory.beforeEventId
      : undefined;
    let recalledMessages = 0;
    let recalledBytes = 0;
    let pages = 0;
    while (request !== undefined) {
      if (pages >= 3) throw new Error("Chat history recall exceeds three pages");
      if (expectedCursor === undefined || request.beforeEventId !== expectedCursor) {
        throw new Error("Chat history recall cursor does not match the previous page");
      }
      const page = this.#chatHistory({
        topicId: event.topicId,
        beforeEventId: request.beforeEventId,
        limit: request.limit
      });
      if (page.items.length === 0) {
        throw new Error("Chat history recall returned an empty page");
      }
      const pageJson = JSON.stringify(page);
      recalledMessages += page.items.length;
      recalledBytes += Buffer.byteLength(pageJson, "utf8");
      if (recalledMessages > 200 || recalledBytes > 65_536) {
        throw new Error("Chat history recall exceeds the bounded context budget");
      }
      if (page.hasEarlier &&
        (page.beforeEventId === undefined || page.beforeEventId === request.beforeEventId)) {
        throw new Error("Chat history recall cursor did not advance");
      }
      pages += 1;
      expectedCursor = page.hasEarlier ? page.beforeEventId : undefined;
      receipt = await adapter.invoke({
        event: {
          ...event,
          prompt: [
            "The Runtime accepted your ChatHistoryRequest@1.",
            "Here is the bounded earlier history page:",
            JSON.stringify(page, null, 2),
            "Return the original Chat decision schema now. Request another page only when",
            "`hasEarlier` is true, using exactly this page's `beforeEventId`."
          ].join("\n")
        },
        providerSessionId: receipt.providerSessionId
      });
      request = receipt.outcome.kind === "message"
        ? parseChatHistoryRequest(receipt.outcome.body)
        : undefined;
    }
    return receipt;
  }
}

export class ResultHandler {
  public readonly kind = "result" as const;
  readonly #store: RuntimeStore;
  readonly #continuations = new Map<string, RuntimeAgentResultContinuation>();

  public constructor(
    store: RuntimeStore,
    continuations: readonly RuntimeAgentResultContinuation[] = []
  ) {
    this.#store = store;
    for (const continuation of continuations) {
      if (this.#continuations.has(continuation.resultContractId)) {
        throw new Error(
          `Duplicate result continuation contract: ${continuation.resultContractId}`
        );
      }
      this.#continuations.set(continuation.resultContractId, continuation);
    }
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
    const parentEventId = event.causality.parentEventId;
    if (parentEventId !== undefined) {
      const request = this.#store.event(parentEventId);
      if (request?.type === "agent.request" && request.runContext !== undefined) {
        const contractId = request.runContext.resultContractId;
        const continuation = this.#continuations.get(contractId);
        if (continuation === undefined) {
          throw new Error(`Result continuation is not registered: ${contractId}`);
        }
        if (continuation.handleAgentResult(execution, event, request, at)) {
          return [];
        }
        throw new Error(`Result continuation declined registered contract: ${contractId}`);
      }
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
    at?: string
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
      return this.#store.deliverySucceeded(
        delivery.deliveryId,
        receipt.receipt,
        at ?? new Date().toISOString()
      );
    } catch (error) {
      return this.#store.deliveryFailed(
        delivery.deliveryId,
        message(error),
        at ?? new Date().toISOString(),
        this.#retryBaseMilliseconds
      );
    }
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}
