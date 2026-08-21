import type {
  AgentPublicProfileRecord,
  TopicAgentMembershipRecord,
  TopicEventAppendRecord,
  TopicEventRecord,
  TopicHumanRoleRecord,
  TopicProfileRecord,
  TopicRuntimeSubscriptionRecord,
  TopicRecord
} from "./model.js";

export interface CreateTopicInput {
  readonly topic: TopicRecord;
  readonly profile: TopicProfileRecord;
  readonly owner: TopicHumanRoleRecord;
}

export interface ProfileTopicRepository {
  getAgentPublicProfile(agentId: string): Promise<AgentPublicProfileRecord | undefined>;
  putAgentPublicProfile(
    profile: AgentPublicProfileRecord,
    expectedRevision: number
  ): Promise<AgentPublicProfileRecord | undefined>;
  createTopic(input: CreateTopicInput): Promise<void>;
  listTopicsForHuman(humanId: string): Promise<readonly TopicRecord[]>;
  getTopic(topicId: string): Promise<TopicRecord | undefined>;
  getTopicProfile(topicId: string): Promise<TopicProfileRecord | undefined>;
  putTopicProfile(
    profile: TopicProfileRecord,
    expectedRevision: number
  ): Promise<TopicProfileRecord | undefined>;
  getTopicHumanRole(
    topicId: string,
    humanId: string
  ): Promise<TopicHumanRoleRecord | undefined>;
  getTopicAgentMembership(
    topicId: string,
    agentId: string
  ): Promise<TopicAgentMembershipRecord | undefined>;
  joinTopic(
    membership: TopicAgentMembershipRecord,
    subscription: TopicRuntimeSubscriptionRecord
  ): Promise<{
    readonly membership: TopicAgentMembershipRecord;
    readonly subscription: TopicRuntimeSubscriptionRecord;
  }>;
  getTopicRuntimeSubscription(
    topicId: string,
    runtimeId: string
  ): Promise<TopicRuntimeSubscriptionRecord | undefined>;
  listTopicRuntimeViews(runtimeId: string): Promise<readonly {
    readonly subscription: TopicRuntimeSubscriptionRecord;
    readonly agentIds: readonly string[];
  }[]>;
  advanceTopicRuntimeCursor(
    topicId: string,
    runtimeId: string,
    cursor: number,
    updatedAt: string
  ): Promise<TopicRuntimeSubscriptionRecord | undefined>;
  appendTopicEvent(event: TopicEventAppendRecord): Promise<TopicEventRecord>;
  listTopicEvents(
    topicId: string,
    runtimeId: string,
    after: number,
    limit: number
  ): Promise<{
    readonly events: readonly TopicEventRecord[];
    readonly head: number;
  }>;
}
