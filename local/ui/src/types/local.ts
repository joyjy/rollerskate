import type { RuntimeEvent } from "@/types/runtime";

export type LocalAgentStatus = "active" | "suspended";
export type LocalAgentClient = "codex";

export interface LocalPrincipal {
  readonly principalId: string;
  readonly kind: "owner" | "agent";
  readonly handle: string;
  readonly status: LocalAgentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalAgent {
  readonly principalId: string;
  readonly handle: string;
  readonly status: LocalAgentStatus;
  readonly client: LocalAgentClient;
  readonly executionConfig: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
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
  readonly status: LocalAgentStatus;
  readonly client: LocalAgentClient;
  readonly availability: AgentAvailability;
  readonly currentSession?: AgentCurrentSession;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalFoundation {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly workspacePath: string;
  readonly topicId: string;
  readonly topicHandle: "local";
  readonly owner: LocalPrincipal;
  readonly createdAt: string;
}

export interface LocalSnapshot {
  readonly foundation: LocalFoundation;
  readonly agents: readonly LocalAgent[];
}

export interface LocalChatSession {
  readonly principalId: string;
  readonly currentSessionId?: string;
  readonly generation: number;
}

export interface LocalChatView {
  readonly chat: { readonly topicId: string; readonly handle: "local" };
  readonly agents: readonly LocalAgent[];
  readonly events: readonly RuntimeEvent[];
  readonly sessions: readonly LocalChatSession[];
}
