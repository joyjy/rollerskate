import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync
} from "node:fs";
import { join, sep } from "node:path";

import type { AgentSummary } from "../../protocol.js";
import { agentNameSchema } from "../../protocol.js";
import type { AgentClient } from "../../modules/agent/client-profile.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { DeviceServerClient } from "../../integrations/server/device-client.js";
import { AgentServerClient } from "../../integrations/server/agent-client.js";
import { DeviceCredentialStore } from "../../infrastructure/files/device-credential-store.js";
import { initializeRuntimeSchema } from "../../infrastructure/sqlite/schema.js";
import { AgentConfigStore, type AgentRuntimeConfig } from "../../infrastructure/files/agent-config-store.js";
import {
  AgentCredentialStore,
  type ActiveAgentCredential,
  type AgentCredential
} from "../../infrastructure/files/agent-credential-store.js";
import { RuntimeStore, type AppendRuntimeEventReceipt } from "../../core/runtime/store.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";

export interface AgentOperationDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly runtimeDirectory?: string;
  readonly client?: AgentClient;
}

export interface LocalAgentStatus {
  readonly metadata: LocalAgentMetadata;
  readonly summary: AgentSummary;
}

export interface ServerAgentStatus {
  readonly summary: AgentSummary;
  readonly credentialId: string;
  readonly deviceId: string;
  readonly placementId: string;
}

export interface LocalAgentMetadata {
  readonly agentId: string;
  readonly name: string;
  readonly status: "provisioning" | "active" | "suspended" | "revoked";
  readonly placementId: string;
  readonly deviceId: string;
  readonly generation: number;
  readonly credentialId?: string;
  readonly workspacePath: string;
  readonly client: AgentClient;
  readonly createdAt: string;
  readonly activatedAt?: string;
  readonly lastVerifiedAt?: string;
}

export function enqueueAgentRequest(
  repoRoot: string,
  nameInput: string,
  prompt: string,
  options: { readonly sessionId?: string; readonly runtimeDirectory?: string } = {}
): AppendRuntimeEventReceipt {
  const name = agentNameSchema.parse(nameInput);
  if (prompt.trim() === "") throw new Error("Agent request prompt must be non-empty");
  const paths = ensureRuntime(repoRoot, options.runtimeDirectory);
  const foundation = new LocalFoundationStore(paths.database);
  const runtime = new RuntimeStore(paths.database);
  try {
    const agent = foundation.agentByHandle(name);
    if (agent?.status !== "active") {
      throw new Error(`Agent ${name} is not active in this Local Runtime`);
    }
    if (options.sessionId !== undefined) {
      const session = runtime.session(options.sessionId);
      if (session === undefined) {
        throw new Error(`Session not found: ${options.sessionId}`);
      }
      if (session.agentId !== agent.principalId) {
        throw new Error(
          `Session does not belong to Agent ${name}: ${options.sessionId}`
        );
      }
    }
    return runtime.appendEvent({
      type: "agent.request",
      source: { kind: "cli" },
      agentId: agent.principalId,
      prompt,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId })
    });
  } finally {
    runtime.close();
    foundation.close();
  }
}

export function configureAgents(
  repoRoot: string,
  workspaceRoot: string,
  runtimeDirectory?: string
): AgentRuntimeConfig {
  const paths = ensureRuntime(repoRoot, runtimeDirectory);
  return new AgentConfigStore(paths.agentConfig).configure(workspaceRoot);
}

