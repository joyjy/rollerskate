import type {
  AgentClient,
  AgentExecutionConfig
} from "../agent/client-profile.js";

export type PrincipalKind = "owner" | "agent";
export type PrincipalStatus = "active" | "suspended";
export type LocalAgentClient = AgentClient;

export interface LocalPrincipal {
  readonly principalId: string;
  readonly kind: PrincipalKind;
  readonly handle: string;
  readonly status: PrincipalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalAgent {
  readonly principalId: string;
  readonly handle: string;
  readonly status: PrincipalStatus;
  readonly client: LocalAgentClient;
  readonly executionConfig: AgentExecutionConfig;
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

export function normalizeAgentHandle(
  input: string
): { readonly value: string; readonly key: string } {
  const value = input.trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,31}$/u.test(value)) {
    throw new Error(
      "Agent handle must be 1-32 letters or numbers, with optional internal _ or -"
    );
  }
  return { value, key: value.toLocaleLowerCase("und") };
}
