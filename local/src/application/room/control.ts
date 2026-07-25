import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";

import type {
  AgentRoomBindingSummary,
  AgentRoomWakeModeUpdate,
  RoomEventProjection,
  RoomSummary,
  RoomVisibility
} from "../../protocol.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { AgentCredentialStore, type ActiveAgentCredential } from "../../infrastructure/files/agent-credential-store.js";
import { DeviceServerClient } from "../../integrations/server/device-client.js";
import { DeviceCredentialStore } from "../../infrastructure/files/device-credential-store.js";
import { RoomServerClient } from "../../integrations/server/room-client.js";
import {
  RoomPolicyStore,
  type RoomPolicyUpdate
} from "../../infrastructure/files/room-policy-store.js";

export type { RoomPolicyUpdate } from "../../infrastructure/files/room-policy-store.js";

export interface RoomOperationDependencies {
  readonly fetch?: typeof fetch;
  readonly runtimeDirectory?: string;
}

export function createRoom(
  repoRoot: string,
  name: string,
  visibility: RoomVisibility,
  dependencies: RoomOperationDependencies = {}
): Promise<RoomSummary> {
  return deviceClient(repoRoot, dependencies).createRoom(name, visibility);
}

export function allowAdmissionSubject(
  repoRoot: string,
  subject: string,
  dependencies: RoomOperationDependencies = {}
): Promise<void> {
  if (subject.trim() === "") throw new Error("OIDC subject must be non-empty");
  return deviceClient(repoRoot, dependencies).allowSubject(subject.trim());
}

export function listRooms(
  repoRoot: string,
  dependencies: RoomOperationDependencies = {}
): Promise<readonly RoomSummary[]> {
  return deviceClient(repoRoot, dependencies).listRooms();
}

export function joinRoom(
  repoRoot: string,
  roomId: string,
  dependencies: RoomOperationDependencies = {}
): Promise<RoomSummary> {
  return deviceClient(repoRoot, dependencies).joinRoom(roomId);
}

export function inviteHuman(
  repoRoot: string,
  roomId: string,
  humanId: string,
  dependencies: RoomOperationDependencies = {}
): Promise<RoomSummary> {
  return deviceClient(repoRoot, dependencies).inviteHuman(roomId, humanId);
}

export function addAgentToRoom(
  repoRoot: string,
  roomId: string,
  agentName: string,
  dependencies: RoomOperationDependencies = {}
): Promise<AgentRoomBindingSummary> {
  const resources = credentials(repoRoot, agentName, dependencies.runtimeDirectory);
  return deviceClient(repoRoot, dependencies).inviteAgent(roomId, resources.agent.agentId);
}

export function updateAgentRoomWakeMode(
  repoRoot: string,
  roomId: string,
  agentName: string,
  wakeMode: AgentRoomWakeModeUpdate["wakeMode"],
  dependencies: RoomOperationDependencies = {}
): Promise<AgentRoomBindingSummary> {
  const resources = credentials(repoRoot, agentName, dependencies.runtimeDirectory);
  return deviceClient(repoRoot, dependencies).updateAgentWakeMode(
    roomId,
    resources.agent.agentId,
    wakeMode
  );
}

export async function removeAgentFromRoom(
  repoRoot: string,
  roomId: string,
  agentName: string,
  dependencies: RoomOperationDependencies = {}
): Promise<void> {
  const resources = credentials(repoRoot, agentName, dependencies.runtimeDirectory);
  await deviceClient(repoRoot, dependencies).removeAgent(roomId, resources.agent.agentId);
}

export function listAgentRoomBindings(
  repoRoot: string,
  agentName: string,
  dependencies: RoomOperationDependencies = {}
): Promise<readonly AgentRoomBindingSummary[]> {
  return agentClient(repoRoot, agentName, dependencies).bindings();
}

