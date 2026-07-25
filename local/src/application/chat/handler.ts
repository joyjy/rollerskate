import {
  planChatAttention
} from "../../core/chat/state-machine.js";
import type { RuntimeEventHandler } from "../../core/runtime/handlers.js";
import type { RuntimeExecution } from "../../core/runtime/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import type { LocalChatStore } from "../../infrastructure/sqlite/chat-store.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import {
  loadChatMentionPromptResource,
  loadChatPromptResource,
  type ChatPromptResource
} from "./prompt.js";
import {
  boundedChatPromptHistory,
  chatTimelineFromStore
} from "./query.js";

export class ChatHandler implements RuntimeEventHandler {
  public readonly kind = "chat" as const;
  readonly #listAgents: () => readonly LocalAgent[];
  readonly #freeTurnPrompt: ChatPromptResource;
  readonly #mentionedTurnPrompt: ChatPromptResource;
  readonly #chat: Pick<LocalChatStore, "messagePage">;
  readonly #store: RuntimeStore;

  public constructor(options: {
    readonly store: RuntimeStore;
    readonly chat: Pick<LocalChatStore, "messagePage">;
    readonly listAgents: () => readonly LocalAgent[];
    readonly prompt?: ChatPromptResource;
    readonly mentionPrompt?: ChatPromptResource;
  }) {
    this.#store = options.store;
    this.#chat = options.chat;
    this.#listAgents = options.listAgents;
    this.#freeTurnPrompt = options.prompt ?? loadChatPromptResource();
    this.#mentionedTurnPrompt = options.mentionPrompt ?? loadChatMentionPromptResource();
  }

  public handle(
    execution: RuntimeExecution,
    at = new Date().toISOString()
  ): readonly string[] {
    if (execution.handler !== "chat" || execution.status !== "running") {
      throw new Error(`ChatHandler cannot process Execution: ${execution.executionId}`);
    }
    const event = this.#store.event(execution.eventId);
    if (event?.type !== "chat.message") {
      throw new Error(`ChatHandler requires chat.message: ${execution.eventId}`);
    }
    const history = boundedChatPromptHistory(chatTimelineFromStore(
      this.#chat,
      event.topicId,
      { beforeEventId: event.eventId, limit: 50 }
    ));
    const plans = planChatAttention({
      message: event,
      candidates: this.#listAgents().map((agent) => {
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
      }),
      now: at
    });
    return this.#store.admitChatAttention(
      execution.executionId,
      plans.map((plan) => plan.outcome === "skip"
        ? { plan }
        : (() => {
            const prompt = plan.reason === "direct-mention"
              ? this.#mentionedTurnPrompt
              : this.#freeTurnPrompt;
            return {
            plan,
            promptResourceId: prompt.resourceId,
            prompt: prompt.render({
              agent: { agentId: plan.agentId, handle: plan.handle },
              topicId: event.topicId,
              attentionReason: plan.reason,
              currentPresence: plan.presenceSnapshot,
              latestMessage: event,
              history,
              now: at
            })
            };
          })()),
      at
    ).map((dispatch) => dispatch.eventId);
  }
}
