import assert from "node:assert/strict";
import test from "node:test";

import type { RoomVisibility } from "@rollerskate/protocol";

import type { AgentAuthenticationRecord, HumanRecord } from "../src/application/model.js";
import { MemoryRepository } from "../src/adapter/persistence/memory/repository.js";
import { ServerError } from "../src/modules/shared/error.js";
import { createVerifier } from "../src/modules/shared/opaque-credential.js";
import type { MatrixApplicationServiceGateway } from "../src/adapter/matrix/application-service.js";
import { AgentRoomService } from "../src/application/room/agent-service.js";
import { RoomEventBroker } from "../src/modules/event/broker.js";
import { decodeCursor, EventService } from "../src/modules/event/service.js";
import { RoomService } from "../src/application/room/service.js";
import { createTestServices, type TestServices } from "./support/services.js";

const NOW = "2026-07-20T08:00:00.000Z";
const ISSUER = "https://identity.example.com";

class FakeMatrixGateway implements MatrixApplicationServiceGateway {
  public readonly serverName = "matrix.example.com";
  public readonly calls: string[] = [];
  #room = 0;
  #event = 0;

  public mxidFor(kind: "human" | "agent", id: string): string {
    return `@${kind}-${id}:${this.serverName}`;
  }

  public async ensurePrincipal(mxid: string, _displayName: string): Promise<void> {
    this.calls.push(`ensure:${mxid}`);
  }

  public async createRoom(input: {
    readonly creatorMxid: string;
    readonly name: string;
    readonly visibility: RoomVisibility;
  }): Promise<string> {
    this.calls.push(`create:${input.creatorMxid}:${input.visibility}`);
    this.#room += 1;
    return `!room-${this.#room}:${this.serverName}`;
  }

  public async invite(roomId: string, actorMxid: string, inviteeMxid: string): Promise<void> {
    this.calls.push(`invite:${roomId}:${actorMxid}:${inviteeMxid}`);
  }

  public async join(roomId: string, mxid: string): Promise<void> {
    this.calls.push(`join:${roomId}:${mxid}`);
  }

  public async leave(roomId: string, mxid: string): Promise<void> {
    this.calls.push(`leave:${roomId}:${mxid}`);
  }

  public async sendMessage(input: {
    readonly roomId: string;
    readonly senderMxid: string;
    readonly transactionId: string;
    readonly body: string;
  }): Promise<string> {
    this.calls.push(`send:${input.roomId}:${input.senderMxid}:${input.transactionId}`);
    this.#event += 1;
    return `$sent-${this.#event}`;
  }
}

async function fixture(): Promise<{
  readonly repository: MemoryRepository;
  readonly rooms: RoomService;
  readonly agentRooms: AgentRoomService;
  readonly events: EventService;
  readonly matrix: FakeMatrixGateway;
  readonly owner: HumanRecord;
  readonly member: HumanRecord;
  readonly alice: AgentAuthenticationRecord;
  readonly bob: AgentAuthenticationRecord;
  readonly charlie: AgentAuthenticationRecord;
}> {
  const repository = new MemoryRepository();
  const services = createTestServices(repository, {
    issuer: ISSUER,
    publicUrl: "https://rollerskate.example.com",
    now: () => new Date(NOW)
  });
  const owner = (await authorize(services, "owner")).human;
  await services.trust.allowSubject(owner, "member");
  const member = (await authorize(services, "member")).human;
  const deviceProof = createVerifier();
  const pairing = await services.devices.createPairing({
    deviceId: "room-device",
    deviceName: "Room Device",
    verifierChallenge: deviceProof.challenge
  });
  await services.devices.approvePairing(pairing.pairingId, owner);
  const deviceIssuance = await services.devices.redeemPairing(
    pairing.pairingId,
    "room-device",
    deviceProof.verifier
  );
  const device = await services.devices.authenticateDevice(deviceIssuance.credential);
  const alice = await createAgent(services, device, "alice");
  const bob = await createAgent(services, device, "bob");
  const memberDeviceProof = createVerifier();
  const memberPairing = await services.devices.createPairing({
    deviceId: "room-member-device",
    deviceName: "Room Member Device",
    verifierChallenge: memberDeviceProof.challenge
  });
  await services.devices.approvePairing(memberPairing.pairingId, member);
  const memberDeviceIssuance = await services.devices.redeemPairing(
    memberPairing.pairingId,
    "room-member-device",
    memberDeviceProof.verifier
  );
  const memberDevice = await services.devices.authenticateDevice(memberDeviceIssuance.credential);
  const charlie = await createAgent(services, memberDevice, "charlie");
  const matrix = new FakeMatrixGateway();
  const broker = new RoomEventBroker();
  return {
    repository,
    rooms: new RoomService(repository, matrix, {
      now: () => new Date(NOW)
    }),
    agentRooms: new AgentRoomService(repository, matrix, { now: () => new Date(NOW) }),
    events: new EventService(repository, broker, { now: () => new Date(NOW) }),
    matrix,
    owner,
    member,
    alice,
    bob,
    charlie
  };
}

