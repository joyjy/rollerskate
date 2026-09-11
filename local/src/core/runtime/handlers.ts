import { type ExecutionResources } from "./scheduling.js";
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
  parseChatDecision,
  parseChatMentionDecision,
  silentChatMentionDecision
} from "../chat/model.js";
import type {
  RuntimeExecution,
  RuntimeDelivery,
  RuntimeDestination,
  RuntimeHandlerKind,
  RuntimeSession
} from "./model.js";
import { RuntimeStore } from "./store.js";
import type {
  AgentAdapterInput,
  AgentAdapterInvocation,
  ProviderPolicyObservationSnapshot
} from "./agent-invocation.js";
import { AgentInvocationError, assertProviderSessionIdentity } from "./agent-invocation.js";
import type { ChatReplyRoute } from "./store/types.js";

export interface RuntimeAgentAdapter {
  readonly adapterId: string;
  readonly workspace: string;
  readonly providerPolicy?: ProviderPolicyObservationSnapshot;
  invoke(input: AgentAdapterInput): Promise<AgentAdapterInvocation>;
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
  canInvoke(
    event: AgentInputEvent | ChatDispatchEvent,
    at: string
  ): RuntimeAgentExecutionGuardDecision;
}

export type RuntimeAgentExecutionGuardDecision =
  | { readonly outcome: "allow" }
  | { readonly outcome: "skip"; readonly reason: string };

