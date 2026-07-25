import type {
  ChatMessageSummary,
  ChatPromptHistory,
  ChatTimeline
} from "../../core/chat/model.js";
import type { ChatMessageEvent } from "../../core/event/model.js";
import {
  LocalChatStore,
  type ChatMessagePage
} from "../../infrastructure/sqlite/chat-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import {
  localRuntimeSnapshot,
  type LocalControlOptions
} from "../agent/control.js";

export interface ChatTimelineOptions {
  readonly beforeEventId?: string;
  readonly limit?: number;
}

export function localChatTimeline(
  repoRoot: string,
  options: LocalControlOptions = {},
  timeline: ChatTimelineOptions = {}
): ChatTimeline {
  const topicId = localRuntimeSnapshot(repoRoot, options).foundation.topicId;
  const store = new LocalChatStore(runtimePaths(repoRoot, options.runtimeDirectory).database);
  try {
    return chatTimelineFromStore(store, topicId, timeline);
  } finally {
    store.close();
  }
}

export function chatTimelineFromStore(
  store: Pick<LocalChatStore, "messagePage">,
  topicId: string,
  options: ChatTimelineOptions = {}
): ChatTimeline {
  return mapTimeline(topicId, store.messagePage(topicId, options));
}

export function boundedChatPromptHistory(
  timeline: ChatTimeline,
  maximumBytes = 32_768
): ChatPromptHistory {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Chat prompt history byte budget must be positive");
  }
  const selected: ChatMessageSummary[] = [];
  for (let index = timeline.items.length - 1; index >= 0; index -= 1) {
    const candidate = [timeline.items[index]!, ...selected];
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > maximumBytes) break;
    selected.unshift(timeline.items[index]!);
  }
  const truncated = selected.length !== timeline.items.length;
  return {
    items: selected,
    hasEarlier: timeline.hasEarlier || truncated,
    ...((timeline.hasEarlier || truncated) && selected[0] !== undefined
      ? { beforeEventId: selected[0].eventId }
      : truncated && timeline.items.at(-1) !== undefined
        ? { beforeEventId: timeline.items.at(-1)!.eventId }
        : {})
  };
}

function mapTimeline(topicId: string, page: ChatMessagePage): ChatTimeline {
  return {
    topicId,
    items: page.items.map(messageSummary),
    hasEarlier: page.hasEarlier,
    ...(page.beforeEventId === undefined ? {} : { beforeEventId: page.beforeEventId })
  };
}

function messageSummary(event: ChatMessageEvent): ChatMessageSummary {
  return {
    eventId: event.eventId,
    createdAt: event.createdAt,
    sender: event.sender,
    body: event.body,
    ...(event.target === undefined ? {} : { target: event.target })
  };
}
