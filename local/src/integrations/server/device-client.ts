import {
  agentCreateResponseSchema,
  agentCredentialIssuanceSchema,
  agentListSchema,
  agentRoomBindingListSchema,
  agentRoomBindingSummarySchema,
  agentSummarySchema,
  agentPublicProfileSchema,
  topicJoinReceiptSchema,
  deviceSummarySchema,
  roomListSchema,
  roomMessageSendResponseSchema,
  roomSummarySchema,
  topicEventPageSchema,
  topicRuntimeSubscriptionSchema,
  topicRuntimeViewListSchema,
  topicSummaryListSchema,
  topicSummarySchema,
  integrationBindingSchema,
  topicEventSchema,
  type AgentCreateRequest,
  type AgentCreateResponse,
  type AgentCredentialIssuance,
  type AgentSummary,
  type AgentRoomBindingSummary,
  type AgentRoomWakeModeUpdate,
  type AgentPublicProfile,
  type AgentPublicProfileUpdate,
  type DeviceSummary,
  type RoomSummary,
  type RoomVisibility,
  type RoomMessageSendResponse,
  type TopicEventPage,
  type TopicEvent,
  type TopicEventPublishRequest,
  type TopicCreateRequest,
  type TopicJoinReceipt,
  type TopicProfileUpdate,
  type TopicRuntimeSubscription,
  type TopicRuntimeView,
  type TopicSummary,
  type IntegrationBinding,
  type IntegrationBindingCreateRequest,
} from "../../protocol.js";
import {
  DeviceServerError,
  ServerHttpTransport,
  throwResponseError,
  type ServerClientOptions
} from "./transport.js";
export { DeviceServerError } from "./transport.js";

export interface DeviceServerClientOptions extends ServerClientOptions {
  readonly credential: string;
}

export class DeviceServerClient {
  readonly #transport: ServerHttpTransport;

  public constructor(options: DeviceServerClientOptions) {
    if (options.credential.trim() === "") throw new Error("Device credential must be non-empty");
    this.#transport = new ServerHttpTransport(options);
  }

  public status(): Promise<DeviceSummary> {
    return this.#transport.json("/api/device", { method: "GET" }, deviceSummarySchema.parse);
  }

