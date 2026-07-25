import {
  type ChatPromptHistory,
  chatMentionPromptResourceId,
  chatPromptResourceId
} from "../../core/chat/model.js";
import type { ChatAttentionPlan } from "../../core/chat/state-machine.js";
import type { ChatMessageEvent } from "../../core/event/model.js";
import { loadPromptTemplate } from "../../infrastructure/resources/prompt-template.js";

const contextPlaceholder = "{{CHAT_CONTEXT_JSON}}";

export interface ChatPromptContext {
  readonly agent: {
    readonly agentId: string;
    readonly handle: string;
  };
  readonly topicId: string;
  readonly attentionReason: ChatAttentionPlan["reason"];
  readonly currentPresence: ChatAttentionPlan["presenceSnapshot"];
  readonly latestMessage: ChatMessageEvent;
  readonly history: ChatPromptHistory;
  readonly now: string;
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
  );
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
