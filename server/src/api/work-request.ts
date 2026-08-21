import {
  agentWorkRequestCreateSchema,
  agentWorkRequestDecisionSchema,
  agentWorkRequestResultSubmitSchema,
  agentWorkRequestRunAttachSchema,
  agentWorkRequestWithdrawSchema,
  workRequestRouteLeaseSchema
} from "@rollerskate/protocol";

import type { AgentService } from "../modules/agent/service.js";
import type { DeviceService } from "../modules/device/service.js";
import { ServerError } from "../modules/shared/error.js";
import type { WorkRequestService } from "../modules/work-request/service.js";
import type { ApiRequest } from "./http.js";
import { bearerToken, matchPath, readJsonBody, requireQuery, writeJson } from "./http.js";

export interface WorkRequestApiDependencies {
  readonly agents: AgentService;
  readonly devices: DeviceService;
  readonly workRequests?: WorkRequestService;
}

export async function handleWorkRequestApi(
  context: ApiRequest,
  dependencies: WorkRequestApiDependencies
): Promise<boolean> {
  const { request, response, url } = context;
  const service = (): WorkRequestService => {
    if (dependencies.workRequests === undefined) {
      throw new ServerError("work_requests_not_configured", 503,
        "Agent work request service is not configured");
    }
    return dependencies.workRequests;
  };

  if (url.pathname === "/api/work-requests" && request.method === "POST") {
    const authentication = await dependencies.devices.authenticateDevice(bearerToken(request));
    const body = agentWorkRequestCreateSchema.parse(await readJsonBody(request));
    const result = await service().create({ kind: "human", id: authentication.human.id }, body);
    writeJson(response, result.created ? 201 : 200, result);
    return true;
  }
  const humanRequest = matchPath(url.pathname, /^\/api\/work-requests\/([^/]+)$/);
  if (humanRequest !== undefined && request.method === "GET") {
    const authentication = await dependencies.devices.authenticateDevice(bearerToken(request));
    writeJson(response, 200, await service().get(
      { kind: "human", id: authentication.human.id },
      humanRequest
    ));
    return true;
  }
  const humanWithdraw = matchPath(
    url.pathname,
    /^\/api\/work-requests\/([^/]+)\/withdraw$/
  );
  if (humanWithdraw !== undefined && request.method === "POST") {
    const authentication = await dependencies.devices.authenticateDevice(bearerToken(request));
    const body = agentWorkRequestWithdrawSchema.parse(await readJsonBody(request));
    writeJson(response, 200, await service().withdraw(
      { kind: "human", id: authentication.human.id },
      humanWithdraw,
      body
    ));
    return true;
  }

  const routeAgentId = matchPath(
    url.pathname,
    /^\/api\/agent-principals\/([^/]+)\/work-request-route$/
  );
  if (routeAgentId !== undefined && request.method === "PUT") {
    await dependencies.agents.authenticateAgent(bearerToken(request), routeAgentId);
    const body = workRequestRouteLeaseSchema.parse(await readJsonBody(request));
    writeJson(response, 200, service().registerRoute(routeAgentId, body));
    return true;
  }

  const agentCollection = matchPath(
    url.pathname,
    /^\/api\/agent-principals\/([^/]+)\/work-requests$/
  );
  if (agentCollection !== undefined) {
    await dependencies.agents.authenticateAgent(bearerToken(request), agentCollection);
    if (request.method === "POST") {
      const body = agentWorkRequestCreateSchema.parse(await readJsonBody(request));
      const result = await service().create({ kind: "agent", id: agentCollection }, body);
      writeJson(response, result.created ? 201 : 200, result);
      return true;
    }
    if (request.method === "GET") {
      const limit = url.searchParams.has("limit")
        ? Number(requireQuery(url, "limit"))
        : 20;
      if (url.searchParams.get("state") === "accepted-without-run") {
        writeJson(response, 200, await service().acceptedWithoutRun(agentCollection, limit));
      } else {
        writeJson(response, 200, await service().routed(
          agentCollection,
          requireQuery(url, "routeId"),
          limit
        ));
      }
      return true;
    }
  }

  const agentRequest = matchAgentRequest(url.pathname);
  if (agentRequest !== undefined) {
    const [agentId, workRequestId, action] = agentRequest;
    await dependencies.agents.authenticateAgent(bearerToken(request), agentId);
    if (request.method === "GET" && action === undefined) {
      writeJson(response, 200, await service().get(
        { kind: "agent", id: agentId },
        workRequestId
      ));
      return true;
    }
    if (request.method === "POST" && action === "withdraw") {
      const body = agentWorkRequestWithdrawSchema.parse(await readJsonBody(request));
      writeJson(response, 200, await service().withdraw(
        { kind: "agent", id: agentId },
        workRequestId,
        body
      ));
      return true;
    }
    if (request.method === "PUT" && action === "decision") {
      const body = agentWorkRequestDecisionSchema.parse(await readJsonBody(request));
      writeJson(response, 200, await service().decide(agentId, workRequestId, body));
      return true;
    }
    if (request.method === "PUT" && action === "run") {
      const body = agentWorkRequestRunAttachSchema.parse(await readJsonBody(request));
      writeJson(response, 200, await service().attachRun(agentId, workRequestId, body));
      return true;
    }
    if (request.method === "PUT" && action === "result") {
      const body = agentWorkRequestResultSubmitSchema.parse(await readJsonBody(request));
      writeJson(response, 200, await service().complete(agentId, workRequestId, body));
      return true;
    }
  }
  return false;
}

function matchAgentRequest(
  pathname: string
): readonly [string, string] | readonly [string, string, string] | undefined {
  const match = /^\/api\/agent-principals\/([^/]+)\/work-requests\/([^/]+)(?:\/(withdraw|decision|run|result))?$/.exec(
    pathname
  );
  if (match === null) return undefined;
  const values = [decodeURIComponent(match[1]!), decodeURIComponent(match[2]!)] as const;
  return match[3] === undefined ? values : [...values, match[3]];
}