export async function createAgent(
  repoRoot: string,
  nameInput: string,
  dependencies: AgentOperationDependencies = {}
): Promise<LocalAgentStatus> {
  const name = agentNameSchema.parse(nameInput);
  const resources = openResources(repoRoot, dependencies.runtimeDirectory);
  try {
    const device = requireDeviceCredential(resources.deviceCredentials.load());
    const config = requireAgentConfig(resources.config.load());
    const existing = resources.agentCredentials.load(name);
    const existingLocal = resources.foundation.agentByHandle(name);
    if (dependencies.client !== undefined && existingLocal !== undefined &&
      existingLocal.client !== dependencies.client) {
      throw new Error(
        `Agent ${name} already uses client ${existingLocal.client}; client cannot be changed`
      );
    }
    const selectedClient = dependencies.client ?? existingLocal?.client ?? "codex";
    if (existing?.state === "active") {
      return await verifyActiveAgent(resources.foundation, existing, config, dependencies);
    }
    const pending: AgentCredential = existing ?? {
      state: "pending",
      serverUrl: device.serverUrl,
      deviceId: device.deviceId,
      name,
      verifier: randomBytes(32).toString("base64url")
    };
    assertCredentialDevice(pending, device.serverUrl, device.deviceId);
    if (existing === undefined) {
      resources.agentCredentials.save(pending);
    }

    const client = authenticatedClient(device.serverUrl, device.credential, dependencies);
    const response = await client.createAgent({
      name,
      verifierChallenge: challenge(pending.verifier)
    });
    if (response.agent.name !== name ||
      response.enrollment.agentId !== response.agent.id ||
      response.enrollment.deviceId !== device.deviceId ||
      response.enrollment.placementId !== response.agent.placement.id) {
      throw new Error("Server returned mismatched Agent enrollment identity");
    }
    const enrolledPending: AgentCredential = {
      ...pending,
      state: "pending",
      agentId: response.agent.id,
      placementId: response.agent.placement.id,
      enrollmentId: response.enrollment.id
    };
    resources.agentCredentials.save(enrolledPending);

    const workspacePath = provisionWorkspace(config.workspaceRoot, name);
    ensureLocalAgent(resources.foundation, response.agent, selectedClient, dependencies);
    const issuance = await client.redeemAgentEnrollment(
      response.enrollment.id,
      pending.verifier
    );
    if (issuance.agent.id !== response.agent.id ||
      issuance.agent.placement.id !== response.agent.placement.id) {
      throw new Error("Server returned mismatched Agent credential identity");
    }
    const active: ActiveAgentCredential = {
      state: "active",
      serverUrl: device.serverUrl,
      deviceId: device.deviceId,
      name,
      verifier: pending.verifier,
      agentId: issuance.agent.id,
      placementId: issuance.agent.placement.id,
      enrollmentId: response.enrollment.id,
      credentialId: issuance.credentialId,
      credential: issuance.credential
    };
    resources.agentCredentials.save(active);
    return {
      metadata: projectMetadata(
        resources.foundation,
        issuance.agent,
        workspacePath,
        issuance.credentialId,
        currentTimestamp(dependencies)
      ),
      summary: issuance.agent
    };
  } finally {
    resources.foundation.close();
  }
}

export async function enrollLocalAgentOnServer(
  repoRoot: string,
  nameInput: string,
  dependencies: AgentOperationDependencies = {}
): Promise<ServerAgentStatus> {
  const name = agentNameSchema.parse(nameInput);
  const resources = openResources(repoRoot, dependencies.runtimeDirectory);
  try {
    const device = requireDeviceCredential(resources.deviceCredentials.load());
    const local = resources.foundation.agentByHandle(name);
    if (local?.status !== "active") {
      throw new Error(`Local Agent ${name} is not active`);
    }
    const existing = resources.agentCredentials.load(name);
    if (existing?.state === "active") {
      return await inspectActiveServerAgent(resources.foundation, existing, dependencies);
    }
    const pending: AgentCredential = existing ?? {
      state: "pending",
      serverUrl: device.serverUrl,
      deviceId: device.deviceId,
      name,
      verifier: randomBytes(32).toString("base64url")
    };
    assertCredentialDevice(pending, device.serverUrl, device.deviceId);
    if (existing === undefined) resources.agentCredentials.save(pending);

    const client = authenticatedClient(device.serverUrl, device.credential, dependencies);
    const response = await client.createAgent({
      name,
      verifierChallenge: challenge(pending.verifier)
    });
    if (response.agent.name !== name ||
      response.enrollment.agentId !== response.agent.id ||
      response.enrollment.deviceId !== device.deviceId ||
      response.enrollment.placementId !== response.agent.placement.id) {
      throw new Error("Server returned mismatched Agent enrollment identity");
    }
    resources.agentCredentials.save({
      ...pending,
      state: "pending",
      agentId: response.agent.id,
      placementId: response.agent.placement.id,
      enrollmentId: response.enrollment.id
    });
    const issuance = await client.redeemAgentEnrollment(
      response.enrollment.id,
      pending.verifier
    );
    if (issuance.agent.id !== response.agent.id ||
      issuance.agent.placement.id !== response.agent.placement.id) {
      throw new Error("Server returned mismatched Agent credential identity");
    }
    const active: ActiveAgentCredential = {
      ...pending,
      state: "active",
      agentId: issuance.agent.id,
      placementId: issuance.agent.placement.id,
      enrollmentId: response.enrollment.id,
      credentialId: issuance.credentialId,
      credential: issuance.credential
    };
    resources.agentCredentials.save(active);
    return serverStatus(issuance.agent, active);
  } finally {
    resources.foundation.close();
  }
}

