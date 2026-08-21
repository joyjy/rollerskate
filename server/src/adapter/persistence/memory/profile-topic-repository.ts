import type {
  AgentPublicProfileRecord,
  TopicAgentMembershipRecord,
  TopicEventAppendRecord,
  TopicEventRecord,
  TopicHumanRoleRecord,
  TopicProfileRecord,
  TopicRuntimeSubscriptionRecord,
  TopicRecord
} from "../../../modules/profile-topic/model.js";
import type {
  CreateTopicInput,
  ProfileTopicRepository
} from "../../../modules/profile-topic/repository.js";

export class MemoryProfileTopicRepository implements ProfileTopicRepository {
  readonly #agentProfiles = new Map<string, AgentPublicProfileRecord>();
  readonly #topics = new Map<string, TopicRecord>();
  readonly #topicProfiles = new Map<string, TopicProfileRecord>();
  readonly #humanRoles = new Map<string, TopicHumanRoleRecord>();
  readonly #agentMemberships = new Map<string, TopicAgentMembershipRecord>();
  readonly #runtimeSubscriptions = new Map<string, TopicRuntimeSubscriptionRecord>();
  readonly #topicEvents = new Map<string, TopicEventRecord[]>();
  readonly #eventTransactions = new Map<string, TopicEventRecord>();
  readonly #agentRuntimes = new Map<string, string>();

  public async getAgentPublicProfile(
    agentId: string
  ): Promise<AgentPublicProfileRecord | undefined> {
    return this.#agentProfiles.get(agentId);
  }

  public async putAgentPublicProfile(
    profile: AgentPublicProfileRecord,
    expectedRevision: number
  ): Promise<AgentPublicProfileRecord | undefined> {
    const current = this.#agentProfiles.get(profile.agentId);
    if ((current?.revision ?? 0) !== expectedRevision || profile.revision !== expectedRevision + 1) {
      return undefined;
    }
    this.#agentProfiles.set(profile.agentId, profile);
    return profile;
  }

