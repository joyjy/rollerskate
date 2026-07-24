import type { LocalAgent, LocalChatSession } from "@/types/local";
import type { RuntimeEvent } from "@/types/runtime";

export type ChatKind = "local" | "server";

export interface ChatListItem {
  id: string;
  kind: ChatKind;
  handle: string;
  name: string;
  status: "active" | "archived" | "unavailable";
  lastActivityAt?: string;
  unreadCount: number;
}

export interface ChatView {
  chat: { readonly topicId: string; readonly handle: "local" };
  agents: readonly LocalAgent[];
  events: readonly RuntimeEvent[];
  sessions: readonly LocalChatSession[];
}
