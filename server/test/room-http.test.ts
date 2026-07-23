import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import type { RoomVisibility } from "@rollerskate/protocol";

import { createBffServer } from "../src/bootstrap/http-server.js";
import { MemoryRepository } from "../src/adapter/persistence/memory/repository.js";
import { createVerifier } from "../src/modules/shared/opaque-credential.js";
import type { MatrixApplicationServiceGateway } from "../src/adapter/matrix/application-service.js";
import type { WebOidcProvider } from "../src/adapter/oidc/client.js";
import { AgentRoomService } from "../src/application/room/agent-service.js";
import { RoomEventBroker } from "../src/modules/event/broker.js";
import { EventService } from "../src/modules/event/service.js";
import { RoomService } from "../src/application/room/service.js";
import { createTestServices } from "./support/services.js";

class HttpTestMatrix implements MatrixApplicationServiceGateway {
  public readonly serverName = "matrix.example.com";

  public mxidFor(kind: "human" | "agent", id: string): string {
    return `@${kind}-${id}:${this.serverName}`;
  }
  public async ensurePrincipal(): Promise<void> {}
  public async createRoom(_input: {
    readonly creatorMxid: string;
    readonly name: string;
    readonly visibility: RoomVisibility;
  }): Promise<string> {
    return "!http-room:matrix.example.com";
  }
  public async invite(): Promise<void> {}
  public async join(): Promise<void> {}
  public async leave(): Promise<void> {}
  public async sendMessage(): Promise<string> {
    return "$sent";
  }
}

test("Room HTTP APIs enforce Human Device, Agent binding and Matrix HS authentication", async () => {
  const repository = new MemoryRepository();
  let publicUrl = "http://127.0.0.1";
  const services = createTestServices(repository, {
    issuer: "https://identity.example.com",
    publicUrl
  });
  const start = await services.trust.beginAuthorization("/");
  const owner = await services.trust.completeAuthorization(
    await services.trust.takeAuthorization(start.state),
    {
      issuer: "https://identity.example.com",
      subject: "owner",
      displayName: "Owner",
      metadata: {}
    }
  );
  const deviceProof = createVerifier();
  const pairing = await services.devices.createPairing({
    deviceId: "http-room-device",
    deviceName: "HTTP Room Device",
    verifierChallenge: deviceProof.challenge
  });
  await services.devices.approvePairing(pairing.pairingId, owner.human);
  const deviceIssuance = await services.devices.redeemPairing(
    pairing.pairingId,
    "http-room-device",
    deviceProof.verifier
  );
  const device = await services.devices.authenticateDevice(deviceIssuance.credential);
  const agentProof = createVerifier();
  const created = await services.agents.createAgent(device, {
    name: "http-room-agent",
    verifierChallenge: agentProof.challenge
  });
  const agentIssuance = await services.agents.redeemAgentEnrollment(
    device,
    created.enrollment.id,
    agentProof.verifier
  );
  const matrix = new HttpTestMatrix();
  const rooms = new RoomService(repository, matrix);
  const agentRooms = new AgentRoomService(repository, matrix);
  const events = new EventService(repository, new RoomEventBroker());
  const oidc: WebOidcProvider = {
    authorizationUrl: async () => "https://identity.example.com/authorize",
    exchangeAuthorizationCode: async () => {
      throw new Error("unused");
    }
  };
  const server = createBffServer({
    ...services,
    oidc,
    rooms,
    agentRooms,
    events,
    matrixHsToken: "hs-secret"
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    publicUrl = `http://127.0.0.1:${address.port}`;
    const deviceAuthorization = `Bearer ${deviceIssuance.credential}`;
    const create = await fetch(`${publicUrl}/api/rooms`, {
      method: "POST",
      headers: { authorization: deviceAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ name: "HTTP Room", visibility: "private" })
    });
    assert.equal(create.status, 201);
    const room = await create.json() as { id: string; matrixRoomId: string };
    const humanMessage = await fetch(`${publicUrl}/api/rooms/${room.id}/messages`, {
      method: "POST",
      headers: { authorization: deviceAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ transactionId: "human-message-1", body: "hello from owner" })
    });
    assert.equal(humanMessage.status, 200);
    const invite = await fetch(`${publicUrl}/api/rooms/${room.id}/agents`, {
      method: "POST",
      headers: { authorization: deviceAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ agentId: created.agent.id })
    });
    assert.equal(invite.status, 201);
    const bindings = await fetch(
      `${publicUrl}/api/agent-principals/${created.agent.id}/rooms`,
      { headers: { authorization: `Bearer ${agentIssuance.credential}` } }
    );
    assert.equal(bindings.status, 200);
    assert.deepEqual(
      (await bindings.json() as readonly { roomId: string }[]).map((binding) => binding.roomId),
      [room.id]
    );

    const transactionUrl = `${publicUrl}/_matrix/app/v1/transactions/txn-http`;
    const transactionBody = JSON.stringify({
      events: [{
        event_id: "$http-event",
        room_id: room.matrixRoomId,
        sender: "@human:matrix.example.com",
        type: "m.room.message",
        origin_server_ts: Date.now(),
        content: { msgtype: "m.text", body: "hello" }
      }]
    });
    const denied = await fetch(transactionUrl, {
      method: "PUT",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: transactionBody
    });
    assert.equal(denied.status, 401);
    const accepted = await fetch(transactionUrl, {
      method: "PUT",
      headers: { authorization: "Bearer hs-secret", "content-type": "application/json" },
      body: transactionBody
    });
    assert.equal(accepted.status, 200);

    const events = await fetch(
      `${publicUrl}/api/agent-principals/${created.agent.id}/rooms/${room.id}/events`,
      { headers: { authorization: `Bearer ${agentIssuance.credential}` } }
    );
    assert.equal(events.status, 200);
    assert.deepEqual(
      (await events.json() as { events: readonly { event: { eventId: string } }[] })
        .events.map((event) => event.event.eventId),
      ["$http-event"]
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});
