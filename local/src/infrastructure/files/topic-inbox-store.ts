import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { isDeepStrictEqual } from "node:util";

import {
  agentPublicProfileSchema,
  topicEventPageSchema,
  topicRuntimeViewListSchema,
  topicSummarySchema,
  type AgentPublicProfile,
  type TopicEventPage,
  type TopicRuntimeView,
  type TopicSummary
} from "../../protocol.js";
import type { ChatProfileContext } from "../../core/chat/model.js";

const MAX_PROJECTED_EVENTS_PER_TOPIC = 2_000;
const PROFILE_TTL_MILLISECONDS = 5 * 60 * 1_000;

export interface LocalTopicParticipant {
  readonly localAgentId: string;
  readonly serverAgentId: string;
  readonly profile: AgentPublicProfile;
}

export interface LocalTopicInboxEntry {
  readonly view: TopicRuntimeView;
  readonly topic: TopicSummary;
  readonly participants: readonly LocalTopicParticipant[];
  readonly events: TopicEventPage["events"];
  readonly cursor: number;
  readonly syncedAt: string;
}

interface TopicInboxDocument {
  readonly schemaVersion: 2;
  readonly topics: readonly LocalTopicInboxEntry[];
}

export class TopicInboxStore {
  readonly #path: string;

  public constructor(path: string) {
    this.#path = path;
    this.#migrateLegacyDocument();
  }

  public cursor(topicId: string): number {
    return this.#read().topics.find((entry) => entry.topic.id === topicId)?.cursor ?? 0;
  }

  public topics(): readonly LocalTopicInboxEntry[] {
    return this.#read().topics;
  }

  public participant(
    topicId: string,
    localAgentId: string
  ): LocalTopicParticipant | undefined {
    return this.#read().topics
      .find((entry) => entry.topic.id === topicId)
      ?.participants.find((participant) => participant.localAgentId === localAgentId);
  }

  public localParticipantIds(topicId: string): readonly string[] {
    return this.#read().topics
      .find((entry) => entry.topic.id === topicId)
      ?.participants.map((participant) => participant.localAgentId) ?? [];
  }

