import type {
  AgentPublicProfile,
  TopicAgentMembership,
  TopicEvent,
  TopicProfile,
  TopicRuntimeSubscription,
  TopicSummary
} from "@rollerskate/protocol";

export type AgentPublicProfileRecord = AgentPublicProfile;
export type TopicProfileRecord = TopicProfile;
export type TopicAgentMembershipRecord = TopicAgentMembership;
export type TopicEventRecord = TopicEvent;
export type TopicEventAppendRecord = TopicEventRecord extends infer Event
  ? Event extends { readonly sequence: number }
    ? Omit<Event, "sequence">
    : never
  : never;
export type TopicRuntimeSubscriptionRecord = TopicRuntimeSubscription;

export interface TopicRecord {
  readonly id: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly ownerHumanId: string;
  readonly createdAt: string;
}

export interface TopicHumanRoleRecord {
  readonly topicId: string;
  readonly humanId: string;
  readonly role: "owner" | "admin";
  readonly status: "active" | "revoked";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function topicSummary(topic: TopicRecord, profile: TopicProfileRecord): TopicSummary {
  return {
    id: topic.id,
    name: topic.name,
    visibility: topic.visibility,
    ownerHumanId: topic.ownerHumanId,
    profile,
    createdAt: topic.createdAt
  };
}
