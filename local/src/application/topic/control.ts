import type {
  AgentPublicProfile,
  AgentPublicProfileUpdate,
  TopicCreateRequest,
  TopicEvent,
  TopicJoinReceipt,
  TopicProfileUpdate,
  TopicSummary
} from "../../protocol.js";
import { AgentCredentialStore } from "../../infrastructure/files/agent-credential-store.js";
import { DeviceCredentialStore } from "../../infrastructure/files/device-credential-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { bootstrapLocalFoundation, LocalFoundationStore } from
  "../../infrastructure/sqlite/foundation-store.js";
import { DeviceServerClient } from "../../integrations/server/device-client.js";
import { AgentServerClient } from "../../integrations/server/agent-client.js";

export interface TopicControlDependencies {
  readonly runtimeDirectory?: string;
  readonly fetch?: typeof fetch;
}

export async function inspectAgentPublicProfile(
  repoRoot: string,
  handle: string,
  dependencies: TopicControlDependencies = {}
): Promise<AgentPublicProfile> {
  const resources = openResources(repoRoot, dependencies);
  try {
    const agent = requireAgent(resources, handle);
    return await resources.deviceClient.agentProfile(agent.agentId);
  } finally {
    resources.foundation.close();
  }
}

export async function updateAgentPublicProfile(
  repoRoot: string,
  handle: string,
  update: AgentPublicProfileUpdate,
  dependencies: TopicControlDependencies = {}
): Promise<AgentPublicProfile> {
  const resources = openResources(repoRoot, dependencies);
  try {
    const agent = requireAgent(resources, handle);
    return await resources.deviceClient.updateAgentProfile(agent.agentId, update);
  } finally {
    resources.foundation.close();
  }
}

export async function createServerTopic(
  repoRoot: string,
  request: TopicCreateRequest,
  dependencies: TopicControlDependencies = {}
): Promise<TopicSummary> {
  const resources = openResources(repoRoot, dependencies);
  try {
    return await resources.deviceClient.createTopic(request);
  } finally {
    resources.foundation.close();
  }
}

export async function listServerTopics(
  repoRoot: string,
  dependencies: TopicControlDependencies = {}
): Promise<readonly TopicSummary[]> {
  const resources = openResources(repoRoot, dependencies);
  try {
    return await resources.deviceClient.listTopics();
  } finally {
    resources.foundation.close();
  }
}

export async function updateServerTopicProfile(
  repoRoot: string,
  topicId: string,
  update: TopicProfileUpdate,
  dependencies: TopicControlDependencies = {}
): Promise<TopicSummary> {
  const resources = openResources(repoRoot, dependencies);
  try {
    return await resources.deviceClient.updateTopicProfile(topicId, update);
  } finally {
    resources.foundation.close();
  }
}

export async function joinServerTopic(
  repoRoot: string,
  topicId: string,
  handle: string,
  dependencies: TopicControlDependencies = {}
): Promise<TopicJoinReceipt> {
  const resources = openResources(repoRoot, dependencies);
  try {
    const agent = requireAgent(resources, handle);
    return await resources.deviceClient.joinTopic(topicId, agent.agentId);
  } finally {
    resources.foundation.close();
  }
}

export async function publishServerTopicMessage(
  repoRoot: string,
  topicId: string,
  handle: string,
  transactionId: string,
  body: string,
  dependencies: TopicControlDependencies = {}
): Promise<TopicEvent> {
  if (body.length === 0) throw new Error("Topic message must be non-empty");
  const resources = openResources(repoRoot, dependencies);
  try {
    const agent = requireAgent(resources, handle);
    return await agent.client.publishTopic(topicId, { transactionId, body });
  } finally {
    resources.foundation.close();
  }
}

export async function publishHumanServerTopicMessage(
  repoRoot: string,
  topicId: string,
  transactionId: string,
  body: string,
  dependencies: TopicControlDependencies = {}
): Promise<TopicEvent> {
  if (body.trim().length === 0) throw new Error("Topic message must be non-empty");
  const resources = openResources(repoRoot, dependencies);
  try {
    return await resources.deviceClient.publishHumanTopic(topicId, { transactionId, body });
  } finally {
    resources.foundation.close();
  }
}

interface TopicResources {
  readonly foundation: LocalFoundationStore;
  readonly deviceClient: DeviceServerClient;
  readonly agentCredentials: AgentCredentialStore;
  readonly serverUrl: string;
  readonly deviceId: string;
  readonly fetch?: typeof fetch;
}

function openResources(
  repoRoot: string,
  dependencies: TopicControlDependencies
): TopicResources {
  const paths = runtimePaths(repoRoot, dependencies.runtimeDirectory);
  bootstrapLocalFoundation(paths);
  const foundation = new LocalFoundationStore(paths.database);
  const device = new DeviceCredentialStore(paths.deviceCredential).load();
  if (device === undefined) {
    foundation.close();
    throw new Error("this Local Runtime is not paired; run device login first");
  }
  return {
    foundation,
    deviceClient: client(device.serverUrl, device.credential, dependencies.fetch),
    agentCredentials: new AgentCredentialStore(paths.agentCredentials),
    serverUrl: device.serverUrl,
    deviceId: device.deviceId,
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
  };
}

function requireAgent(
  resources: TopicResources,
  handle: string
): { readonly agentId: string; readonly client: AgentServerClient } {
  const local = resources.foundation.agentByHandle(handle);
  if (local?.status !== "active") {
    throw new Error(`Local Agent is not active: ${handle}`);
  }
  const credential = resources.agentCredentials.load(local.handle);
  if (credential?.state !== "active") {
    throw new Error(`Agent ${handle} does not have an active Server credential`);
  }
  if (credential.serverUrl !== resources.serverUrl ||
    credential.deviceId !== resources.deviceId ||
    credential.name !== local.handle) {
    throw new Error("Agent credential belongs to a different Server, Device or Local Agent");
  }
  return {
    agentId: credential.agentId,
    client: new AgentServerClient({
      serverUrl: credential.serverUrl,
      agentId: credential.agentId,
      credential: credential.credential,
      ...(resources.fetch === undefined ? {} : { fetch: resources.fetch })
    })
  };
}

function client(serverUrl: string, credential: string, fetch_: typeof fetch | undefined) {
  return new DeviceServerClient({
    serverUrl,
    credential,
    ...(fetch_ === undefined ? {} : { fetch: fetch_ })
  });
}
