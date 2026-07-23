import type { IncomingMessage } from "node:http";

import {
  agentRoomWakeModeUpdateSchema,
  matrixApplicationServiceTransactionSchema,
  roomAgentInviteRequestSchema,
  roomCreateRequestSchema,
  roomHumanInviteRequestSchema,
  roomMessageSendRequestSchema
} from "@rollerskate/protocol";

import type { TrustService } from "../modules/trust/service.js";
import type { AgentService } from "../modules/agent/service.js";
import type { AgentRoomService } from "../application/room/agent-service.js";
import type { DeviceService } from "../modules/device/service.js";
import type { EventService } from "../modules/event/service.js";
import { ServerError } from "../modules/shared/error.js";
import type { HumanRecord } from "../modules/trust/model.js";
import type { ApiRequest } from "./http.js";
import {
  assertBearerToken,
  assertSameOrigin,
  bearerToken,
  matchPath,
  matchPath2,
  matchPath3,
  readJsonBody,
  requireQuery,
  sessionToken,
  writeJson
} from "./http.js";
import type { RoomService } from "../application/room/service.js";

export interface RoomApiDependencies {
  readonly trust: TrustService;
  readonly agents: AgentService;
  readonly devices: DeviceService;
  readonly rooms?: RoomService;
  readonly agentRooms?: AgentRoomService;
  readonly events?: EventService;
  readonly matrixHsToken?: string;
}