  public async createTopic(input: CreateTopicInput): Promise<void> {
    if (this.#topics.has(input.topic.id)) throw new Error(`Topic already exists: ${input.topic.id}`);
    this.#topics.set(input.topic.id, input.topic);
    this.#topicProfiles.set(input.topic.id, input.profile);
    this.#humanRoles.set(humanRoleKey(input.topic.id, input.owner.humanId), input.owner);
  }

  public async listTopicsForHuman(humanId: string): Promise<readonly TopicRecord[]> {
    return [...this.#topics.values()]
      .filter((topic) => this.#humanRoles.get(humanRoleKey(topic.id, humanId))?.status === "active")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  public async getTopic(topicId: string): Promise<TopicRecord | undefined> {
    return this.#topics.get(topicId);
  }

  public async getTopicProfile(topicId: string): Promise<TopicProfileRecord | undefined> {
    return this.#topicProfiles.get(topicId);
  }

  public async putTopicProfile(
    profile: TopicProfileRecord,
    expectedRevision: number
  ): Promise<TopicProfileRecord | undefined> {
    const current = this.#topicProfiles.get(profile.topicId);
    if (current?.revision !== expectedRevision || profile.revision !== expectedRevision + 1) {
      return undefined;
    }
    this.#topicProfiles.set(profile.topicId, profile);
    return profile;
  }

  public async getTopicHumanRole(
    topicId: string,
    humanId: string
  ): Promise<TopicHumanRoleRecord | undefined> {
    return this.#humanRoles.get(humanRoleKey(topicId, humanId));
  }

  public async getTopicAgentMembership(
    topicId: string,
    agentId: string
  ): Promise<TopicAgentMembershipRecord | undefined> {
    return this.#agentMemberships.get(agentMembershipKey(topicId, agentId));
  }

  public async joinTopic(
    membership: TopicAgentMembershipRecord,
    subscription: TopicRuntimeSubscriptionRecord
  ): Promise<{
    readonly membership: TopicAgentMembershipRecord;
    readonly subscription: TopicRuntimeSubscriptionRecord;
  }> {
    const key = agentMembershipKey(membership.topicId, membership.agentId);
    const current = this.#agentMemberships.get(key);
    const stored = current?.status === "active"
      ? current
      : { ...membership, createdAt: current?.createdAt ?? membership.createdAt };
    this.#agentMemberships.set(key, stored);
    const subscriptionKey = runtimeSubscriptionKey(subscription.topicId, subscription.runtimeId);
    const currentSubscription = this.#runtimeSubscriptions.get(subscriptionKey);
    const storedSubscription = currentSubscription?.status === "active"
      ? currentSubscription
      : { ...subscription, createdAt: currentSubscription?.createdAt ?? subscription.createdAt };
    this.#runtimeSubscriptions.set(subscriptionKey, storedSubscription);
    this.#agentRuntimes.set(membership.agentId, subscription.runtimeId);
    return { membership: stored, subscription: storedSubscription };
  }

  public async appendTopicEvent(
    event: TopicEventAppendRecord
  ): Promise<TopicEventRecord> {
    const publisherId = event.publisher.kind === "agent"
      ? event.publisher.agentId
      : event.publisher.humanId;
    const transactionKey = `${event.publisher.kind}\0${publisherId}\0${event.transactionId}`;
    const existing = this.#eventTransactions.get(transactionKey);
    if (existing !== undefined) return existing;
    const events = this.#topicEvents.get(event.topicId) ?? [];
    const appended = { ...event, sequence: events.length + 1 };
    events.push(appended);
    this.#topicEvents.set(event.topicId, events);
    this.#eventTransactions.set(transactionKey, appended);
    return appended;
  }

  public async getTopicRuntimeSubscription(
    topicId: string,
    runtimeId: string
  ): Promise<TopicRuntimeSubscriptionRecord | undefined> {
    return this.#runtimeSubscriptions.get(runtimeSubscriptionKey(topicId, runtimeId));
  }

  public async listTopicRuntimeViews(runtimeId: string) {
    return [...this.#runtimeSubscriptions.values()]
      .filter((subscription) => subscription.runtimeId === runtimeId &&
        subscription.status === "active")
      .map((subscription) => ({
        subscription,
        agentIds: [...this.#agentMemberships.values()]
          .filter((membership) => membership.topicId === subscription.topicId &&
            membership.status === "active" &&
            this.#agentRuntimes.get(membership.agentId) === runtimeId)
          .map((membership) => membership.agentId)
          .sort()
      }))
      .sort((left, right) => left.subscription.topicId.localeCompare(
        right.subscription.topicId));
  }

  public async advanceTopicRuntimeCursor(
    topicId: string,
    runtimeId: string,
    cursor: number,
    updatedAt: string
  ): Promise<TopicRuntimeSubscriptionRecord | undefined> {
    const key = runtimeSubscriptionKey(topicId, runtimeId);
    const subscription = this.#runtimeSubscriptions.get(key);
    if (subscription?.status !== "active") return undefined;
    const head = this.#topicEvents.get(topicId)?.length ?? 0;
    if (cursor > head) return undefined;
    if (cursor <= subscription.cursor) return subscription;
    const advanced = { ...subscription, cursor, updatedAt };
    this.#runtimeSubscriptions.set(key, advanced);
    return advanced;
  }

  public async listTopicEvents(
    topicId: string,
    runtimeId: string,
    after: number,
    limit: number
  ): Promise<{ readonly events: readonly TopicEventRecord[]; readonly head: number }> {
    const subscription = this.#runtimeSubscriptions.get(runtimeSubscriptionKey(topicId, runtimeId));
    if (subscription?.status !== "active") return { events: [], head: 0 };
    const all = this.#topicEvents.get(topicId) ?? [];
    return {
      events: all.filter((event) => event.sequence > after).slice(0, limit),
      head: all.length
    };
  }
}

function humanRoleKey(topicId: string, humanId: string): string {
  return `${topicId}\0${humanId}`;
}

function agentMembershipKey(topicId: string, agentId: string): string {
  return `${topicId}\0${agentId}`;
}

function runtimeSubscriptionKey(topicId: string, runtimeId: string): string {
  return `${topicId}\0${runtimeId}`;
}