export async function inspectServerAgent(
  repoRoot: string,
  nameInput: string,
  dependencies: AgentOperationDependencies = {}
): Promise<ServerAgentStatus> {
  const name = agentNameSchema.parse(nameInput);
  const resources = openResources(repoRoot, dependencies.runtimeDirectory);
  try {
    const device = requireDeviceCredential(resources.deviceCredentials.load());
    const credential = resources.agentCredentials.load(name);
    if (credential?.state !== "active") {
      throw new Error(`Agent ${name} does not have an active Server credential`);
    }
    assertCredentialDevice(credential, device.serverUrl, device.deviceId);
    return await inspectActiveServerAgent(resources.foundation, credential, dependencies);
  } finally {
    resources.foundation.close();
  }
}

export async function listAgents(
  repoRoot: string,
  dependencies: AgentOperationDependencies = {}
): Promise<readonly LocalAgentStatus[]> {
  const resources = openResources(repoRoot, dependencies.runtimeDirectory);
  try {
    const device = requireDeviceCredential(resources.deviceCredentials.load());
    const config = requireAgentConfig(resources.config.load());
    const summaries = await authenticatedClient(
      device.serverUrl,
      device.credential,
      dependencies
    ).listAgents();
    return summaries.map((summary) => {
      const local = resources.foundation.agentByHandle(summary.name);
      const credential = resources.agentCredentials.load(summary.name);
      if (local === undefined || credential?.state !== "active" ||
        credential.agentId !== summary.id ||
        credential.placementId !== summary.placement.id ||
        credential.deviceId !== summary.placement.deviceId) {
        throw new Error(`local metadata is missing for Agent ${summary.name}; run agent create`);
      }
      return {
        metadata: projectMetadata(
          resources.foundation,
          summary,
          provisionWorkspace(config.workspaceRoot, summary.name),
          credential.credentialId,
          currentTimestamp(dependencies)
        ),
        summary
      };
    });
  } finally {
    resources.foundation.close();
  }
}

export async function statusAgent(
  repoRoot: string,
  nameInput: string,
  dependencies: AgentOperationDependencies = {}
): Promise<LocalAgentStatus> {
  const name = agentNameSchema.parse(nameInput);
  const resources = openResources(repoRoot, dependencies.runtimeDirectory);
  try {
    const device = requireDeviceCredential(resources.deviceCredentials.load());
    const config = requireAgentConfig(resources.config.load());
    const credential = resources.agentCredentials.load(name);
    if (credential?.state !== "active") {
      throw new Error(`Agent ${name} does not have an active local credential`);
    }
    assertCredentialDevice(credential, device.serverUrl, device.deviceId);
    return await verifyActiveAgent(resources.foundation, credential, config, dependencies);
  } finally {
    resources.foundation.close();
  }
}

async function verifyActiveAgent(
  foundation: LocalFoundationStore,
  credential: ActiveAgentCredential,
  config: AgentRuntimeConfig,
  dependencies: AgentOperationDependencies
): Promise<LocalAgentStatus> {
  const serverSummary = await new AgentServerClient({
    serverUrl: credential.serverUrl,
    agentId: credential.agentId,
    credential: credential.credential,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
  }).principal();
  if (serverSummary.id !== credential.agentId ||
    serverSummary.name !== credential.name ||
    serverSummary.placement.id !== credential.placementId ||
    serverSummary.placement.deviceId !== credential.deviceId) {
    throw new Error("Server returned a different Agent identity");
  }
  const workspacePath = provisionWorkspace(config.workspaceRoot, credential.name);
  const local = foundation.agentByHandle(credential.name);
  if (local === undefined) throw new Error(`Local Agent is missing: ${credential.name}`);
  return {
    metadata: projectMetadata(
      foundation,
      serverSummary,
      workspacePath,
      credential.credentialId,
      currentTimestamp(dependencies)
    ),
    summary: serverSummary
  };
}

async function inspectActiveServerAgent(
  foundation: LocalFoundationStore,
  credential: ActiveAgentCredential,
  dependencies: AgentOperationDependencies
): Promise<ServerAgentStatus> {
  const summary = await new AgentServerClient({
    serverUrl: credential.serverUrl,
    agentId: credential.agentId,
    credential: credential.credential,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
  }).principal();
  if (summary.id !== credential.agentId ||
    summary.name !== credential.name ||
    summary.placement.id !== credential.placementId ||
    summary.placement.deviceId !== credential.deviceId) {
    throw new Error("Server returned a different Agent identity");
  }
  const local = foundation.agentByHandle(credential.name);
  if (local?.status !== "active") throw new Error(`Local Agent is not active: ${credential.name}`);
  return serverStatus(summary, credential);
}

