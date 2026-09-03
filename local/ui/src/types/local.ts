import type {
  AgentSummaryOutput,
  ChatPresenceOutput,
  LocalAgentOutput,
  LocalChatPresenceViewOutput,
  LocalChatViewOutput,
  LocalFoundationOutput,
  LocalSnapshotOutput
} from "@/api/schema";

export type LocalAgent = LocalAgentOutput;
export type LocalAgentStatus = LocalAgent["status"];
export const supportedLocalAgentClientOptions = [
  { value: "codex", label: "Codex" },
  { value: "claude-code", label: "Claude Code" },
  { value: "kimi-code", label: "Kimi Code" },
  { value: "pi", label: "Pi" }
] as const;
export type SupportedLocalAgentClient =
  typeof supportedLocalAgentClientOptions[number]["value"];
export type AgentExecutionConfig = LocalAgent["executionConfig"];
export type LocalSnapshot = LocalSnapshotOutput;
export type LocalFoundation = LocalFoundationOutput;
export type LocalPrincipal = LocalFoundation["owner"];
export type AgentSummary = AgentSummaryOutput;
export type AgentAvailability = AgentSummary["availability"];
export type AgentCurrentSession = NonNullable<AgentSummary["currentSession"]>;
export type LocalChatView = LocalChatViewOutput;
export type LocalChatSession = LocalChatView["sessions"][number];
export type LocalChatMessagePage = LocalChatView["messages"];
export type LocalChatMessage = LocalChatMessagePage["items"][number];
export type ChatRunProposal = NonNullable<LocalChatMessage["runProposals"]>[number];
export type ChatRunWorkspaceSelection =
  | { readonly kind: "project" }
  | { readonly kind: "local" }
  | { readonly kind: "path"; readonly path: string };
export type ChatReadProgress = NonNullable<LocalChatMessage["readProgress"]>;
export type ChatPresence = ChatPresenceOutput;
export type LocalChatPresenceView = LocalChatPresenceViewOutput;
export type LocalChatPresenceAgent = LocalChatPresenceView["agents"][number];
