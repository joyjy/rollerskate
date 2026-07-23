import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runtimePaths } from "../src/application/runtime-config.js";
import {
  addAgentToRoom,
  createRoom,
  inviteHuman,
  joinRoom,
  listAgentRoomBindings
} from "../src/application/room-control.js";

const now = "2026-07-20T00:00:00.000Z";
const roomId = "room-three-clients";
const head = `r1.${Buffer.from(JSON.stringify([roomId, 0])).toString("base64url")}`;

test("three independent runtimes join one Room and bind only their own Agent", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-three-client-repo-"));
  const runtimes = ["a", "b", "c"].map((name) =>
    mkdtempSync(join(tmpdir(), `rollerskate-client-${name}-`)));
  try {
    for (const [index, runtime] of runtimes.entries()) {
      seed(repo, runtime!, index);
    }
    const server = new ThreeClientServer();
    const dependencies = runtimes.map((runtime) => ({
      runtimeDirectory: runtime,
      fetch: server.fetch
    }));
    const room = await createRoom(repo, "Three Clients", "private", dependencies[0]);
    await inviteHuman(repo, room.id, "human-b", dependencies[0]);
    await inviteHuman(repo, room.id, "human-c", dependencies[0]);
    await joinRoom(repo, room.id, dependencies[1]);
    await joinRoom(repo, room.id, dependencies[2]);
    for (const [index, name] of ["alice", "bob", "carol"].entries()) {
      const binding = await addAgentToRoom(repo, room.id, name, dependencies[index]);
      assert.equal(binding.agentId, `agent-${String.fromCharCode(97 + index)}`);
      assert.equal((await listAgentRoomBindings(repo, name, dependencies[index])).length, 1);
    }
    assert.deepEqual([...server.members].sort(), ["human-a", "human-b", "human-c"]);
    assert.deepEqual([...server.bindings.keys()].sort(), ["agent-a", "agent-b", "agent-c"]);
    assert.equal(new Set(runtimes.map((runtime) => runtimePaths(repo, runtime).runtimeDirectory)).size, 3);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    for (const runtime of runtimes) rmSync(runtime, { recursive: true, force: true });
  }
});

class ThreeClientServer {
  public readonly members = new Set(["human-a"]);
  public readonly invited = new Set<string>();
  public readonly bindings = new Map<string, ReturnType<typeof binding>>();
  readonly #deviceHumans = new Map([
    ["device-secret-a", "human-a"],
    ["device-secret-b", "human-b"],
    ["device-secret-c", "human-c"]
  ]);
  readonly #agentHumans = new Map([
    ["agent-secret-a", ["agent-a", "human-a"]],
    ["agent-secret-b", ["agent-b", "human-b"]],
    ["agent-secret-c", ["agent-c", "human-c"]]
  ]);

  public readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    const human = this.#deviceHumans.get(token);
    if (url.pathname === "/api/rooms" && init?.method === "POST" && human === "human-a") {
      return Response.json(room(), { status: 201 });
    }
    if (url.pathname.endsWith("/members") && init?.method === "POST" && human === "human-a") {
      const body = JSON.parse(String(init.body)) as { humanId: string };
      this.invited.add(body.humanId);
      return Response.json({ ...room(), membership: membership(body.humanId, "invited") }, {
        status: 201
      });
    }
    if (url.pathname.endsWith("/join") && init?.method === "POST" && human !== undefined &&
      this.invited.has(human)) {
      this.members.add(human);
      return Response.json({ ...room(), membership: membership(human, "active") });
    }
    if (url.pathname.endsWith("/agents") && init?.method === "POST" && human !== undefined) {
      const body = JSON.parse(String(init.body)) as { agentId: string };
      if (body.agentId !== `agent-${human.at(-1)}` || !this.members.has(human)) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      const value = binding(body.agentId);
      this.bindings.set(body.agentId, value);
      return Response.json(value, { status: 201 });
    }
    const agent = this.#agentHumans.get(token);
    if (url.pathname.endsWith("/rooms") && agent !== undefined) {
      const value = this.bindings.get(agent[0]!);
      return Response.json(value === undefined ? [] : [value]);
    }
    return Response.json({ error: "forbidden" }, { status: 403 });
  };
}

function seed(repo: string, runtime: string, index: number): void {
  const suffix = String.fromCharCode(97 + index);
  const name = ["alice", "bob", "carol"][index]!;
  const paths = runtimePaths(repo, runtime);
  mkdirSync(paths.agentCredentials, { recursive: true, mode: 0o700 });
  writePrivate(paths.deviceCredential, {
    schemaVersion: 1,
    serverUrl: "http://localhost:3000",
    deviceId: `device-${suffix}`,
    credentialId: `device-credential-${suffix}`,
    credential: `device-secret-${suffix}`
  });
  writePrivate(join(paths.agentCredentials, `${name}.json`), {
    schemaVersion: 1,
    state: "active",
    serverUrl: "http://localhost:3000",
    deviceId: `device-${suffix}`,
    name,
    verifier: "verifier",
    agentId: `agent-${suffix}`,
    placementId: `placement-${suffix}`,
    enrollmentId: `enrollment-${suffix}`,
    credentialId: `agent-credential-${suffix}`,
    credential: `agent-secret-${suffix}`
  });
}

function writePrivate(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function room() {
  return {
    id: roomId,
    name: "Three Clients",
    matrixRoomId: "!three:example.com",
    visibility: "private",
    head,
    createdAt: now,
    membership: membership("human-a", "active")
  };
}

function membership(humanId: string, status: "invited" | "active") {
  return {
    humanId,
    role: humanId === "human-a" ? "owner" : "member",
    canInvite: humanId === "human-a",
    status,
    createdAt: now
  };
}

function binding(agentId: string) {
  return {
    id: `binding-${agentId}`,
    agentId,
    roomId,
    wakeMode: "mention_only",
    status: "active",
    createdAt: now,
    createdByHumanId: `human-${agentId.at(-1)}`,
    updatedAt: now
  };
}
