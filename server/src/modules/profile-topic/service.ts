import { randomUUID } from "node:crypto";

import type {
  AgentPublicProfile,
  AgentPublicProfileUpdate,
  AgentTopicPublisherIdentity,
  TopicCreateRequest,
  TopicEvent,
  TopicEventPage,
  TopicEventPublishRequest,
  TopicJoinReceipt,
  TopicRuntimeView,
  TopicProfile,
  TopicProfileUpdate,
  TopicSummary
} from "@rollerskate/protocol";

import type { AgentRepository } from "../agent/repository.js";
import type { AgentAuthenticationRecord } from "../agent/model.js";
import type { AgentAggregate } from "../agent/model.js";
import type { DeviceAuthenticationRecord } from "../device/model.js";
import { ServerError } from "../shared/error.js";
import { now, type ClockOptions } from "../shared/time.js";
import type { ProfileTopicRepository } from "./repository.js";
import { topicSummary } from "./model.js";

export class ProfileTopicService {
  readonly #profiles: ProfileTopicRepository;
  readonly #agents: AgentRepository;
  readonly #clock: ClockOptions;

  public constructor(
    profiles: ProfileTopicRepository,
    agents: AgentRepository,
    clock: ClockOptions = {}
  ) {
    this.#profiles = profiles;
    this.#agents = agents;
    this.#clock = clock;
  }

  public async getAgentProfile(
    _authentication: DeviceAuthenticationRecord,
    agentId: string
  ): Promise<AgentPublicProfile> {
    const profile = await this.#profiles.getAgentPublicProfile(agentId);
    if (profile === undefined) throw new ServerError("agent_profile_not_found", 404,
      "Agent public profile was not found");
    return profile;
  }

