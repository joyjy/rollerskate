import { TopicInboxStore } from "../../infrastructure/files/topic-inbox-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";

export function listPassiveTopics(repoRoot: string, runtimeDirectory?: string) {
  return new TopicInboxStore(runtimePaths(repoRoot, runtimeDirectory).topicInbox)
    .topics()
    .map((entry) => ({
      topic: entry.topic,
      runtimeId: entry.view.subscription.runtimeId,
      cursor: entry.cursor,
      eventCount: entry.events.length,
      participantCount: entry.participants.length,
      syncedAt: entry.syncedAt
    }));
}

export function passiveTopicInboxView(repoRoot: string, runtimeDirectory?: string) {
  return new TopicInboxStore(runtimePaths(repoRoot, runtimeDirectory).topicInbox).topics();
}

export function passiveTopicHistory(
  repoRoot: string,
  topicId: string,
  runtimeDirectory?: string
) {
  const entry = new TopicInboxStore(runtimePaths(repoRoot, runtimeDirectory).topicInbox)
    .topics().find((candidate) => candidate.topic.id === topicId);
  if (entry === undefined) throw new Error(`Passive Topic not found: ${topicId}`);
  return {
    topic: entry.topic,
    cursor: entry.cursor,
    syncedAt: entry.syncedAt,
    events: entry.events
  };
}