export class AgentHandler {
  public readonly kind = "agent" as const;
  readonly #adapterForAgent: (
    agentId: string,
    workspace?: string
  ) => RuntimeAgentAdapter | undefined;
  readonly #store: RuntimeStore;
  readonly #retryBaseMilliseconds: number;
  readonly #executionGuards: readonly RuntimeAgentExecutionGuard[];
  readonly #invocationLanes = new Map<string, Promise<void>>();
  readonly #resolveChatReplyRoute: ((event: ChatDispatchEvent) => ChatReplyRoute | undefined) |
    undefined;

  public constructor(options: {
    readonly store: RuntimeStore;
    readonly adapters?: ReadonlyMap<string, RuntimeAgentAdapter>;
    readonly adapterForAgent?: (
      agentId: string,
      workspace?: string
    ) => RuntimeAgentAdapter | undefined;
    readonly executionGuards?: readonly RuntimeAgentExecutionGuard[];
    readonly resolveChatReplyRoute?: (event: ChatDispatchEvent) => ChatReplyRoute | undefined;
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
    this.#executionGuards = options.executionGuards ?? [];
    this.#resolveChatReplyRoute = options.resolveChatReplyRoute;
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
    // Legacy queued retries must not replay a Chat turn that may have used tools.
    if (event.type === "chat.dispatch" && execution.attemptCount > 1) {
      this.#store.cancelRunningAgentExecution(execution.executionId,"chat_retry_requires_new_instruction",at ?? new Date().toISOString());
      return undefined;
    }
    const invocationAt = at ?? new Date().toISOString();
    let invocationAdapter: RuntimeAgentAdapter | undefined;
    const blocked = this.#blocked(event, invocationAt);
    if (blocked !== undefined) {
      const completedAt = invocationAt;
      if (event.type === "agent.request") {
        return this.#store.forceTerminalAgentFailure(
          execution.executionId,
          blocked,
          completedAt
        ).resultEvent;
      }
      this.#store.cancelRunningAgentExecution(
        execution.executionId,
        blocked,
        completedAt
      );
      return undefined;
    }
    try {
      const { session, adapter } = this.#invocationTarget(event);
      invocationAdapter = adapter;
      const workspaceAccess = invocationWorkspaceAccess(event);
      if (session !== undefined && (session.agentId !== event.agentId ||
        session.adapterId !== adapter.adapterId || session.workspace !== adapter.workspace)) {
        throw new Error(
          `Session does not belong to Agent adapter: ${session.sessionId}; ` +
          `agent=${session.agentId === event.agentId ? "match" : "mismatch"}, ` +
          `adapter=${session.adapterId === adapter.adapterId ? "match" : "mismatch"}, ` +
          `workspace=${session.workspace === adapter.workspace ? "match" : "mismatch"}`
        );
      }
      const receipt = await this.#invokeInLane(
        this.resources(event).lanes[0]!,
        () => {
          const blocked = this.#blocked(event, at ?? new Date().toISOString());
          if (blocked !== undefined) throw new Error(blocked);
          return adapter.invoke({
            event,
            ...(session === undefined ? {} : { providerSessionId: session.providerSessionId }),
            reportProgress: (progress) => this.#store.recordAgentInvocationProgress(
              execution.executionId,
              assertInvocationIdentity(progress, adapter, workspaceAccess)
            )
          });
        }
      );
      assertProviderSessionIdentity(session?.providerSessionId, receipt.providerSessionId);
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
      const chatReplyRoute = event.type === "chat.dispatch"
        ? this.#resolveChatReplyRoute?.(event)
        : undefined;
      return this.#store.completeExecution(execution.executionId, {
        adapterId: adapter.adapterId,
        workspace: adapter.workspace,
        providerSessionId: receipt.providerSessionId,
        ...(session === undefined ? {} : { sessionId: session.sessionId }),
        ...(event.type !== "chat.dispatch" && receipt.outcome.kind === "message"
          ? { output: receipt.outcome.body }
          : {}),
        ...(receipt.invocation === undefined ? {} : { invocation: receipt.invocation }),
        ...(chatDecision === undefined ? {} : { chatDecision }),
        ...(chatReplyRoute === undefined ? {} : { chatReplyRoute })
      }, completedAt);
    } catch (error) {
      const retryBlocked = this.#blocked(event, at ?? new Date().toISOString());
      if (event.type === "agent.request" && retryBlocked !== undefined) {
        return this.#store.forceTerminalAgentFailure(
          execution.executionId,
          retryBlocked,
          at ?? new Date().toISOString()
        ).resultEvent;
      }
      if (error instanceof AgentInvocationError) {
        if (invocationAdapter === undefined ||
          error.failure.adapterId !== invocationAdapter.adapterId ||
          error.failure.workspace !== invocationAdapter.workspace ||
          !validFailureRecovery(error.failure, invocationWorkspaceAccess(event))) {
          return this.#store.failExecution(
            execution.executionId,
            "Agent invocation failure identity does not match the selected adapter",
            at ?? new Date().toISOString(),
            this.#retryBaseMilliseconds,
            {retry:event.type === "chat.dispatch" ? "never" : "default"}
          ).resultEvent;
        }
        return this.#store.failExecution(
          execution.executionId,
          error.message,
          at ?? new Date().toISOString(),
          this.#retryBaseMilliseconds,
          {
            trace: error.failure,
            retry: event.type === "agent.request" || event.type === "chat.dispatch" ||
              error.failure.recovery === "unknown_outcome_no_replay"
              ? "never"
              : "default"
          }
        ).resultEvent;
      }
      return this.#store.failExecution(
        execution.executionId,
        message(error),
        at ?? new Date().toISOString(),
        this.#retryBaseMilliseconds,
        {retry:event.type === "chat.dispatch" ? "never" : "default"}
      ).resultEvent;
    }
  }

  public resources(event: Event): ExecutionResources {
    if (!isAgentInputEvent(event)) throw new Error("Agent scheduling requires Agent input");
    const sessionId = event.sessionId ?? (event.type === "chat.dispatch"
      ? this.#store.currentLocalAgentSession(event.agentId)?.sessionId : undefined);
    const session = sessionId === undefined ? undefined : this.#store.session(sessionId);
    const grant = event.type === "agent.request" ? event.runContext?.workspaceGrant
      : event.type === "subscription.fire" ? event.invocation?.workspaceGrant : undefined;
    // Durable grants/sessions remain authoritative even when the adapter is suspended.
    const workspace = grant?.root ?? session?.workspace ?? this.#adapterForAgent(event.agentId)?.workspace;
    const context = event.type === "agent.request" ? event.runContext : undefined;
    const sessionLane = sessionId === undefined ? undefined : `session:${sessionId}`;
    const lane = event.type === "chat.dispatch" ? `chat-agent:${event.agentId}`
      : sessionLane ?? (context === undefined ? `request:${event.eventId}`
        : `run:${context.runId}:cycle:${context.cycleId ?? "none"}:agent:${event.agentId}`);
    return { agentId: event.agentId, lanes: [...new Set([lane, ...(sessionLane ? [sessionLane] : [])])],
      ...(workspace === undefined ? {} : { workspace: { root: workspace, access: invocationWorkspaceAccess(event) } }) };
  }

  #invocationTarget(event: AgentInputEvent | ChatDispatchEvent) {
    const sessionId = event.sessionId ?? (event.type === "chat.dispatch"
      ? this.#store.currentLocalAgentSession(event.agentId)?.sessionId : undefined);
    const session = sessionId === undefined ? undefined : this.#session(sessionId);
    const workspace = event.type === "agent.request" ? event.runContext?.workspaceGrant?.root
      : event.type === "subscription.fire" ? event.invocation?.workspaceGrant.root : undefined;
    const adapter = this.#adapterForAgent(event.agentId, workspace ?? session?.workspace);
    if (adapter === undefined) throw new Error(`Agent adapter not available: ${event.agentId}`);
    return { session, adapter };
  }

  #blocked(
    event: AgentInputEvent | ChatDispatchEvent,
    at: string
  ): string | undefined {
    for (const guard of this.#executionGuards) {
      const decision = guard.canInvoke(event, at);
      if (decision.outcome === "skip") return decision.reason;
    }
    return undefined;
  }

  #session(sessionId: string): RuntimeSession {
    const session = this.#store.session(sessionId);
    if (session === undefined) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  async #invokeInLane<T>(lane: string, invoke: () => Promise<T>): Promise<T> {
    const previous = this.#invocationLanes.get(lane) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#invocationLanes.set(lane, current);
    await previous;
    try {
      return await invoke();
    } finally {
      release();
      if (this.#invocationLanes.get(lane) === current) {
        this.#invocationLanes.delete(lane);
      }
    }
  }

}