  public async updateAgentProfile(
    authentication: DeviceAuthenticationRecord,
    agentId: string,
    input: AgentPublicProfileUpdate
  ): Promise<AgentPublicProfile> {
    const aggregate = await this.#agents.getAgentAggregateById(agentId);
    if (aggregate === undefined) throw new ServerError("agent_not_found", 404,
      "Agent was not found");
    if (aggregate.owner.id !== authentication.human.id) {
      throw new ServerError("forbidden", 403, "Only the Agent owner can edit its profile");
    }
    const timestamp = now(this.#clock);
    const profile = await this.#profiles.putAgentPublicProfile({
      agentId,
      displayName: input.displayName,
      role: input.role,
      disclosure: input.disclosure,
      expressionRules: input.expressionRules,
      revision: input.expectedRevision + 1,
      updatedAt: timestamp
    }, input.expectedRevision);
    if (profile === undefined) throw new ServerError("profile_revision_conflict", 409,
      "Agent profile revision changed");
    return profile;
  }

  public async createTopic(
    authentication: DeviceAuthenticationRecord,
    input: TopicCreateRequest
  ): Promise<TopicSummary> {
    const timestamp = now(this.#clock);
    const topicId = randomUUID();
    const topic = {
      id: topicId,
      name: input.name,
      visibility: input.visibility,
      ownerHumanId: authentication.human.id,
      createdAt: timestamp
    } as const;
    const profile = {
      topicId,
      ...input.profile,
      revision: 1,
      updatedAt: timestamp
    };
    await this.#profiles.createTopic({
      topic,
      profile,
      owner: {
        topicId,
        humanId: authentication.human.id,
        role: "owner",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp
      }
    });
    return topicSummary(topic, profile);
  }

  public async listTopics(
    authentication: DeviceAuthenticationRecord
  ): Promise<readonly TopicSummary[]> {
    const topics = await this.#profiles.listTopicsForHuman(authentication.human.id);
    return Promise.all(topics.map(async (topic) => {
      const profile = await this.#profiles.getTopicProfile(topic.id);
      if (profile === undefined) {
        throw new Error(`Topic profile is missing: ${topic.id}`);
      }
      return topicSummary(topic, profile);
    }));
  }

  public async getTopic(
    authentication: DeviceAuthenticationRecord,
    topicId: string
  ): Promise<TopicSummary> {
    const [topic, profile] = await Promise.all([
      this.#profiles.getTopic(topicId),
      this.#profiles.getTopicProfile(topicId)
    ]);
    if (topic === undefined || profile === undefined) {
      throw new ServerError("topic_not_found", 404, "Topic was not found");
    }
    if (topic.visibility === "private") {
      const role = await this.#profiles.getTopicHumanRole(topicId, authentication.human.id);
      if (role?.status !== "active") throw new ServerError("topic_membership_required", 403,
        "Private Topic membership is required");
    }
    return topicSummary(topic, profile);
  }

  public async updateTopicProfile(
    authentication: DeviceAuthenticationRecord,
    topicId: string,
    input: TopicProfileUpdate
  ): Promise<TopicProfile> {
    await this.#requireTopicAdmin(topicId, authentication.human.id);
    const profile = await this.#profiles.putTopicProfile({
      topicId,
      purpose: input.purpose,
      participationRules: input.participationRules,
      expressionRules: input.expressionRules,
      revision: input.expectedRevision + 1,
      updatedAt: now(this.#clock)
    }, input.expectedRevision);
    if (profile === undefined) throw new ServerError("profile_revision_conflict", 409,
      "Topic profile revision changed");
    return profile;
  }

  public async joinTopic(
    authentication: DeviceAuthenticationRecord,
    topicId: string,
    agentId: string
  ): Promise<TopicJoinReceipt> {
    const [topic, agent] = await Promise.all([
      this.#profiles.getTopic(topicId),
      this.#agents.getAgentAggregateById(agentId)
    ]);
    if (topic === undefined) throw new ServerError("topic_not_found", 404,
      "Topic was not found");
    if (agent === undefined) throw new ServerError("agent_not_found", 404,
      "Agent was not found");
    if (agent.owner.id !== authentication.human.id) {
      throw new ServerError("forbidden", 403, "Only the Agent owner can join it to a Topic");
    }
    if (topic.visibility === "private") {
      const role = await this.#profiles.getTopicHumanRole(topicId, authentication.human.id);
      if (role?.status !== "active") throw new ServerError("topic_membership_required", 403,
        "Private Topic membership is required");
    }
    const timestamp = now(this.#clock);
    return this.#profiles.joinTopic(
      {
        topicId,
        agentId,
        status: "active",
        joinedByHumanId: authentication.human.id,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        topicId,
        runtimeId: agent.placement.deviceId,
        status: "active",
        cursor: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    );
  }

  public async publish(
    authentication: AgentAuthenticationRecord,
    topicId: string,
    input: TopicEventPublishRequest
  ): Promise<TopicEvent> {
    const [membership, agentProfile, topicProfile] = await Promise.all([
      this.#profiles.getTopicAgentMembership(topicId, authentication.agent.id),
      this.#profiles.getAgentPublicProfile(authentication.agent.id),
      this.#profiles.getTopicProfile(topicId)
    ]);
    if (membership?.status !== "active") throw new ServerError("topic_membership_required", 403,
      "Active Agent Topic membership is required");
    if (agentProfile === undefined) throw new ServerError("agent_profile_required", 409,
      "Agent public profile is required before publishing");
    if (topicProfile === undefined) throw new ServerError("topic_not_found", 404,
      "Topic was not found");
    const event = await this.#profiles.appendTopicEvent({
      eventId: randomUUID(),
      topicId,
      publisher: agentPublisherIdentity(authentication),
      transactionId: input.transactionId,
      body: input.body,
      agentProfileRevision: agentProfile.revision,
      topicProfileRevision: topicProfile.revision,
      createdAt: now(this.#clock)
    });
    return event;
  }

  public async publishHuman(
    authentication: DeviceAuthenticationRecord,
    topicId: string,
    input: TopicEventPublishRequest
  ): Promise<TopicEvent> {
    const [role, topicProfile] = await Promise.all([
      this.#profiles.getTopicHumanRole(topicId, authentication.human.id),
      this.#profiles.getTopicProfile(topicId)
    ]);
    if (role?.status !== "active") throw new ServerError("topic_membership_required", 403,
      "Active Human Topic membership is required");
    if (topicProfile === undefined) throw new ServerError("topic_not_found", 404,
      "Topic was not found");
    return this.#profiles.appendTopicEvent({
      eventId: randomUUID(),
      topicId,
      publisher: {
        kind: "human",
        humanId: authentication.human.id,
        displayName: authentication.human.displayName,
        deviceId: authentication.device.id
      },
      transactionId: input.transactionId,
      body: input.body,
      topicProfileRevision: topicProfile.revision,
      createdAt: now(this.#clock)
    });
  }

  public async events(
    authentication: DeviceAuthenticationRecord,
    topicId: string,
    after: number,
    limit: number
  ): Promise<TopicEventPage> {
    const runtimeId = authentication.device.id;
    const subscription = await this.#profiles.getTopicRuntimeSubscription(topicId, runtimeId);
    if (subscription?.status !== "active") {
      throw new ServerError("topic_subscription_required", 403,
        "Active Runtime Topic subscription is required");
    }
    const effectiveAfter = Math.max(after, subscription.cursor);
    const page = await this.#profiles.listTopicEvents(topicId, runtimeId, effectiveAfter, limit);
    return {
      topicId,
      runtimeId,
      events: [...page.events],
      nextCursor: page.events.at(-1)?.sequence ?? effectiveAfter,
      head: page.head
    };
  }

  public async runtimeTopics(
    authentication: DeviceAuthenticationRecord
  ): Promise<readonly TopicRuntimeView[]> {
    return (await this.#profiles.listTopicRuntimeViews(authentication.device.id)).map((view) => ({
      subscription: view.subscription,
      agentIds: [...view.agentIds]
    }));
  }

  public async acknowledgeEvents(
    authentication: DeviceAuthenticationRecord,
    topicId: string,
    cursor: number
  ): Promise<import("@rollerskate/protocol").TopicRuntimeSubscription> {
    const runtimeId = authentication.device.id;
    const subscription = await this.#profiles.getTopicRuntimeSubscription(topicId, runtimeId);
    if (subscription?.status !== "active") {
      throw new ServerError("topic_subscription_required", 403,
        "Active Runtime Topic subscription is required");
    }
    const advanced = await this.#profiles.advanceTopicRuntimeCursor(
      topicId,
      runtimeId,
      cursor,
      now(this.#clock)
    );
    if (advanced === undefined) {
      throw new ServerError("topic_cursor_ahead", 409,
        "Topic cursor cannot advance beyond the current head");
    }
    return advanced;
  }

  async #requireTopicAdmin(topicId: string, humanId: string): Promise<void> {
    const role = await this.#profiles.getTopicHumanRole(topicId, humanId);
    if (role?.status !== "active" || (role.role !== "owner" && role.role !== "admin")) {
      throw new ServerError("forbidden", 403, "Topic owner or admin permission is required");
    }
  }
}

function agentPublisherIdentity(publisher: AgentAggregate): AgentTopicPublisherIdentity {
  return {
    kind: "agent",
    agentId: publisher.agent.id,
    agentName: publisher.agent.name,
    ownerHumanId: publisher.owner.id,
    ownerDisplayName: publisher.owner.displayName,
    deviceId: publisher.placement.deviceId
  };
}
