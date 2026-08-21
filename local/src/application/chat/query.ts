import { join } from "node:path";

import type {
  ChatMessageSummary,
  ChatPromptHistory,
  ChatTimeline
} from "../../core/chat/model.js";
import type { ChatMessageEvent } from "../../core/event/model.js";
import {
  LocalChatStore,
  type ChatMessagePage,
  type ChatReadProgress
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

export interface ChatMessageView extends ChatMessageSummary {
  readonly readProgress?: ChatReadProgress;
}

export interface ChatMessageViewPage {
  readonly topicId: string;
  readonly items: readonly ChatMessageView[];
  readonly hasEarlier: boolean;
  readonly beforeEventId?: string;
}

export interface ChatTimelineReader {
  readonly read: (topicId: string, options?: ChatTimelineOptions) => ChatTimeline;
  readonly close: () => void;
}

export function openChatTimelineReader(runtimeDirectory: string): ChatTimelineReader {
  const store = new LocalChatStore(join(runtimeDirectory, "runtime.db"));
  return {
    read: (topicId, options = {}) => chatTimelineFromStore(store, topicId, options),
    close: () => store.close()
  };
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

export function chatMessageViewsFromStore(
  store: Pick<LocalChatStore, "messagePage" | "readProgressForMessages">,
  topicId: string,
  options: ChatTimelineOptions = {}
): ChatMessageViewPage {
  const page = store.messagePage(topicId, options);
  const visibleItems = page.items.filter((item) => item.dispatchCard === undefined);
  const progress = store.readProgressForMessages(visibleItems.map((item) => item.eventId));
  return {
    topicId,
    items: visibleItems.map((message) => {
      const readProgress = progress.get(message.eventId);
      return {
        ...messageSummary(message),
        ...(readProgress === undefined ? {} : { readProgress })
      };
    }),
    hasEarlier: page.hasEarlier,
    ...(page.beforeEventId === undefined ? {} : { beforeEventId: page.beforeEventId })
  };
}

export function boundedChatPromptHistory(
  timeline: ChatTimeline,
  maximumBytes = 1_048_576
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

export function incrementalChatPromptHistory(
  history: ChatPromptHistory,
  boundary: {
    readonly sourceMessageEventId?: string;
    readonly dispatchCreatedAt: string;
    readonly agentId: string;
  }
): ChatPromptHistory {
  const boundaryTime = Date.parse(boundary.dispatchCreatedAt);
  if (!Number.isFinite(boundaryTime)) {
    throw new Error("Chat prompt Session boundary must be an ISO timestamp");
  }
  const sourceIndex = boundary.sourceMessageEventId === undefined
    ? -1
    : history.items.findIndex(({ eventId }) => eventId === boundary.sourceMessageEventId);
  const candidates = sourceIndex === -1
    ? history.items.filter((item) => Date.parse(item.createdAt) > boundaryTime)
    : history.items.slice(sourceIndex + 1);
  return {
    items: candidates.filter((item) => item.sender.principalId !== boundary.agentId),
    hasEarlier: false
  };
}

function mapTimeline(topicId: string, page: ChatMessagePage): ChatTimeline {
  const visibleItems = page.items.filter((item) => item.dispatchCard === undefined);
  return {
    topicId,
    items: visibleItems.map(messageSummary),
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
    ...(event.replyToEventId === undefined ? {} : { replyToEventId: event.replyToEventId }),
    ...(event.targets === undefined ? {} : { targets: event.targets })
  };
}
