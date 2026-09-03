import {
  parseChatProfileContext,
  type ChatProfileContext
} from "../../core/chat/model.js";
import {
  planChatActivation,
  planChatAttention
} from "../../core/chat/state-machine.js";
import type { RuntimeEventHandler } from "../../core/runtime/handlers.js";
import type { RuntimeExecution } from "../../core/runtime/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import type {
  ChatActivationEvent,
  ChatDispatchEvent,
  ChatMessageEvent
} from "../../core/event/model.js";
import type { LocalChatStore } from "../../infrastructure/sqlite/chat-store.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import type { AgentClient } from "../../modules/agent/client-profile.js";
import {
  loadChatMentionPromptResource,
  loadChatPromptResource,
  type ChatPromptResource
} from "./prompt.js";
import {
  boundedChatPromptHistory,
  chatTimelineFromStore,
  incrementalChatPromptHistory
} from "./query.js";
import { chatReadToolCapability } from "./read-tool-policy.js";

export class ChatHandler implements RuntimeEventHandler {
  public readonly kind = "chat" as const;
  readonly #listAgents: (topicId: string) => readonly LocalAgent[];
  readonly #freeTurnPrompt: ChatPromptResource;
  readonly #mentionedTurnPrompt: ChatPromptResource;
  readonly #chat: Pick<LocalChatStore, "messagePage">;
  readonly #admissionPolicy: ChatAttentionAdmissionPolicy | undefined;
  readonly #store: RuntimeStore;
  readonly #resolveProfileContext: (
    agentId: string,
    topicId: string
  ) => { readonly kind: "local" } | { readonly kind: "public"; readonly context?: unknown };
  readonly #resolveClientHistory: (
    agentId: string
  ) => import("./prompt.js").ChatPromptContext["clientHistory"];
  readonly #reportClientHistoryFailure: (agentId: string, error: unknown) => void;

  public constructor(options: {
    readonly store: RuntimeStore;
    readonly chat: Pick<LocalChatStore, "messagePage">;
    readonly listAgents: (topicId: string) => readonly LocalAgent[];
    readonly admissionPolicy?: ChatAttentionAdmissionPolicy;
    readonly prompt?: ChatPromptResource;
    readonly mentionPrompt?: ChatPromptResource;
    readonly resolveProfileContext?: (
      agentId: string,
      topicId: string
    ) => { readonly kind: "local" } | { readonly kind: "public"; readonly context?: unknown };
    readonly resolveClientHistory?: (
      agentId: string
    ) => import("./prompt.js").ChatPromptContext["clientHistory"];
    readonly reportClientHistoryFailure?: (agentId: string, error: unknown) => void;
  }) {
    this.#store = options.store;
    this.#chat = options.chat;
    this.#listAgents = options.listAgents;
    this.#admissionPolicy = options.admissionPolicy;
    this.#freeTurnPrompt = options.prompt ?? loadChatPromptResource();
    this.#mentionedTurnPrompt = options.mentionPrompt ?? loadChatMentionPromptResource();
    this.#resolveProfileContext = options.resolveProfileContext ?? (() => ({ kind: "local" }));
    this.#resolveClientHistory = options.resolveClientHistory ?? (() => undefined);
    this.#reportClientHistoryFailure = options.reportClientHistoryFailure ?? (() => {});
  }

  public handle(
    execution: RuntimeExecution,
    at = new Date().toISOString()
  ): readonly string[] {
    if (execution.handler !== "chat" || execution.status !== "running") {
      throw new Error(`ChatHandler cannot process Execution: ${execution.executionId}`);
    }
    const event = this.#store.event(execution.eventId);
    if (event?.type !== "chat.message" && event?.type !== "chat.activation") {
      throw new Error(`ChatHandler requires chat attention source: ${execution.eventId}`);
    }
    const history = boundedChatPromptHistory(chatTimelineFromStore(
      this.#chat,
      event.topicId,
      event.type === "chat.message"
        ? { beforeEventId: event.eventId, limit: 10_000 }
        : { limit: 10_000 }
    ));
    const agents = this.#listAgents(event.topicId);
    const agentsById = new Map(agents.map((agent) => [agent.principalId, agent]));
    const admission = this.#admissionPolicy?.admitAttention(event, agents);
    const candidates = (admission?.candidates ?? agents)
      .map((agent) => {
        const presence = this.#store.chatPresence(agent.principalId, event.topicId);
        return {
          agentId: agent.principalId,
          handle: agent.handle,
          status: agent.status,
          ...(presence.global === undefined
            ? {}
            : { globalPresence: presence.global }),
          ...(presence.topic === undefined
            ? {}
            : { topicPresence: presence.topic })
        };
      });
    const root = this.#store.event(event.causality.rootEventId);
    const sequentialRoot = root?.type === "chat.activation" &&
      root.sequentialDispatch === true
      ? root
      : undefined;
    const sequentialCandidateId = sequentialRoot === undefined
      ? undefined
      : sequentialRoot.candidateAgentIds.find((agentId) =>
          !this.#store.eventsForRoot(sequentialRoot.eventId).some(
            (member) => member.type === "chat.dispatch" && member.agentId === agentId
          ));
    const eligibleCandidates = sequentialRoot === undefined
      ? candidates
      : sequentialCandidateId === undefined
        ? []
        : candidates.filter(({ agentId }) => agentId === sequentialCandidateId);
    const plans = event.type === "chat.message"
      ? planChatAttention({ message: event, candidates: eligibleCandidates, now: at })
      : planChatActivation({ activation: event, candidates: eligibleCandidates, now: at });
    const conversationIntent = root?.type === "chat.activation"
      ? root.conversationIntent
      : event.type === "chat.activation"
        ? event.conversationIntent
        : {
            schema: "ConversationIntentSnapshot@1" as const,
            mode: "continue_recent" as const,
            governanceRevision: admission?.snapshotFor(
              eligibleCandidates[0]?.agentId ?? candidates[0]?.agentId ?? ""
            )?.revision ?? 1
          };
    return this.#store.admitChatAttention(
      execution.executionId,
      plans.map((plan) => plan.outcome === "skip"
        ? { plan }
        : (() => {
            const prompt = plan.reason === "direct-mention"
              ? this.#mentionedTurnPrompt
              : this.#freeTurnPrompt;
            const resolution = this.#resolveProfileContext(plan.agentId, event.topicId);
            const profileContext: ChatProfileContext | undefined = resolution.kind === "local"
              ? undefined
              : parseChatProfileContext(
                  resolution.context,
                  plan.agentId,
                  event.topicId,
                  at
                );
            const clientHistory = this.#clientHistory(plan.agentId);
            const client = agentsById.get(plan.agentId)?.client;
            const admissionSnapshot = admission?.snapshotFor(plan.agentId);
            const currentSession = this.#store.currentLocalAgentSession(plan.agentId);
            const previousDispatch = currentSession === undefined
              ? undefined
              : this.#store.latestChatDispatch(event.topicId, plan.agentId);
            const previousDispatchSucceeded = previousDispatch !== undefined &&
              this.#store.executionForEvent(previousDispatch.eventId)?.status === "succeeded";
            const promptHistory = !previousDispatchSucceeded
              ? history
              : incrementalChatPromptHistory(history, {
                  ...(previousDispatch.sourceMessageEventId === undefined
                    ? {}
                    : { sourceMessageEventId: previousDispatch.sourceMessageEventId }),
                  dispatchCreatedAt: previousDispatch.createdAt,
                  agentId: plan.agentId
                });
            return {
            plan,
            promptResourceId: prompt.resourceId,
            ...(admissionSnapshot === undefined ? {} : { admissionSnapshot }),
            ...(profileContext === undefined ? {} : { profileContext }),
            prompt: prompt.render({
              agent: { agentId: plan.agentId, handle: plan.handle },
              topicId: event.topicId,
              attentionReason: plan.reason,
              currentPresence: plan.presenceSnapshot,
              turnMode: event.type === "chat.message"
                ? "reply_to_message"
                : "proactive_contribution",
              ...(event.type === "chat.message"
                ? { latestMessage: event }
                : {}),
              conversationIntent,
              history: promptHistory,
              readTools: chatReadToolCapability(client === "kimi-code" ? "request" : "tools"),
              ...(event.type === "chat.message"
                ? {
                    chatHistory: chatHistoryCapability(client)
                  }
                : {}),
              now: at,
              ...(clientHistory === undefined ? {} : { clientHistory }),
              ...(profileContext === undefined ? {} : { profileContext })
            })
            };
          })()),
      at
    ).map((dispatch) => dispatch.eventId);
  }

  #clientHistory(
    agentId: string
  ): import("./prompt.js").ChatPromptContext["clientHistory"] {
    try {
      return this.#resolveClientHistory(agentId);
    } catch (error) {
      this.#reportClientHistoryFailure(agentId, error);
      return undefined;
    }
  }
}

function chatHistoryCapability(
  client: AgentClient | undefined
): NonNullable<import("./prompt.js").ChatPromptContext["chatHistory"]> {
  return client === "kimi-code"
    ? { schema: "ChatHistoryRequestCapability@1" }
    : {
        schema: "ChatHistoryToolsCapability@1",
        tools: ["read_chat_history"]
      };
}

export interface ChatAttentionAdmissionPolicy {
  admitAttention(
    source: ChatActivationEvent | ChatMessageEvent,
    candidates: readonly LocalAgent[]
  ): {
    readonly candidates: readonly LocalAgent[];
    readonly snapshotFor: (
      agentId: string
    ) => ChatDispatchEvent["admissionSnapshot"] | undefined;
  };
}
