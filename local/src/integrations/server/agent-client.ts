import {
  agentSummarySchema,
  agentWorkRequestSchema,
  agentWorkRequestListSchema,
  workRequestRouteReceiptSchema,
  topicEventSchema,
  type AgentWorkRequest,
  type AgentWorkRequestDecision,
  type AgentWorkRequestRunAttach,
  type AgentWorkRequestResultSubmit,
  type AgentSummary,
  type TopicEvent,
  type TopicEventPublishRequest
} from "../../protocol.js";
import { ServerHttpTransport, type ServerClientOptions } from "./transport.js";

export interface AgentServerClientOptions extends ServerClientOptions {
  readonly agentId: string;
  readonly credential: string;
}

export class AgentServerClient {
  readonly #agentId: string;
  readonly #transport: ServerHttpTransport;

  public constructor(options: AgentServerClientOptions) {
    if (options.agentId.trim() === "") throw new Error("Agent ID must be non-empty");
    if (options.credential.trim() === "") throw new Error("Agent credential must be non-empty");
    this.#agentId = options.agentId;
    this.#transport = new ServerHttpTransport(options);
  }

  public principal(): Promise<AgentSummary> {
    return this.#transport.json(
      `/api/agent-principals/${encodeURIComponent(this.#agentId)}`,
      { method: "GET" },
      agentSummarySchema.parse
    );
  }

  public registerWorkRequestRoute(
    routeId: string,
    leaseMilliseconds = 60_000
  ) {
    return this.#transport.json(
      `/api/agent-principals/${encodeURIComponent(this.#agentId)}/work-request-route`,
      {
        method: "PUT",
        body: JSON.stringify({
          schemaVersion: "WorkRequestRouteLease@1",
          routeId,
          leaseMilliseconds
        })
      },
      workRequestRouteReceiptSchema.parse
    );
  }

  public routedWorkRequests(routeId: string, limit = 20): Promise<readonly AgentWorkRequest[]> {
    const query = new URLSearchParams({ routeId, limit: String(limit) });
    return this.#transport.json(
      `/api/agent-principals/${encodeURIComponent(this.#agentId)}/work-requests?${query}`,
      { method: "GET" },
      agentWorkRequestListSchema.parse
    );
  }

  public acceptedWorkRequestsWithoutRun(limit = 20): Promise<readonly AgentWorkRequest[]> {
    const query = new URLSearchParams({ state: "accepted-without-run", limit: String(limit) });
    return this.#transport.json(
      `/api/agent-principals/${encodeURIComponent(this.#agentId)}/work-requests?${query}`,
      { method: "GET" },
      agentWorkRequestListSchema.parse
    );
  }

  public workRequest(workRequestId: string): Promise<AgentWorkRequest> {
    return this.#transport.json(this.#workRequestPath(workRequestId), { method: "GET" },
      agentWorkRequestSchema.parse);
  }

  public decideWorkRequest(
    workRequestId: string,
    decision: AgentWorkRequestDecision
  ): Promise<AgentWorkRequest> {
    return this.#transport.json(`${this.#workRequestPath(workRequestId)}/decision`, {
      method: "PUT", body: JSON.stringify(decision)
    }, agentWorkRequestSchema.parse);
  }

  public attachWorkRequestRun(
    workRequestId: string,
    attachment: AgentWorkRequestRunAttach
  ): Promise<AgentWorkRequest> {
    return this.#transport.json(`${this.#workRequestPath(workRequestId)}/run`, {
      method: "PUT", body: JSON.stringify(attachment)
    }, agentWorkRequestSchema.parse);
  }

  public completeWorkRequest(
    workRequestId: string,
    result: AgentWorkRequestResultSubmit
  ): Promise<AgentWorkRequest> {
    return this.#transport.json(`${this.#workRequestPath(workRequestId)}/result`, {
      method: "PUT", body: JSON.stringify(result)
    }, agentWorkRequestSchema.parse);
  }

  public publishTopic(
    topicId: string,
    request: TopicEventPublishRequest
  ): Promise<TopicEvent> {
    return this.#transport.json(`/api/topics/${encodeURIComponent(topicId)}/events`, {
      method: "POST",
      body: JSON.stringify(request)
    }, topicEventSchema.parse);
  }

  #workRequestPath(workRequestId: string): string {
    return `/api/agent-principals/${encodeURIComponent(this.#agentId)}/work-requests/${
      encodeURIComponent(workRequestId)}`;
  }
}