  public commit(input: {
    readonly view: TopicRuntimeView;
    readonly topic: TopicSummary;
    readonly participants: readonly LocalTopicParticipant[];
    readonly page: TopicEventPage;
    readonly syncedAt: string;
  }): LocalTopicInboxEntry {
    const syncedAt = timestamp(input.syncedAt);
    if (input.view.subscription.topicId !== input.topic.id ||
      input.page.topicId !== input.topic.id ||
      input.page.runtimeId !== input.view.subscription.runtimeId) {
      throw new Error("Topic inbox sync identity mismatch");
    }
    const document = this.#read();
    const current = document.topics.find((entry) => entry.topic.id === input.topic.id);
    const events = new Map((current?.events ?? []).map((event) => [event.eventId, event]));
    for (const event of input.page.events) {
      const existing = events.get(event.eventId);
      if (existing !== undefined && !isDeepStrictEqual(existing, event)) {
        throw new Error(`Topic inbox Event changed during replay: ${event.eventId}`);
      }
      events.set(event.eventId, event);
    }
    const projected = [...events.values()]
      .sort((a, b) => a.sequence - b.sequence)
      .slice(-MAX_PROJECTED_EVENTS_PER_TOPIC);
    const cursor = Math.max(
      current?.cursor ?? 0,
      input.page.nextCursor,
      projected.at(-1)?.sequence ?? 0
    );
    const entry: LocalTopicInboxEntry = {
      view: input.view,
      topic: input.topic,
      participants: input.participants,
      events: projected,
      cursor,
      syncedAt
    };
    this.#write({
      schemaVersion: 2,
      topics: [...document.topics.filter((item) => item.topic.id !== input.topic.id), entry]
        .sort((a, b) => a.topic.id.localeCompare(b.topic.id))
    });
    return entry;
  }

  public profileResolution(
    localAgentId: string,
    topicId: string
  ): { readonly kind: "local" } | { readonly kind: "public"; readonly context?: ChatProfileContext } {
    const entry = this.#read().topics.find((item) => item.topic.id === topicId);
    if (entry === undefined || entry.topic.visibility !== "public") return { kind: "local" };
    const participant = entry.participants.find((item) => item.localAgentId === localAgentId);
    if (participant === undefined) return { kind: "public" };
    return {
      kind: "public",
      context: {
        schema: "ChatProfileContext@1",
        visibility: "public",
        resolvedAt: entry.syncedAt,
        validUntil: new Date(Date.parse(entry.syncedAt) + PROFILE_TTL_MILLISECONDS).toISOString(),
        agent: {
          ...participant.profile,
          agentId: participant.localAgentId
        },
        topic: entry.topic.profile,
        precedence: "topic-rules-further-restrict-agent-rules"
      }
    };
  }

  #read(): TopicInboxDocument {
    if (!existsSync(this.#path)) return { schemaVersion: 2, topics: [] };
    assertPrivateFile(this.#path);
    const value = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
    if (!isRecord(value) ||
      (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
      !Array.isArray(value.topics)) {
      throw new Error("Topic inbox has an unsupported schema");
    }
    return {
      schemaVersion: 2,
      topics: value.topics.map(parseEntry)
    };
  }

  #migrateLegacyDocument(): void {
    if (!existsSync(this.#path)) return;
    assertPrivateFile(this.#path);
    const value = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
    if (!isRecord(value) || value.schemaVersion !== 1) return;
    this.#write(this.#read());
  }

  #write(document: TopicInboxDocument): void {
    if (existsSync(this.#path) && lstatSync(this.#path).isSymbolicLink()) {
      throw new Error("Topic inbox must not be a symlink");
    }
    const temporary = `${this.#path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8", mode: 0o600, flag: "wx"
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.#path);
      chmodSync(this.#path, 0o600);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}

function parseEntry(value: unknown): LocalTopicInboxEntry {
  if (!isRecord(value) || !Array.isArray(value.participants) ||
    !Array.isArray(value.events) || !Number.isInteger(value.cursor)) {
    throw new Error("Topic inbox entry is malformed");
  }
  const view = topicRuntimeViewListSchema.parse([value.view])[0]!;
  const topic = topicSummarySchema.parse(value.topic);
  const page = topicEventPageSchema.parse({
    topicId: topic.id,
    runtimeId: view.subscription.runtimeId,
    events: value.events.map(normalizeTopicEvent),
    nextCursor: value.cursor,
    head: Math.max(value.cursor as number, 0)
  });
  const participants = value.participants.map((participant) => {
    if (!isRecord(participant) || typeof participant.localAgentId !== "string" ||
      typeof participant.serverAgentId !== "string") {
      throw new Error("Topic inbox participant is malformed");
    }
    return {
      localAgentId: participant.localAgentId,
      serverAgentId: participant.serverAgentId,
      profile: agentPublicProfileSchema.parse(participant.profile)
    };
  });
  return {
    view,
    topic,
    participants,
    events: page.events,
    cursor: value.cursor as number,
    syncedAt: timestamp(value.syncedAt)
  };
}

function normalizeTopicEvent(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.publisher) ||
    value.publisher.kind !== undefined || typeof value.publisherAgentId !== "string") {
    return value;
  }
  const { publisherAgentId: _publisherAgentId, ...event } = value;
  return {
    ...event,
    publisher: {
      kind: "agent",
      ...value.publisher
    }
  };
}

function assertPrivateFile(path: string): void {
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
    throw new Error("Topic inbox must be a regular file");
  }
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error("Topic inbox must be private to the owner");
  }
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("Topic inbox timestamp is invalid");
  }
  return new Date(value).toISOString();
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
