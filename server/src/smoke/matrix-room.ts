#!/usr/bin/env node

import { once } from "node:events";

import { createBffServer } from "../bootstrap/http-server.js";
import type { OidcProvider } from "../modules/trust/oidc.js";
import { TrustService } from "../modules/trust/service.js";
import { AgentService } from "../modules/agent/service.js";
import { AgentRoomService } from "../application/room/agent-service.js";
import { DeviceLoginService } from "../application/device/login-service.js";
import { DeviceService } from "../modules/device/service.js";
import { RoomEventBroker } from "../modules/event/broker.js";
import { decodeCursor, EventService } from "../modules/event/service.js";
import { RoomService } from "../application/room/service.js";
import { createVerifier } from "../modules/shared/opaque-credential.js";
import { HttpMatrixApplicationServiceGateway } from "../adapter/matrix/application-service.js";
import { connectMysql, connectMysqlPool } from "../adapter/persistence/mysql/connection.js";
import { migrateServerDatabase } from "../adapter/persistence/mysql/migrations.js";
import { MysqlRepository } from "../adapter/persistence/mysql/repository.js";
import { credentialService } from "../adapter/security/credentials.js";

const MATRIX_WAIT_MILLISECONDS = 20_000;

async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const databaseUrl = required(environment, "ROLLERSKATE_DATABASE_URL");
  const homeserverUrl = required(environment, "ROLLERSKATE_MATRIX_HOMESERVER_URL");
  const serverName = required(environment, "ROLLERSKATE_MATRIX_SERVER_NAME");
  const asToken = required(environment, "ROLLERSKATE_MATRIX_AS_TOKEN");
  const hsToken = required(environment, "ROLLERSKATE_MATRIX_HS_TOKEN");
  const port = parsePort(environment.ROLLERSKATE_SERVER_PORT ?? "4100");

  await waitForMatrix(homeserverUrl);
  const migrationConnection = await connectMysql(databaseUrl);
  try {
    await migrateServerDatabase(migrationConnection);
  } finally {
    await migrationConnection.end();
  }

  const pool = connectMysqlPool(databaseUrl);
  const repository = new MysqlRepository(pool);
  const trust = new TrustService(repository, {
    issuer: "https://identity.rollerskate.test",
    publicUrl: `http://127.0.0.1:${port}`
  });
  const devices = new DeviceService(repository, {
    publicUrl: `http://127.0.0.1:${port}`,
    credentials: credentialService
  });
  const agents = new AgentService(repository, { credentials: credentialService });
  const matrix = new HttpMatrixApplicationServiceGateway({
    homeserverUrl,
    serverName,
    asToken
  });
  const rooms = new RoomService(repository, matrix);
  const agentRooms = new AgentRoomService(repository, matrix);
  const events = new EventService(repository, new RoomEventBroker());
  const oidc: OidcProvider = {
    authorizationUrl: async () => {
      throw new Error("OIDC is not used by the isolated Matrix smoke");
    },
    exchangeAuthorizationCode: async () => {
      throw new Error("OIDC is not used by the isolated Matrix smoke");
    },
    beginDeviceAuthorization: async () => {
      throw new Error("OIDC is not used by the isolated Matrix smoke");
    },
    pollDeviceAuthorization: async () => {
      throw new Error("OIDC is not used by the isolated Matrix smoke");
    }
  };
  const deviceLogin = new DeviceLoginService(repository, trust, oidc);
  const server = createBffServer({
    trust,
    devices,
    deviceLogin,
    agents,
    oidc,
    rooms,
    agentRooms,
    events,
    matrixHsToken: hsToken
  });

  server.listen(port, "0.0.0.0");
  await once(server, "listening");
  try {
    const owner = await createOwner(trust);
    const agent = await createAgent(devices, agents, owner.human);
    const room = await rooms.createRoom(owner.human, {
      name: `Phase 3 Matrix Gate ${Date.now()}`,
      visibility: "private"
    });
    await agentRooms.invite(owner.human, room.id, agent.authentication.agent.id);
    const sent = await agentRooms.sendMessage(agent.authentication, room.id, {
      transactionId: `matrix-gate-${Date.now()}`,
      body: "rollerskate phase 3 matrix correlation"
    });
    const readBack = await waitForReadBack(
      events,
      agent.authentication,
      room.id,
      room.head,
      sent.eventId
    );
    process.stdout.write(`${JSON.stringify({
      status: "ok",
      roomId: room.id,
      matrixRoomId: room.matrixRoomId,
      sentEventId: sent.eventId,
      projectedEventId: readBack.event.eventId,
      source: readBack.event.source,
      through: readBack.position
    })}\n`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error === undefined ? resolve() : reject(error)));
    await pool.end();
  }
}

async function createOwner(trust: TrustService) {
  const start = await trust.beginAuthorization("/");
  return trust.completeAuthorization(
    await trust.takeAuthorization(start.state),
    {
      issuer: "https://identity.rollerskate.test",
      subject: "matrix-gate-owner",
      displayName: "Matrix Gate Owner",
      metadata: {}
    }
  );
}

async function createAgent(
  devices: DeviceService,
  agents: AgentService,
  owner: Awaited<ReturnType<typeof createOwner>>["human"]
) {
  const deviceProof = createVerifier();
  const pairing = await devices.createPairing({
    deviceId: `matrix-gate-device-${Date.now()}`,
    deviceName: "Matrix Gate Device",
    verifierChallenge: deviceProof.challenge
  });
  await devices.approvePairing(pairing.pairingId, owner);
  const deviceIssuance = await devices.redeemPairing(
    pairing.pairingId,
    pairing.deviceId,
    deviceProof.verifier
  );
  const device = await devices.authenticateDevice(deviceIssuance.credential);
  const agentProof = createVerifier();
  const created = await agents.createAgent(device, {
    name: `matrix-gate-${Date.now().toString(36)}`,
    verifierChallenge: agentProof.challenge
  });
  const issuance = await agents.redeemAgentEnrollment(
    device,
    created.enrollment.id,
    agentProof.verifier
  );
  return {
    authentication: await agents.authenticateAgent(
      issuance.credential,
      created.agent.id
    )
  };
}

async function waitForReadBack(
  events: EventService,
  authentication: Parameters<EventService["head"]>[0],
  roomId: string,
  after: string,
  expectedEventId: string
) {
  const deadline = Date.now() + MATRIX_WAIT_MILLISECONDS;
  while (Date.now() < deadline) {
    const head = await events.head(authentication, roomId);
    if (decodeCursor(head.head, roomId) > decodeCursor(after, roomId)) {
      const page = await events.events(authentication, roomId, {
        after,
        through: head.head,
        limit: 100
      });
      const projection = page.events.find((event) => event.event.eventId === expectedEventId);
      if (projection !== undefined) {
        return projection;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Matrix event was not projected within ${MATRIX_WAIT_MILLISECONDS}ms`);
}

async function waitForMatrix(homeserverUrl: string): Promise<void> {
  const deadline = Date.now() + MATRIX_WAIT_MILLISECONDS;
  const versionsUrl = new URL("/_matrix/client/versions", homeserverUrl);
  while (Date.now() < deadline) {
    try {
      const response = await fetch(versionsUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // The isolated homeserver is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Matrix homeserver did not become ready within ${MATRIX_WAIT_MILLISECONDS}ms`);
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ROLLERSKATE_SERVER_PORT must be from 1 to 65535");
  }
  return port;
}

await main();
