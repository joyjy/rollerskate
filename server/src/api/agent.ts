import {
  agentCreateRequestSchema,
  agentEnrollmentRedeemRequestSchema,
  agentNameSchema
} from "@rollerskate/protocol";

import type { DeviceService } from "../modules/device/service.js";
import type { ApiRequest } from "./http.js";
import {
  bearerToken,
  matchPath,
  readJsonBody,
  writeJson
} from "./http.js";
import type { AgentService } from "../modules/agent/service.js";

export interface AgentApiDependencies {
  readonly agents: AgentService;
  readonly devices: DeviceService;
}

export async function handleAgentApi(
  context: ApiRequest,
  dependencies: AgentApiDependencies
): Promise<boolean> {
  const { request, response, url } = context;

  if (url.pathname === "/api/agents" && request.method === "POST") {
    const authentication = await dependencies.devices.authenticateDevice(bearerToken(request));
    const body = agentCreateRequestSchema.parse(await readJsonBody(request));
    writeJson(response, 201, await dependencies.agents.createAgent(authentication, body));
    return true;
  }

  if (url.pathname === "/api/agents" && request.method === "GET") {
    const authentication = await dependencies.devices.authenticateDevice(bearerToken(request));
    writeJson(response, 200, await dependencies.agents.listAgents(authentication));
    return true;
  }

  const agentByName = matchPath(url.pathname, /^\/api\/agents\/by-name\/([^/]+)$/);
  if (agentByName !== undefined && request.method === "GET") {
    const authentication = await dependencies.devices.authenticateDevice(bearerToken(request));
    writeJson(
      response,
      200,
      await dependencies.agents.getAgentByName(
        authentication,
        agentNameSchema.parse(agentByName)
      )
    );
    return true;
  }

  const redeemEnrollment = matchPath(
    url.pathname,
    /^\/api\/agent-enrollments\/([^/]+)\/redeem$/
  );
  if (redeemEnrollment !== undefined && request.method === "POST") {
    const authentication = await dependencies.devices.authenticateDevice(bearerToken(request));
    const body = agentEnrollmentRedeemRequestSchema.parse(await readJsonBody(request));
    writeJson(
      response,
      200,
      await dependencies.agents.redeemAgentEnrollment(
        authentication,
        redeemEnrollment,
        body.verifier
      )
    );
    return true;
  }

  const agentPrincipal = matchPath(url.pathname, /^\/api\/agent-principals\/([^/]+)$/);
  if (agentPrincipal !== undefined && request.method === "GET") {
    const authentication = await dependencies.agents.authenticateAgent(
      bearerToken(request),
      agentPrincipal
    );
    writeJson(response, 200, dependencies.agents.agentSummary(authentication));
    return true;
  }

  return false;
}
