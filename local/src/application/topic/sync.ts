import type {
  AgentPublicProfile,
  TopicEventPage,
  TopicRuntimeSubscription,
  TopicRuntimeView,
  TopicSummary
} from "../../protocol.js";
import type { TopicEvent } from "../../protocol.js";
import {
  TopicInboxStore,
  type LocalTopicParticipant
} from "../../infrastructure/files/topic-inbox-store.js";

export interface TopicSyncClient {
  runtimeTopics(): Promise<readonly TopicRuntimeView[]>;
  topic(topicId: string): Promise<TopicSummary>;
  agentProfile(agentId: string): Promise<AgentPublicProfile>;
  isMissingAgentProfileError(error: unknown): boolean;
  topicEvents(topicId: string, after: number, limit?: number): Promise<TopicEventPage>;
  acknowledgeTopic(topicId: string, cursor: number): Promise<TopicRuntimeSubscription>;
}

export interface TopicSyncParticipant {
  readonly localAgentId: string;
  readonly serverAgentId: string;
}

export type HumanTopicEvent = TopicEvent & {
  readonly publisher: { readonly kind: "human" };
};

export class PassiveTopicSync {
  readonly #client: TopicSyncClient;
  readonly #inbox: TopicInboxStore;
  readonly #participants: () => readonly TopicSyncParticipant[];
  readonly #admitHumanEvent: ((
    event: HumanTopicEvent,
    participants: readonly TopicSyncParticipant[]
  ) => unknown) | undefined;
  readonly #admitAgentEvent: ((
    event: TopicEvent & { readonly publisher: { readonly kind: "agent" } },
    participants: readonly TopicSyncParticipant[]
  ) => unknown) | undefined;
  readonly #now: () => Date;

  public constructor(options: {
    readonly client: TopicSyncClient;
    readonly inbox: TopicInboxStore;
    readonly participants: () => readonly TopicSyncParticipant[];
    readonly admitHumanEvent?: (
      event: HumanTopicEvent,
      participants: readonly TopicSyncParticipant[]
    ) => unknown;
    readonly admitAgentEvent?: (
      event: TopicEvent & { readonly publisher: { readonly kind: "agent" } },
      participants: readonly TopicSyncParticipant[]
    ) => unknown;
    readonly now?: () => Date;
  }) {
    this.#client = options.client;
    this.#inbox = options.inbox;
    this.#participants = options.participants;
    this.#admitHumanEvent = options.admitHumanEvent;
    this.#admitAgentEvent = options.admitAgentEvent;
    this.#now = options.now ?? (() => new Date());
  }

  public async syncOnce(): Promise<{
    readonly topics: number;
    readonly admitted: number;
    readonly cursor: number;
    readonly profileFailures: number;
  }> {
    let admitted = 0;
    let cursor = 0;
    let profileFailures = 0;
    const views = await this.#client.runtimeTopics();
    for (const view of views) {
      if (view.subscription.status !== "active") continue;
      const topicId = view.subscription.topicId;
      const [topic, page] = await Promise.all([
        this.#client.topic(topicId),
        this.#client.topicEvents(topicId, this.#inbox.cursor(topicId), 100)
      ]);
      const participants: LocalTopicParticipant[] = [];
      for (const participant of this.#participants().filter((candidate) =>
        view.agentIds.includes(candidate.serverAgentId))) {
        try {
          participants.push({
            ...participant,
            profile: await this.#client.agentProfile(participant.serverAgentId)
          });
        } catch (error) {
          if (!this.#client.isMissingAgentProfileError(error)) throw error;
          profileFailures += 1;
        }
      }
      for (const event of page.events) {
        if (event.publisher.kind === "human") {
          this.#admitHumanEvent?.(event as HumanTopicEvent, participants);
        } else {
          this.#admitAgentEvent?.(
            event as TopicEvent & { readonly publisher: { readonly kind: "agent" } },
            participants
          );
        }
      }
      const committed = this.#inbox.commit({
        view,
        topic,
        participants,
        page,
        syncedAt: this.#now().toISOString()
      });
      await this.#client.acknowledgeTopic(topicId, committed.cursor);
      admitted += page.events.length;
      cursor += committed.cursor;
    }
    return { topics: views.length, admitted, cursor, profileFailures };
  }
}