function assertInvocationIdentity<T extends {
  readonly adapterId: string;
  readonly workspace: string;
  readonly workspaceAccess: "read" | "write";
}>(
  progress: T,
  adapter: RuntimeAgentAdapter,
  workspaceAccess: "read" | "write"
): T {
  if (progress.adapterId !== adapter.adapterId || progress.workspace !== adapter.workspace ||
    progress.workspaceAccess !== workspaceAccess) {
    throw new Error("Agent invocation progress identity does not match the selected adapter");
  }
  return progress;
}

function invocationWorkspaceAccess(
  event: AgentInputEvent | ChatDispatchEvent
): "read" | "write" {
  if (event.type === "agent.request") {
    return event.runContext?.workspaceGrant?.access ?? "read";
  }
  if (event.type === "subscription.fire") return event.invocation?.workspaceGrant.access ?? "read";
  return "read";
}

function validFailureRecovery(
  failure: AgentInvocationError["failure"],
  workspaceAccess: "read" | "write"
): boolean {
  if (failure.workspaceAccess !== workspaceAccess) return false;
  if (workspaceAccess === "write") return failure.recovery === "unknown_outcome_no_replay";
  return failure.recovery === (failure.providerSessionId === undefined
    ? "none"
    : "explicit_read_only_resume");
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
  resources?(event: Event): ExecutionResources;
  handle(execution: RuntimeExecution, at?: string): unknown;
}

export interface RuntimeDestinationAdapter {
  readonly kind: RuntimeDestination["kind"];
  deliver(input: {
    readonly delivery: RuntimeDelivery;
    readonly destination: RuntimeDestination;
    readonly resultEvent?: AgentResultEvent;
    readonly requestEvent?: Event;
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
      const adapter = this.#adapters.get(destination.kind);
      if (adapter === undefined) {
        throw new Error(`Destination adapter not available: ${destination.kind}`);
      }
      if (delivery.origin.kind === "host") {
        const receipt = await adapter.deliver({ delivery, destination });
        return this.#store.deliverySucceeded(
          delivery.deliveryId,
          receipt.receipt,
          at ?? new Date().toISOString()
        );
      }
      const resultEvent = delivery.resultEventId === undefined
        ? undefined
        : this.#store.event(delivery.resultEventId);
      if (resultEvent === undefined || !isAgentResultEvent(resultEvent)) {
        throw new Error(`Result Event not found: ${delivery.resultEventId ?? "missing"}`);
      }
      const parentEventId = resultEvent.causality.parentEventId;
      if (parentEventId === undefined) {
        throw new Error(`Result Event has no parent: ${resultEvent.eventId}`);
      }
      const requestEvent = this.#store.event(parentEventId);
      if (requestEvent === undefined) throw new Error(`Request Event not found: ${parentEventId}`);
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