export async function handleRoomApi(
  context: ApiRequest,
  dependencies: RoomApiDependencies
): Promise<boolean> {
  const { request, response, url } = context;

  if (request.method === "POST" && url.pathname === "/api/rooms") {
    const rooms = requireRooms(dependencies);
    assertSameOrigin(request, dependencies.trust.publicUrl);
    const human = await authenticateRoomHuman(request, dependencies);
    const body = roomCreateRequestSchema.parse(await readJsonBody(request));
    writeJson(response, 201, await rooms.createRoom(human, body));
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/rooms") {
    const rooms = requireRooms(dependencies);
    const human = await authenticateRoomHuman(request, dependencies);
    writeJson(response, 200, await rooms.listRooms(human));
    return true;
  }

  const joinRoom = matchPath(url.pathname, /^\/api\/rooms\/([^/]+)\/join$/);
  if (joinRoom !== undefined && request.method === "POST") {
    const rooms = requireRooms(dependencies);
    assertSameOrigin(request, dependencies.trust.publicUrl);
    const human = await authenticateRoomHuman(request, dependencies);
    writeJson(response, 200, await rooms.joinRoom(human, joinRoom));
    return true;
  }

  const inviteAgent = matchPath(url.pathname, /^\/api\/rooms\/([^/]+)\/agents$/);
  if (inviteAgent !== undefined && request.method === "POST") {
    const agentRooms = requireAgentRooms(dependencies);
    assertSameOrigin(request, dependencies.trust.publicUrl);
    const human = await authenticateRoomHuman(request, dependencies);
    const body = roomAgentInviteRequestSchema.parse(await readJsonBody(request));
    writeJson(response, 201, await agentRooms.invite(human, inviteAgent, body.agentId));
    return true;
  }

  const inviteHuman = matchPath(url.pathname, /^\/api\/rooms\/([^/]+)\/members$/);
  if (inviteHuman !== undefined && request.method === "POST") {
    const rooms = requireRooms(dependencies);
    assertSameOrigin(request, dependencies.trust.publicUrl);
    const human = await authenticateRoomHuman(request, dependencies);
    const body = roomHumanInviteRequestSchema.parse(await readJsonBody(request));
    writeJson(response, 201, await rooms.inviteHuman(human, inviteHuman, body));
    return true;
  }

  const roomAgent = matchPath2(url.pathname, /^\/api\/rooms\/([^/]+)\/agents\/([^/]+)$/);
  if (roomAgent !== undefined && request.method === "PATCH") {
    const agentRooms = requireAgentRooms(dependencies);
    assertSameOrigin(request, dependencies.trust.publicUrl);
    const human = await authenticateRoomHuman(request, dependencies);
    const body = agentRoomWakeModeUpdateSchema.parse(await readJsonBody(request));
    writeJson(
      response,
      200,
      await agentRooms.updateWakeMode(human, roomAgent[0], roomAgent[1], body)
    );
    return true;
  }

  if (roomAgent !== undefined && request.method === "DELETE") {
    const agentRooms = requireAgentRooms(dependencies);
    assertSameOrigin(request, dependencies.trust.publicUrl);
    const human = await authenticateRoomHuman(request, dependencies);
    await agentRooms.leave(human, roomAgent[0], roomAgent[1]);
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return true;
  }

  const humanRoomMessages = matchPath(url.pathname, /^\/api\/rooms\/([^/]+)\/messages$/);
  if (humanRoomMessages !== undefined && request.method === "POST") {
    const rooms = requireRooms(dependencies);
    assertSameOrigin(request, dependencies.trust.publicUrl);
    const human = await authenticateRoomHuman(request, dependencies);
    const body = roomMessageSendRequestSchema.parse(await readJsonBody(request));
    writeJson(response, 200, await rooms.sendHumanMessage(human, humanRoomMessages, body));
    return true;
  }

  const agentRoomsPath = matchPath(url.pathname, /^\/api\/agent-principals\/([^/]+)\/rooms$/);
  if (agentRoomsPath !== undefined && request.method === "GET") {
    const agentRooms = requireAgentRooms(dependencies);
    const authentication = await dependencies.agents.authenticateAgent(
      bearerToken(request),
      agentRoomsPath
    );
    writeJson(response, 200, await agentRooms.list(authentication));
    return true;
  }

  const agentRoomAction = matchPath3(
    url.pathname,
    /^\/api\/agent-principals\/([^/]+)\/rooms\/([^/]+)\/(head|events|stream|messages)$/
  );
  if (agentRoomAction !== undefined) {
    const agentRooms = requireAgentRooms(dependencies);
    const events = requireEvents(dependencies);
    const [agentId, roomId, action] = agentRoomAction;
    const authentication = await dependencies.agents.authenticateAgent(
      bearerToken(request),
      agentId
    );
    if (request.method === "GET" && action === "head") {
      writeJson(response, 200, await events.head(authentication, roomId));
      return true;
    }
    if (request.method === "GET" && action === "events") {
      writeJson(response, 200, await events.events(authentication, roomId, {
        ...(url.searchParams.has("after") ? { after: requireQuery(url, "after") } : {}),
        ...(url.searchParams.has("through") ? { through: requireQuery(url, "through") } : {}),
        ...(url.searchParams.has("limit")
          ? { limit: Number(requireQuery(url, "limit")) }
          : {})
      }));
      return true;
    }
    if (request.method === "GET" && action === "stream") {
      await events.head(authentication, roomId);
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });
      response.write(": connected\n\n");
      const unsubscribe = await events.subscribe(authentication, roomId, (event) => {
        response.write(`event: room_event\ndata: ${JSON.stringify(event)}\n\n`);
      });
      request.once("close", unsubscribe);
      return true;
    }
    if (request.method === "POST" && action === "messages") {
      const body = roomMessageSendRequestSchema.parse(await readJsonBody(request));
      writeJson(response, 200, await agentRooms.sendMessage(authentication, roomId, body));
      return true;
    }
  }

  const matrixTransaction = matchPath(
    url.pathname,
    /^\/_matrix\/app\/v1\/transactions\/([^/]+)$/
  );
  if (matrixTransaction !== undefined && request.method === "PUT") {
    const events = requireEvents(dependencies);
    assertBearerToken(request, dependencies.matrixHsToken);
    const body = matrixApplicationServiceTransactionSchema.parse(await readJsonBody(request));
    await events.ingestMatrixTransaction(matrixTransaction, body);
    writeJson(response, 200, {});
    return true;
  }

  return false;
}

async function authenticateRoomHuman(
  request: IncomingMessage,
  dependencies: RoomApiDependencies
): Promise<HumanRecord> {
  const bearer = bearerToken(request);
  if (bearer !== undefined) {
    return (await dependencies.devices.authenticateDevice(bearer)).human;
  }
  return dependencies.trust.authenticateSession(sessionToken(request));
}

function requireRooms(dependencies: RoomApiDependencies): RoomService {
  if (dependencies.rooms === undefined) {
    throw new ServerError("rooms_not_configured", 503, "Room service is not configured");
  }
  return dependencies.rooms;
}

function requireAgentRooms(dependencies: RoomApiDependencies): AgentRoomService {
  if (dependencies.agentRooms === undefined) {
    throw new ServerError("agent_rooms_not_configured", 503, "Agent Room service is not configured");
  }
  return dependencies.agentRooms;
}

function requireEvents(dependencies: RoomApiDependencies): EventService {
  if (dependencies.events === undefined) {
    throw new ServerError("events_not_configured", 503, "Event service is not configured");
  }
  return dependencies.events;
}