test("private Room membership and Agent binding are separate authorization facts", async () => {
  const { rooms, agentRooms, events, owner, member, alice, charlie } = await fixture();
  const room = await rooms.createRoom(owner, { name: "Private", visibility: "private" });

  await expectError(() => rooms.joinRoom(member, room.id), "room_invitation_required");
  assert.deepEqual(await rooms.listRooms(member), []);
  const invitation = await rooms.inviteHuman(owner, room.id, { humanId: member.id });
  assert.equal(invitation.membership?.status, "invited");
  assert.equal((await rooms.listRooms(member))[0]?.id, room.id);
  await expectError(
    () => agentRooms.invite(member, room.id, charlie.agent.id),
    "room_membership_required"
  );
  assert.equal((await rooms.joinRoom(member, room.id)).membership?.status, "active");
  await expectError(() => events.head(alice, room.id), "room_binding_required");

  const memberBinding = await agentRooms.invite(member, room.id, charlie.agent.id);
  assert.equal(memberBinding.agentId, charlie.agent.id);
  await expectError(
    () => agentRooms.invite(member, room.id, alice.agent.id),
    "forbidden"
  );

  const binding = await agentRooms.invite(owner, room.id, alice.agent.id);
  assert.equal(binding.wakeMode, "mention_only");
  assert.equal((await events.head(alice, room.id)).head, room.head);

  await expectError(
    () => agentRooms.updateWakeMode(member, room.id, alice.agent.id, { wakeMode: "proactive" }),
    "forbidden"
  );
  await agentRooms.leave(owner, room.id, alice.agent.id);
  await expectError(() => events.head(alice, room.id), "room_binding_required");
});

test("Matrix event replay is idempotent even when a transaction id is reused", async () => {
  const { rooms, agentRooms, events, matrix, owner, alice, bob } = await fixture();
  const room = await rooms.createRoom(owner, { name: "Ops", visibility: "public" });
  await agentRooms.invite(owner, room.id, alice.agent.id);
  await agentRooms.invite(owner, room.id, bob.agent.id);
  await agentRooms.updateWakeMode(owner, room.id, alice.agent.id, { wakeMode: "proactive" });

  const aliceEvents: unknown[] = [];
  const bobEvents: unknown[] = [];
  const stopAlice = await events.subscribe(alice, room.id, (event) => aliceEvents.push(event));
  const stopBob = await events.subscribe(bob, room.id, (event) => bobEvents.push(event));
  const bobMxid = matrix.mxidFor("agent", bob.agent.id);
  const transaction = matrixTransaction(room.matrixRoomId, "$event-1", bobMxid);
  await events.ingestMatrixTransaction("txn-1", transaction);
  await events.ingestMatrixTransaction("txn-1", transaction);
  await events.ingestMatrixTransaction(
    "txn-1",
    matrixTransaction(room.matrixRoomId, "$event-2", bobMxid)
  );

  assert.equal(aliceEvents.length, 2);
  assert.equal(bobEvents.length, 2);
  assert.equal(decodeCursor((await events.head(alice, room.id)).head, room.id), 2);
  stopAlice();
  stopBob();
});

test("bounded snapshot recovery excludes events beyond through and stream has no backlog", async () => {
  const { rooms, agentRooms, events, owner, alice } = await fixture();
  const room = await rooms.createRoom(owner, { name: "Recovery", visibility: "public" });
  await agentRooms.invite(owner, room.id, alice.agent.id);
  await agentRooms.updateWakeMode(owner, room.id, alice.agent.id, { wakeMode: "proactive" });

  await events.ingestMatrixTransaction(
    "txn-1",
    matrixTransaction(room.matrixRoomId, "$event-1", "@human:matrix.example.com")
  );
  const snapshot = (await events.head(alice, room.id)).head;
  await events.ingestMatrixTransaction(
    "txn-2",
    matrixTransaction(room.matrixRoomId, "$event-2", "@human:matrix.example.com")
  );

  const page = await events.events(alice, room.id, { through: snapshot, limit: 1 });
  assert.deepEqual(page.events.map((event) => event.event.eventId), ["$event-1"]);
  assert.equal(page.complete, true);

  const live: unknown[] = [];
  const stop = await events.subscribe(alice, room.id, (event) => live.push(event));
  assert.equal(live.length, 0);
  await events.ingestMatrixTransaction(
    "txn-3",
    matrixTransaction(room.matrixRoomId, "$event-3", "@human:matrix.example.com")
  );
  assert.equal(live.length, 1);
  stop();

  const sent = await agentRooms.sendMessage(alice, room.id, {
    transactionId: "agent-send-1",
    body: "done"
  });
  assert.equal(sent.eventId, "$sent-1");
});

async function authorize(services: TestServices, subject: string) {
  const start = await services.trust.beginAuthorization("/");
  return services.trust.completeAuthorization(
    await services.trust.takeAuthorization(start.state),
    {
      issuer: ISSUER,
      subject,
      displayName: subject,
      metadata: {}
    }
  );
}

async function createAgent(
  services: TestServices,
  device: Awaited<ReturnType<TestServices["devices"]["authenticateDevice"]>>,
  name: string
): Promise<AgentAuthenticationRecord> {
  const proof = createVerifier();
  const created = await services.agents.createAgent(device, {
    name,
    verifierChallenge: proof.challenge
  });
  const issuance = await services.agents.redeemAgentEnrollment(
    device,
    created.enrollment.id,
    proof.verifier
  );
  return services.agents.authenticateAgent(issuance.credential, created.agent.id);
}

function matrixTransaction(roomId: string, eventId: string, mentionedMxid: string) {
  return {
    events: [{
      event_id: eventId,
      room_id: roomId,
      sender: "@human:matrix.example.com",
      type: "m.room.message",
      origin_server_ts: Date.parse(NOW),
      content: {
        msgtype: "m.text",
        body: "hello",
        "m.mentions": { user_ids: [mentionedMxid] }
      }
    }]
  };
}

async function expectError(operation: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) =>
    error instanceof ServerError && error.code === code
  );
}