  public integrationBinding(bindingId: string): Promise<IntegrationBinding> {
    return this.#transport.json(
      `/api/integration-bindings/${encodeURIComponent(bindingId)}`,
      { method: "GET" },
      integrationBindingSchema.parse
    );
  }

  public createIntegrationBinding(
    request: IntegrationBindingCreateRequest
  ): Promise<IntegrationBinding> {
    return this.#transport.json("/api/integration-bindings", {
      method: "POST",
      body: JSON.stringify(request)
    }, integrationBindingSchema.parse);
  }

  public async allowSubject(subject: string): Promise<void> {
    const response = await this.#transport.request("/api/admin/allowlist", {
      method: "POST",
      body: JSON.stringify({ subject })
    });
    if (response.status !== 201) await throwResponseError(response);
  }

  public createAgent(request: AgentCreateRequest): Promise<AgentCreateResponse> {
    return this.#transport.json("/api/agents", {
      method: "POST",
      body: JSON.stringify(request)
    }, agentCreateResponseSchema.parse);
  }

  public listAgents(): Promise<readonly AgentSummary[]> {
    return this.#transport.json("/api/agents", { method: "GET" }, agentListSchema.parse);
  }

  public agentByName(name: string): Promise<AgentSummary> {
    return this.#transport.json(
      `/api/agents/by-name/${encodeURIComponent(name)}`,
      { method: "GET" },
      agentSummarySchema.parse
    );
  }

  public redeemAgentEnrollment(
    enrollmentId: string,
    verifier: string
  ): Promise<AgentCredentialIssuance> {
    return this.#transport.json(
      `/api/agent-enrollments/${encodeURIComponent(enrollmentId)}/redeem`,
      { method: "POST", body: JSON.stringify({ verifier }) },
      agentCredentialIssuanceSchema.parse
    );
  }

  public runtimeTopics(): Promise<readonly TopicRuntimeView[]> {
    return this.#transport.json("/api/runtime-topics", { method: "GET" },
      topicRuntimeViewListSchema.parse);
  }

  public topic(topicId: string): Promise<TopicSummary> {
    return this.#transport.json(`/api/topics/${encodeURIComponent(topicId)}`, { method: "GET" },
      topicSummarySchema.parse);
  }

  public agentProfile(agentId: string): Promise<AgentPublicProfile> {
    return this.#transport.json(`/api/agents/${encodeURIComponent(agentId)}/profile`, { method: "GET" },
      agentPublicProfileSchema.parse);
  }

  public isMissingAgentProfileError(error: unknown): boolean {
    return error instanceof DeviceServerError && error.status === 404 &&
      error.code === "agent_profile_not_found";
  }

  public updateAgentProfile(
    agentId: string,
    update: AgentPublicProfileUpdate
  ): Promise<AgentPublicProfile> {
    return this.#transport.json(`/api/agents/${encodeURIComponent(agentId)}/profile`, {
      method: "PATCH",
      body: JSON.stringify(update)
    }, agentPublicProfileSchema.parse);
  }

  public createTopic(request: TopicCreateRequest): Promise<TopicSummary> {
    return this.#transport.json("/api/topics", {
      method: "POST",
      body: JSON.stringify(request)
    }, topicSummarySchema.parse);
  }

  public listTopics(): Promise<readonly TopicSummary[]> {
    return this.#transport.json("/api/topics", { method: "GET" }, topicSummaryListSchema.parse);
  }

  public updateTopicProfile(
    topicId: string,
    update: TopicProfileUpdate
  ): Promise<TopicSummary> {
    return this.#transport.json(`/api/topics/${encodeURIComponent(topicId)}/profile`, {
      method: "PATCH",
      body: JSON.stringify(update)
    }, topicSummarySchema.parse);
  }

  public joinTopic(topicId: string, agentId: string): Promise<TopicJoinReceipt> {
    return this.#transport.json(`/api/topics/${encodeURIComponent(topicId)}/memberships`, {
      method: "POST",
      body: JSON.stringify({ agentId })
    }, topicJoinReceiptSchema.parse);
  }

  public topicEvents(topicId: string, after: number, limit = 100): Promise<TopicEventPage> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    return this.#transport.json(
      `/api/runtime-topics/${encodeURIComponent(topicId)}/events?${query}`,
      { method: "GET" },
      topicEventPageSchema.parse
    );
  }

  public publishHumanTopic(
    topicId: string,
    request: TopicEventPublishRequest
  ): Promise<TopicEvent> {
    return this.#transport.json(`/api/topics/${encodeURIComponent(topicId)}/human-events`, {
      method: "POST",
      body: JSON.stringify(request)
    }, topicEventSchema.parse);
  }

  public acknowledgeTopic(
    topicId: string,
    cursor: number
  ): Promise<TopicRuntimeSubscription> {
    return this.#transport.json(`/api/runtime-topics/${encodeURIComponent(topicId)}/cursor`, {
      method: "POST",
      body: JSON.stringify({ cursor })
    }, topicRuntimeSubscriptionSchema.parse);
  }

  public createRoom(name: string, visibility: RoomVisibility): Promise<RoomSummary> {
    return this.#transport.json("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ name, visibility })
    }, roomSummarySchema.parse);
  }

  public listRooms(): Promise<readonly RoomSummary[]> {
    return this.#transport.json("/api/rooms", { method: "GET" }, roomListSchema.parse);
  }

  public joinRoom(roomId: string): Promise<RoomSummary> {
    return this.#transport.json(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
      method: "POST",
      body: JSON.stringify({})
    }, roomSummarySchema.parse);
  }

  public inviteHuman(roomId: string, humanId: string): Promise<RoomSummary> {
    return this.#transport.json(`/api/rooms/${encodeURIComponent(roomId)}/members`, {
      method: "POST",
      body: JSON.stringify({ humanId })
    }, roomSummarySchema.parse);
  }

  public sendRoomMessage(
    roomId: string,
    transactionId: string,
    body: string
  ): Promise<RoomMessageSendResponse> {
    return this.#transport.json(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ transactionId, body })
    }, roomMessageSendResponseSchema.parse);
  }

  public inviteAgent(roomId: string, agentId: string): Promise<AgentRoomBindingSummary> {
    return this.#transport.json(`/api/rooms/${encodeURIComponent(roomId)}/agents`, {
      method: "POST",
      body: JSON.stringify({ agentId })
    }, agentRoomBindingSummarySchema.parse);
  }

  public updateAgentWakeMode(
    roomId: string,
    agentId: string,
    wakeMode: AgentRoomWakeModeUpdate["wakeMode"]
  ): Promise<AgentRoomBindingSummary> {
    return this.#transport.json(
      `/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}`,
      { method: "PATCH", body: JSON.stringify({ wakeMode }) },
      agentRoomBindingSummarySchema.parse
    );
  }

  public async removeAgent(roomId: string, agentId: string): Promise<void> {
    const response = await this.#transport.request(
      `/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}`,
      { method: "DELETE" }
    );
    if (response.status !== 204) await throwResponseError(response);
  }

  public listAgentRoomBindings(agentId: string): Promise<readonly AgentRoomBindingSummary[]> {
    return this.#transport.json(
      `/api/agent-principals/${encodeURIComponent(agentId)}/rooms`,
      { method: "GET" },
      agentRoomBindingListSchema.parse
    );
  }

  public async revoke(): Promise<void> {
    const response = await this.#transport.request("/api/device", { method: "DELETE" });
    if (response.status !== 204) {
      await throwResponseError(response);
    }
  }
}
