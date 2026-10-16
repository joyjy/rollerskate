import {
  type ConversationIntentSnapshot,
  type ChatPromptHistory,
  type ChatProfileContext,
  chatMentionPromptResourceId,
  chatPromptResourceId
} from "../../core/chat/model.js";
import type { ChatAttentionPlan } from "../../core/chat/state-machine.js";
import type { ChatMessageEvent } from "../../core/event/model.js";
import { loadPromptTemplate } from "../../infrastructure/resources/prompt-template.js";
import type { ChatToolCapability } from "./tool-policy.js";

const contextPlaceholder = "{{CHAT_CONTEXT_JSON}}";

export interface ChatPromptTaskClaim {
  readonly sourceMessageEventId: string;
  readonly runId: string;
  readonly dispatchEventId: string;
  readonly agentId: string;
  readonly status: string;
  readonly taskQuote?: string;
}

export interface ChatPromptContext {
  readonly agent: {
    readonly agentId: string;
    readonly handle: string;
  };
  readonly topicId: string;
  readonly attentionReason: ChatAttentionPlan["reason"];
  readonly currentPresence: ChatAttentionPlan["presenceSnapshot"];
  readonly turnMode: "reply_to_message" | "proactive_contribution";
  readonly latestMessage?: ChatMessageEvent;
  readonly conversationIntent: ConversationIntentSnapshot;
  readonly history: ChatPromptHistory;
  readonly taskClaims?: readonly ChatPromptTaskClaim[];
  readonly taskClaimsTruncated?: boolean;
  readonly tools: ChatToolCapability;
  readonly chatHistory?:
    | {
        readonly schema: "ChatHistoryToolsCapability@1";
        readonly tools: readonly ["read_chat_history"];
      }
    | {
        readonly schema: "ChatHistoryRequestCapability@1";
      };
  readonly now: string;
  readonly profileContext?: ChatProfileContext;
  readonly clientHistory?:
    | {
        readonly schema: "ClientHistoryCapability@1";
        readonly scope: "same-client-history-read";
        readonly client: import("../../modules/agent/client-profile.js").AgentClient;
        readonly actions: readonly ["search", "read"];
      }
    | {
        readonly schema: "ClientThreadToolsCapability@1";
        readonly scope: "same-client-history-read";
        readonly client: "codex";
        readonly tools: readonly ["list_client_threads", "read_client_thread"];
        readonly timeZone: "Asia/Shanghai";
      };
}

export interface ChatPromptResource {
  readonly resourceId: typeof chatPromptResourceId | typeof chatMentionPromptResourceId;
  render(context: ChatPromptContext): string;
}

export function loadChatPromptResource(): ChatPromptResource {
  return loadChatResource("free-turn.md", chatPromptResourceId);
}

export function loadChatMentionPromptResource(): ChatPromptResource {
  return loadChatResource("mentioned-turn.md", chatMentionPromptResourceId);
}

function loadChatResource(
  filename: string,
  resourceId: ChatPromptResource["resourceId"]
): ChatPromptResource {
  const template = loadPromptTemplate(
    new URL(`../../../resources/prompts/chat/${filename}`, import.meta.url),
    resourceId
  ).replace("{{CHAT_RUN_GUIDANCE}}", loadPromptTemplate(
    new URL("../../../resources/prompts/chat/run-guidance.md", import.meta.url),
    "prompt.chat.run-guidance"
  ));
  if (!template.includes(contextPlaceholder)) {
    throw new Error(`Chat prompt resource is missing ${contextPlaceholder}`);
  }
  return {
    resourceId,
    render(context) {
      return template.replace(contextPlaceholder, JSON.stringify(context, null, 2));
    }
  };
}
