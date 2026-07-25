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
  readonly reviewCapabilities?: {
    readonly resultSchemas: readonly ("ReviewerResult@1" | "ImplementerResult@1")[];
    readonly workspaceAccess: readonly ("read" | "write")[];
  };
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

export interface RuntimeReviewContinuation {
  handleAgentResult(
    execution: RuntimeExecution,
    result: AgentResultEvent,
    request: import("../event/model.js").AgentRequestEvent,
    at: string
  ): boolean;
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

  public constructor(options: {
    readonly store: RuntimeStore;
    readonly adapters?: ReadonlyMap<string, RuntimeAgentAdapter>;
    readonly adapterForAgent?: (
      agentId: string,
      workspace?: string
    ) => RuntimeAgentAdapter | undefined;
    readonly chatHistory?: (input: ChatHistoryPageInput) => ChatPromptHistory;
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
      const reviewWorkspace = event.type === "agent.request"
        ? event.reviewInvocation?.evidence.find(
            (evidence) => evidence.kind === "workspace"
          )?.ref
        : undefined;
      const adapter = this.#adapterForAgent(
        event.agentId,
        reviewWorkspace ?? session?.workspace
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
      const chatDecision = event.type === "chat.dispatch"
        ? receipt.outcome.kind === "message"
          ? event.promptResourceId === chatMentionPromptResourceId
            ? parseChatMentionDecision(receipt.outcome.body)
            : parseChatDecision(receipt.outcome.body, at)
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
  readonly #review: RuntimeReviewContinuation | undefined;

  public constructor(
    store: RuntimeStore,
    review?: RuntimeReviewContinuation
  ) {
    this.#store = store;
    this.#review = review;
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
      if (request?.type === "agent.request" && request.reviewInvocation !== undefined &&
        this.#review?.handleAgentResult(execution, event, request, at) === true) {
        return [];
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