export function configureRoomPolicy(
  repoRoot: string,
  roomId: string,
  agentName: string,
  update: RoomPolicyUpdate,
  dependencies: RoomOperationDependencies = {}
): RoomPolicyUpdate {
  const paths = ensureRuntime(repoRoot, dependencies.runtimeDirectory);
  const agent = credentials(repoRoot, agentName, dependencies.runtimeDirectory).agent;
  return new RoomPolicyStore(paths.matrixPolicy).updateMatrixPolicy(
    agent.agentId,
    roomId,
    update
  );
}

export async function sendRoomMessage(
  repoRoot: string,
  roomId: string,
  body: string,
  dependencies: RoomOperationDependencies = {}
): Promise<{ readonly eventId: string; readonly transactionId: string }> {
  if (body.trim() === "") throw new Error("Room message must be non-empty");
  const transactionId = randomUUID();
  return deviceClient(repoRoot, dependencies).sendRoomMessage(roomId, transactionId, body);
}

export async function sendAgentRoomMessage(
  repoRoot: string,
  roomId: string,
  agentName: string,
  body: string,
  dependencies: RoomOperationDependencies = {}
): Promise<{ readonly eventId: string; readonly transactionId: string }> {
  if (body.trim() === "") throw new Error("Room message must be non-empty");
  const transactionId = randomUUID();
  const receipt = await agentClient(repoRoot, agentName, dependencies).send({
    agentId: credentials(repoRoot, agentName, dependencies.runtimeDirectory).agent.agentId,
    roomId,
    transactionId,
    body,
    causalChainId: randomUUID(),
    causalHop: 1
  });
  return { ...receipt, transactionId };
}

export async function roomHistory(
  repoRoot: string,
  roomId: string,
  agentName: string,
  limit = 50,
  dependencies: RoomOperationDependencies = {}
): Promise<readonly RoomEventProjection[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("history limit must be an integer between 1 and 100");
  }
  const client = agentClient(repoRoot, agentName, dependencies);
  const snapshot = await client.head(roomId);
  let after: string | undefined;
  const events: RoomEventProjection[] = [];
  while (events.length < limit) {
    const page = await client.events({
      roomId,
      ...(after === undefined ? {} : { after }),
      through: snapshot.head,
      limit: Math.min(100, limit - events.length)
    });
    events.push(...page.events);
    if (page.complete) break;
    if (page.nextCursor === undefined || page.nextCursor === after) {
      throw new Error("Room history pagination made no progress");
    }
    after = page.nextCursor;
  }
  return events;
}

function deviceClient(
  repoRoot: string,
  dependencies: RoomOperationDependencies
): DeviceServerClient {
  const paths = ensureRuntime(repoRoot, dependencies.runtimeDirectory);
  const device = new DeviceCredentialStore(paths.deviceCredential).load();
  if (device === undefined) {
    throw new Error("this Local Runtime is not paired; run device login first");
  }
  return new DeviceServerClient({
    serverUrl: device.serverUrl,
    credential: device.credential,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
  });
}

function agentClient(
  repoRoot: string,
  agentName: string,
  dependencies: RoomOperationDependencies
): RoomServerClient {
  const { agent } = credentials(repoRoot, agentName, dependencies.runtimeDirectory);
  return new RoomServerClient({
    baseUrl: agent.serverUrl,
    agentId: agent.agentId,
    credential: agent.credential,
    allowInsecureHttp: new URL(agent.serverUrl).protocol === "http:",
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
  });
}

function credentials(
  repoRoot: string,
  agentName: string,
  runtimeDirectory?: string
): { readonly agent: ActiveAgentCredential } {
  const paths = ensureRuntime(repoRoot, runtimeDirectory);
  const agent = new AgentCredentialStore(paths.agentCredentials).load(agentName);
  if (agent?.state !== "active") {
    throw new Error(`Agent ${agentName} does not have an active local credential`);
  }
  return { agent };
}

function ensureRuntime(repoRoot: string, runtimeDirectory?: string) {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  mkdirSync(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
  chmodSync(paths.runtimeDirectory, 0o700);
  return paths;
}
