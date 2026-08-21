import { createServer, type Server, type ServerResponse } from "node:http";

import { eventEnvelopeSchema } from "@rollerskate/protocol";
import { ZodError } from "zod";

import { handleTrustApi, type TrustApiDependencies } from "../api/trust.js";
import { handleAgentApi, type AgentApiDependencies } from "../api/agent.js";
import { handleDeviceApi, type DeviceApiDependencies } from "../api/device.js";
import { handleRoomApi, type RoomApiDependencies } from "../api/room.js";
import {
  handleProfileTopicApi,
  type ProfileTopicApiDependencies
} from "../api/profile-topic.js";
import { handleConnectorApi, type ConnectorApiDependencies } from "../api/connector.js";
import {
  handleWorkRequestApi,
  type WorkRequestApiDependencies
} from "../api/work-request.js";
import { ServerError } from "../modules/shared/error.js";
import { writeJson } from "../api/http.js";

export interface BffDependencies
extends TrustApiDependencies,
  AgentApiDependencies,
  DeviceApiDependencies,
  RoomApiDependencies,
  ProfileTopicApiDependencies,
  ConnectorApiDependencies,
  WorkRequestApiDependencies {}

export function createBffServer(dependencies?: BffDependencies): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, dependencies).catch((error: unknown) => {
      writeError(response, error);
    });
  });
}

async function handleRequest(
  request: Parameters<typeof handleTrustApi>[0]["request"],
  response: ServerResponse,
  dependencies: BffDependencies | undefined
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://server.invalid");
  if (request.method === "GET" && url.pathname === "/healthz") {
    writeJson(response, 200, {
      status: "ok",
      service: "rollerskate-server",
      protocolVersion: eventEnvelopeSchema.shape.protocolVersion.value
    });
    return;
  }
  if (dependencies === undefined) {
    writeJson(response, 503, { error: "control_plane_not_configured" });
    return;
  }

  const context = { request, response, url };
  if (
    await handleTrustApi(context, dependencies) ||
    await handleDeviceApi(context, dependencies) ||
    await handleAgentApi(context, dependencies) ||
    await handleProfileTopicApi(context, dependencies) ||
    await handleConnectorApi(context, dependencies) ||
    await handleWorkRequestApi(context, dependencies) ||
    await handleRoomApi(context, dependencies)
  ) {
    return;
  }
  writeJson(response, 404, { error: "not_found" });
}

function writeError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }
  if (error instanceof ServerError) {
    writeJson(response, error.status, { error: error.code, message: error.message });
    return;
  }
  if (error instanceof ZodError) {
    writeJson(response, 400, { error: "invalid_request" });
    return;
  }
  process.stderr.write(
    `request failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  writeJson(response, 500, { error: "internal_error" });
}
