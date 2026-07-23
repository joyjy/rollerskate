import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runtimePaths } from "../src/application/runtime-config.js";
import {
  addAgentToRoom,
  allowAdmissionSubject,
  configureRoomPolicy,
  createRoom,
  listAgentRoomBindings,
  roomHistory,
  sendAgentRoomMessage,
  sendRoomMessage
} from "../src/application/room-control.js";

const now = "2026-07-20T00:00:00.000Z";
const roomId = "room-1";
const roomHead = `r1.${Buffer.from(JSON.stringify([roomId, 1])).toString("base64url")}`;

test("Room operations use the selected runtime and keep Device and Agent authority separate", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-room-operations-repo-"));
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-room-operations-runtime-"));
  try {
    seedCredentials(repo, runtime);
    const requests: Array<{ url: URL; authorization: string; body?: unknown }> = [];
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        authorization: headers.get("authorization") ?? "",
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) })
      });
      if (url.pathname === "/api/rooms" && init?.method === "POST") {
        return Response.json(room(), { status: 201 });
      }
      if (url.pathname === "/api/admin/allowlist") {
        return Response.json({ issuer: "https://identity.example", subject: "new-human" }, {
          status: 201
        });
      }
      if (url.pathname.endsWith("/agents") && init?.method === "POST") {
        return Response.json(binding(), { status: 201 });
      }
      if (url.pathname.endsWith("/rooms")) return Response.json([binding()]);
      if (url.pathname.endsWith("/messages")) {
        const body = requests.at(-1)?.body as { transactionId: string };
        return Response.json({ eventId: "$sent", transactionId: body.transactionId });
      }
      if (url.pathname.endsWith("/head")) return Response.json({ roomId, head: roomHead });
      if (url.pathname.endsWith("/events")) {
        return Response.json({
          roomId,
          through: roomHead,
          events: [{
            roomId,
            position: roomHead,
            event: {
              protocolVersion: 1,
              eventId: "$one",
              type: "m.room.message",
              occurredAt: now,
              source: { kind: "human", id: "human-1" },
              payload: { body: "hello" }
            }
          }],
          complete: true
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    };
    const dependencies = { runtimeDirectory: runtime, fetch: fetchImplementation };
    await allowAdmissionSubject(repo, "new-human", dependencies);
    assert.equal((await createRoom(repo, "Team", "private", dependencies)).id, roomId);
    assert.equal((await addAgentToRoom(repo, roomId, "alice", dependencies)).agentId, "agent-1");
    assert.equal((await listAgentRoomBindings(repo, "alice", dependencies)).length, 1);
    assert.equal((await sendRoomMessage(repo, roomId, "hello", dependencies)).eventId, "$sent");
    assert.equal((await sendAgentRoomMessage(
      repo,
      roomId,
      "alice",
      "agent hello",
      dependencies
    )).eventId, "$sent");
    assert.equal((await roomHistory(repo, roomId, "alice", 10, dependencies))[0]?.event.eventId, "$one");

    assert.equal(requests[0]?.authorization, "Bearer device-secret");
    assert.equal(requests[1]?.authorization, "Bearer device-secret");
    assert.equal(requests[2]?.authorization, "Bearer device-secret");
    assert.equal(requests[3]?.authorization, "Bearer agent-secret");
    assert.equal(requests[4]?.authorization, "Bearer device-secret");
    assert.equal(requests[5]?.authorization, "Bearer agent-secret");
    assert.equal(runtimePaths(repo, runtime).runtimeDirectory, realpathSync(runtime));

    assert.deepEqual(configureRoomPolicy(repo, roomId, "alice", {
      ownerMessageWake: "normal",
      maxRepliesPerHour: 3
    }, { runtimeDirectory: runtime }), {
      ownerMessageWake: "normal",
      maxRepliesPerHour: 3
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

function seedCredentials(repo: string, runtime: string): void {
  const paths = runtimePaths(repo, runtime);
  mkdirSync(paths.agentCredentials, { recursive: true, mode: 0o700 });
  writePrivate(paths.deviceCredential, {
    schemaVersion: 1,
    serverUrl: "http://localhost:3000",
    deviceId: "device-1",
    credentialId: "device-credential-1",
    credential: "device-secret"
  });
  writePrivate(join(paths.agentCredentials, "alice.json"), {
    schemaVersion: 1,
    state: "active",
    serverUrl: "http://localhost:3000",
    deviceId: "device-1",
    name: "alice",
    verifier: "verifier",
    agentId: "agent-1",
    placementId: "placement-1",
    enrollmentId: "enrollment-1",
    credentialId: "agent-credential-1",
    credential: "agent-secret"
  });
}

function writePrivate(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function room() {
  return {
    id: roomId,
    name: "Team",
    matrixRoomId: "!room:example.com",
    visibility: "private",
    head: roomHead,
    createdAt: now,
    membership: {
      humanId: "human-1",
      role: "owner",
      canInvite: true,
      status: "active",
      createdAt: now
    }
  };
}

function binding() {
  return {
    id: "binding-1",
    agentId: "agent-1",
    roomId,
    wakeMode: "mention_only",
    status: "active",
    createdAt: now,
    createdByHumanId: "human-1",
    updatedAt: now
  };
}
