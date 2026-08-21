import {
  agentPublicProfileUpdateSchema,
  topicCreateRequestSchema,
  topicJoinRequestSchema,
  topicEventPublishRequestSchema,
  topicProfileUpdateSchema,
  topicRuntimeCursorUpdateSchema
} from "@rollerskate/protocol";

import type { DeviceService } from "../modules/device/service.js";
import type { AgentService } from "../modules/agent/service.js";
import type { ProfileTopicService } from "../modules/profile-topic/service.js";
import { ServerError } from "../modules/shared/error.js";
import type { ApiRequest } from "./http.js";
import { bearerToken, matchPath, readJsonBody, writeJson } from "./http.js";

export interface ProfileTopicApiDependencies {
  readonly profiles?: ProfileTopicService;
  readonly devices: DeviceService;
  readonly agents: AgentService;
}

export async function handleProfileTopicApi(
  context: ApiRequest,
  dependencies: ProfileTopicApiDependencies
): Promise<boolean> {
  const { request, response, url } = context;
  const profiles = (): ProfileTopicService => {
    if (dependencies.profiles === undefined) {
      throw new ServerError("profiles_not_configured", 503,
        "Profile and Topic service is not configured");
    }
    return dependencies.profiles;
  };
  const authentication = async () =>
    dependencies.devices.authenticateDevice(bearerToken(request));

  const agentProfileId = matchPath(url.pathname, /^\/api\/agents\/([^/]+)\/profile$/);
  if (agentProfileId !== undefined && request.method === "GET") {
    writeJson(response, 200, await profiles().getAgentProfile(
      await authentication(),
      agentProfileId
    ));
    return true;
  }
  if (agentProfileId !== undefined && request.method === "PATCH") {
    const body = agentPublicProfileUpdateSchema.parse(await readJsonBody(request));
    writeJson(response, 200, await profiles().updateAgentProfile(
      await authentication(),
      agentProfileId,
      body
    ));
    return true;
  }

  if (url.pathname === "/api/topics" && request.method === "GET") {
    writeJson(response, 200, await profiles().listTopics(await authentication()));
    return true;
  }
  if (url.pathname === "/api/topics" && request.method === "POST") {
    const body = topicCreateRequestSchema.parse(await readJsonBody(request));
    writeJson(response, 201, await profiles().createTopic(
      await authentication(),
      body
    ));
    return true;
  }
  const topicId = matchPath(url.pathname, /^\/api\/topics\/([^/]+)$/);
  if (topicId !== undefined && request.method === "GET") {
    writeJson(response, 200, await profiles().getTopic(
      await authentication(),
      topicId
    ));
    return true;
  }
  const topicProfileId = matchPath(url.pathname, /^\/api\/topics\/([^/]+)\/profile$/);
  if (topicProfileId !== undefined && request.method === "PATCH") {
    const body = topicProfileUpdateSchema.parse(await readJsonBody(request));
    writeJson(response, 200, await profiles().updateTopicProfile(
      await authentication(),
      topicProfileId,
      body
    ));
    return true;
  }
  const topicMembershipId = matchPath(
    url.pathname,
    /^\/api\/topics\/([^/]+)\/memberships$/
  );
  if (topicMembershipId !== undefined && request.method === "POST") {
    const body = topicJoinRequestSchema.parse(await readJsonBody(request));
    writeJson(response, 200, await profiles().joinTopic(
      await authentication(),
      topicMembershipId,
      body.agentId
    ));
    return true;
  }
  const topicEventId = matchPath(url.pathname, /^\/api\/topics\/([^/]+)\/events$/);
  if (topicEventId !== undefined && request.method === "POST") {
    const body = topicEventPublishRequestSchema.parse(await readJsonBody(request));
    const agentAuthentication = await dependencies.agents.authenticateAgent(bearerToken(request));
    writeJson(response, 201, await profiles().publish(agentAuthentication, topicEventId, body));
    return true;
  }
  const humanTopicEventId = matchPath(
    url.pathname,
    /^\/api\/topics\/([^/]+)\/human-events$/
  );
  if (humanTopicEventId !== undefined && request.method === "POST") {
    const body = topicEventPublishRequestSchema.parse(await readJsonBody(request));
    writeJson(response, 201, await profiles().publishHuman(
      await authentication(),
      humanTopicEventId,
      body
    ));
    return true;
  }
  if (url.pathname === "/api/runtime-topics" && request.method === "GET") {
    writeJson(response, 200, await profiles().runtimeTopics(await authentication()));
    return true;
  }
  const runtimeTopicId = matchPath(
    url.pathname,
    /^\/api\/runtime-topics\/([^/]+)\/events$/
  );
  if (runtimeTopicId !== undefined && request.method === "GET") {
    const after = boundedQueryInteger(url, "after", 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedQueryInteger(url, "limit", 100, 1, 100);
    writeJson(response, 200, await profiles().events(
      await authentication(),
      runtimeTopicId,
      after,
      limit
    ));
    return true;
  }
  const runtimeTopicCursorId = matchPath(
    url.pathname,
    /^\/api\/runtime-topics\/([^/]+)\/cursor$/
  );
  if (runtimeTopicCursorId !== undefined && request.method === "POST") {
    const body = topicRuntimeCursorUpdateSchema.parse(await readJsonBody(request));
    writeJson(response, 200, await profiles().acknowledgeEvents(
      await authentication(),
      runtimeTopicCursorId,
      body.cursor
    ));
    return true;
  }
  return false;
}

function boundedQueryInteger(
  url: URL,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = url.searchParams.get(name);
  const value = raw === null ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ServerError("invalid_request", 400, `${name} is invalid`);
  }
  return value;
}
