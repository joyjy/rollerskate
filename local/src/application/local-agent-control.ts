import { chmodSync, mkdirSync } from "node:fs";

import {
  bootstrapLocalFoundation,
  type LocalAgent,
  type LocalAgentClient,
  type LocalFoundation,
  LocalFoundationStore
} from "./local-foundation.js";
import { LocalChatStore } from "./local-chat-store.js";
import { runtimePaths } from "./runtime-config.js";
import { initializeRuntimeSchema } from "./runtime-schema.js";

export interface LocalControlOptions {
  readonly runtimeDirectory?: string;
  readonly now?: () => Date;
}

export interface LocalRuntimeSnapshot {
  readonly foundation: LocalFoundation;
  readonly agents: readonly LocalAgent[];
}

export interface AgentAvailability {
  readonly state: "ready" | "unavailable" | "unknown";
  readonly reason?: string;
  readonly checkedAt?: string;
}

export interface AgentCurrentSession {
  readonly sessionId: string;
  readonly generation: number;
  readonly state: "created" | "resumed";
  readonly updatedAt: string;
}

export interface AgentConsoleItem {
  readonly principalId: string;
  readonly handle: string;
  readonly status: "active" | "suspended";
  readonly client: "codex";
  readonly availability: AgentAvailability;
  readonly currentSession?: AgentCurrentSession;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function localRuntimeSnapshot(
  repoRoot: string,
  options: LocalControlOptions = {}
): LocalRuntimeSnapshot {
  const resources = openLocalControl(repoRoot, options);
  try {
    return {
      foundation: resources.foundation,
      agents: resources.store.listAgents()
    };
  } finally {
    resources.store.close();
  }
}

export function agentConsoleList(
  repoRoot: string,
  options: LocalControlOptions = {}
): readonly AgentConsoleItem[] {
  const resources = openLocalControl(repoRoot, options);
  const chatStore = new LocalChatStore(resources.databasePath);
  try {
    const agents = resources.store.listAgents();
    return agents.map((agent) => {
      const currentSession = chatStore.currentAgentSession(agent.principalId);
      return {
        principalId: agent.principalId,
        handle: agent.handle,
        status: agent.status,
        client: agent.client,
        availability: {
          state: "unknown",
          reason: "Runtime does not expose per-agent adapter readiness yet"
        },
        ...(currentSession === undefined ? {} : { currentSession }),
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt
      };
    });
  } finally {
    chatStore.close();
    resources.store.close();
  }
}

export function addLocalAgent(
  repoRoot: string,
  handle: string,
  client: LocalAgentClient,
  options: LocalControlOptions = {}
): LocalAgent {
  const resources = openLocalControl(repoRoot, options);
  try {
    return resources.store.addAgent(
      handle,
      client,
      timestamp(options)
    );
  } finally {
    resources.store.close();
  }
}

export function renameLocalAgent(
  repoRoot: string,
  principalId: string,
  handle: string,
  options: LocalControlOptions = {}
): LocalAgent {
  const resources = openLocalControl(repoRoot, options);
  try {
    return resources.store.renameAgent(principalId, handle, timestamp(options));
  } finally {
    resources.store.close();
  }
}

export function suspendLocalAgent(
  repoRoot: string,
  principalId: string,
  options: LocalControlOptions = {}
): LocalAgent {
  return setLocalAgentStatus(repoRoot, principalId, "suspended", options);
}

export function resumeLocalAgent(
  repoRoot: string,
  principalId: string,
  options: LocalControlOptions = {}
): LocalAgent {
  return setLocalAgentStatus(repoRoot, principalId, "active", options);
}

function setLocalAgentStatus(
  repoRoot: string,
  principalId: string,
  status: "active" | "suspended",
  options: LocalControlOptions
): LocalAgent {
  const resources = openLocalControl(repoRoot, options);
  try {
    return resources.store.setAgentStatus(principalId, status, timestamp(options));
  } finally {
    resources.store.close();
  }
}

function openLocalControl(
  repoRoot: string,
  options: LocalControlOptions
): {
  readonly store: LocalFoundationStore;
  readonly foundation: LocalFoundation;
  readonly databasePath: string;
} {
  const paths = runtimePaths(repoRoot, options.runtimeDirectory);
  mkdirSync(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
  chmodSync(paths.runtimeDirectory, 0o700);
  initializeRuntimeSchema(paths.database);
  const foundation = bootstrapLocalFoundation(paths, timestamp(options));
  return {
    store: new LocalFoundationStore(paths.database),
    foundation,
    databasePath: paths.database
  };
}

function timestamp(options: LocalControlOptions): string {
  return (options.now ?? (() => new Date()))().toISOString();
}
