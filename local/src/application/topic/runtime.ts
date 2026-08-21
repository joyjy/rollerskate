import type { ChatDispatchEvent } from "../../core/event/model.js";
import { runtimeId } from "../../core/runtime/model.js";
import type { ChatReplyRoute } from "../../core/runtime/store/types.js";
import { TopicInboxStore } from "../../infrastructure/files/topic-inbox-store.js";
import type { LocalChatStore } from "../../infrastructure/sqlite/chat-store.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import { mentionedChatAgents } from "../chat/mention.js";
import type { TopicEvent } from "../../protocol.js";
import type { HumanTopicEvent, TopicSyncParticipant } from "./sync.js";

export class ServerTopicRuntimeBridge {
  readonly #localTopicId: string;
  readonly #listAgents: () => readonly LocalAgent[];
  readonly #serverAgentIdForHandle: (handle: string) => string | undefined;
  readonly #hasTopicPublisher: (serverAgentId: string) => boolean;
  readonly #inbox: TopicInboxStore;
  readonly #chat: Pick<
    LocalChatStore,
    "admitExternalOwnerMessage" | "admitExternalAgentMessage" | "hasCanonicalEvent"
  >;
  readonly #destinationIds = new Map<string, string>();

  public constructor(options: {
    readonly localTopicId: string;
    readonly listAgents: () => readonly LocalAgent[];
    readonly serverAgentIdForHandle: (handle: string) => string | undefined;
    readonly hasTopicPublisher: (serverAgentId: string) => boolean;
    readonly inbox: TopicInboxStore;
    readonly chat: Pick<
      LocalChatStore,
      "admitExternalOwnerMessage" | "admitExternalAgentMessage" | "hasCanonicalEvent"
    >;
  }) {
    this.#localTopicId = options.localTopicId;
    this.#listAgents = options.listAgents;
    this.#serverAgentIdForHandle = options.serverAgentIdForHandle;
    this.#hasTopicPublisher = options.hasTopicPublisher;
    this.#inbox = options.inbox;
    this.#chat = options.chat;
  }

  public participants = (): readonly TopicSyncParticipant[] =>
    this.#listAgents().flatMap((agent) => {
      if (agent.status !== "active") return [];
      const serverAgentId = this.#serverAgentIdForHandle(agent.handle);
      return serverAgentId === undefined
        ? []
        : [{ localAgentId: agent.principalId, serverAgentId }];
    });

  public admitHumanEvent = (
    event: HumanTopicEvent,
    participants: readonly TopicSyncParticipant[]
  ): ReturnType<LocalChatStore["admitExternalOwnerMessage"]> => {
    const participantIds = new Set(participants.map((entry) => entry.localAgentId));
    const mentioned = mentionedChatAgents(
      event.body,
      this.#listAgents().filter((agent) => participantIds.has(agent.principalId))
    );
    return this.#chat.admitExternalOwnerMessage({
      source: { kind: "server", externalId: event.eventId },
      topicId: event.topicId,
      sender: {
        principalId: event.publisher.humanId,
        handleSnapshot: event.publisher.displayName
      },
      body: event.body,
      ...(mentioned.length === 1
        ? { target: { principalId: mentioned[0]!.principalId, handle: mentioned[0]!.handle } }
        : {}),
      at: event.createdAt
    });
  };

  public admitAgentEvent = (
    event: TopicEvent & { readonly publisher: { readonly kind: "agent" } },
    participants: readonly TopicSyncParticipant[]
  ): ReturnType<LocalChatStore["admitExternalAgentMessage"]> | undefined => {
    if (this.#chat.hasCanonicalEvent(event.transactionId)) return undefined;
    const participant = participants.find(
      (entry) => entry.serverAgentId === event.publisher.agentId
    );
    if (participant === undefined) return undefined;
    const local = this.#listAgents().find(
      (agent) => agent.principalId === participant.localAgentId
    );
    if (local === undefined) return undefined;
    return this.#chat.admitExternalAgentMessage({
      source: { kind: "server", externalId: event.eventId },
      topicId: event.topicId,
      sender: {
        principalId: local.principalId,
        handleSnapshot: local.handle
      },
      body: event.body,
      at: event.createdAt
    });
  };

  public resolveChatReplyRoute = (event: ChatDispatchEvent): ChatReplyRoute | undefined => {
    if (event.topicId === this.#localTopicId) return undefined;
    const participant = this.#inbox.participant(event.topicId, event.agentId);
    if (participant === undefined || !this.#hasTopicPublisher(participant.serverAgentId)) {
      throw new Error(`Server Topic reply publisher is unavailable: ${event.agentId}`);
    }
    const key = `${event.topicId}:${event.agentId}`;
    let destinationId = this.#destinationIds.get(key);
    if (destinationId === undefined) {
      destinationId = runtimeId("dst");
      this.#destinationIds.set(key, destinationId);
    }
    return {
      continueAttention: true,
      delivery: {
        destinationId,
        kind: "server-topic",
        address: {
          topicId: event.topicId,
          agentId: participant.serverAgentId
        }
      }
    };
  };

  public agentsForTopic = (topicId: string): readonly LocalAgent[] => {
    const agents = this.#listAgents();
    if (topicId === this.#localTopicId) return agents;
    const participantIds = new Set(this.#inbox.localParticipantIds(topicId));
    return agents.filter((agent) => participantIds.has(agent.principalId));
  };

  public profileResolution = (
    agentId: string,
    topicId: string
  ): ReturnType<TopicInboxStore["profileResolution"]> =>
    topicId === this.#localTopicId
      ? { kind: "local" }
      : this.#inbox.profileResolution(agentId, topicId);
}