function serverStatus(
  summary: AgentSummary,
  credential: ActiveAgentCredential
): ServerAgentStatus {
  return {
    summary,
    credentialId: credential.credentialId,
    deviceId: credential.deviceId,
    placementId: credential.placementId
  };
}

function ensureLocalAgent(
  foundation: LocalFoundationStore,
  summary: AgentSummary,
  client: AgentClient,
  dependencies: AgentOperationDependencies
): void {
  const existing = foundation.agentByHandle(summary.name);
  if (existing === undefined) {
    foundation.addAgent(summary.name, client, currentTimestamp(dependencies));
    return;
  }
  if (existing.client !== client) {
    throw new Error(
      `Agent ${summary.name} already uses client ${existing.client}; client cannot be changed`
    );
  }
}

function projectMetadata(
  foundation: LocalFoundationStore,
  summary: AgentSummary,
  workspacePath: string,
  credentialId: string,
  timestamp: string
): LocalAgentMetadata {
  const local = foundation.agentByHandle(summary.name);
  if (local === undefined) throw new Error(`Local Agent is missing: ${summary.name}`);
  return {
    agentId: summary.id,
    name: summary.name,
    status: summary.status,
    placementId: summary.placement.id,
    deviceId: summary.placement.deviceId,
    generation: summary.placement.generation,
    credentialId,
    workspacePath,
    client: local.client,
    createdAt: summary.createdAt,
    ...(summary.placement.activatedAt === undefined
      ? {}
      : { activatedAt: summary.placement.activatedAt }),
    lastVerifiedAt: timestamp
  };
}

function provisionWorkspace(workspaceRoot: string, name: string): string {
  const path = join(workspaceRoot, name);
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) {
      throw new Error(`Agent workspace must be a regular directory: ${path}`);
    }
  } else {
    mkdirSync(path, { mode: 0o700 });
  }
  const canonical = realpathSync(path);
  if (!canonical.startsWith(`${workspaceRoot}${sep}`) || canonical !== path) {
    throw new Error("Agent workspace escapes the configured workspace root");
  }
  return canonical;
}

function authenticatedClient(
  serverUrl: string,
  credential: string,
  dependencies: AgentOperationDependencies
): DeviceServerClient {
  return new DeviceServerClient({
    serverUrl,
    credential,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
  });
}

function requireDeviceCredential<T>(credential: T | undefined): T {
  if (credential === undefined) {
    throw new Error("this Local Runtime is not paired; run device login first");
  }
  return credential;
}

function requireAgentConfig(config: AgentRuntimeConfig | undefined): AgentRuntimeConfig {
  if (config === undefined) {
    throw new Error("Agent workspace root is not configured; run workspace set first");
  }
  return config;
}

function assertCredentialDevice(
  credential: AgentCredential,
  serverUrl: string,
  deviceId: string
): void {
  if (credential.serverUrl !== serverUrl || credential.deviceId !== deviceId) {
    throw new Error("Agent enrollment belongs to a different paired Device");
  }
}

function openResources(repoRoot: string, runtimeDirectory?: string): {
  readonly config: AgentConfigStore;
  readonly deviceCredentials: DeviceCredentialStore;
  readonly agentCredentials: AgentCredentialStore;
  readonly foundation: LocalFoundationStore;
} {
  const paths = ensureRuntime(repoRoot, runtimeDirectory);
  initializeRuntimeSchema(paths.database);
  const foundation = new LocalFoundationStore(paths.database);
  foundation.bootstrap(paths);
  return {
    config: new AgentConfigStore(paths.agentConfig),
    deviceCredentials: new DeviceCredentialStore(paths.deviceCredential),
    agentCredentials: new AgentCredentialStore(paths.agentCredentials),
    foundation
  };
}

function ensureRuntime(repoRoot: string, runtimeDirectory?: string): ReturnType<typeof runtimePaths> {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  mkdirSync(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
  chmodSync(paths.runtimeDirectory, 0o700);
  return paths;
}

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function currentTimestamp(dependencies: AgentOperationDependencies): string {
  return (dependencies.now ?? (() => new Date()))().toISOString();
}
