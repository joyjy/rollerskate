import { channelSendDeliveryOutcome } from "../../modules/channel/model.js";
import type { DatabaseSync } from "node:sqlite";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { assertCurrentLocalSchema } from "../../infrastructure/sqlite/schema/index.js";
import { ChannelStore } from "../../infrastructure/sqlite/channel-store.js";
import { LocalChatStore } from "../../infrastructure/sqlite/chat-store.js";
import { TopicInboxStore } from "../../infrastructure/files/topic-inbox-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { InteractiveChannelRuntime } from "./runtime.js";
import type { ChannelControlOptions } from "./control.js";

const MAX_DELTA_EVENTS = 100;
const MAX_DELTA_BYTES = 65_536;
const MAX_WAIT_MILLISECONDS = 30_000;

interface ChannelDeltaEvent {
  readonly cursor: string;
  readonly [key: string]: unknown;
}

export interface ChannelFollowQueryOptions extends ChannelControlOptions {
  readonly afterCursor?: string;
}

export function inspectInteractiveChannelBinding(
  repoRoot: string,
  bindingId: string,
  runtimeDirectory?: string
) {
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    assertCurrentLocalSchema(database);
    const store = new ChannelStore(database, { migrate: false });
    const binding = store.requireBinding(bindingId);
    return {
      binding,
      sends: store.followsForBinding(bindingId).map((follow) => ({
        receipt: store.requireSend(follow.sendId),
        follow
      }))
    };
  } finally {
    database.close();
  }
}

export function inspectInteractiveChannelFollow(
  repoRoot: string,
  followToken: string,
  runtimeDirectory?: string
) {
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    assertCurrentLocalSchema(database);
    const store = new ChannelStore(database, { migrate: false });
    const follow = store.requireFollow(followToken);
    const receipt=store.requireSend(follow.sendId);
    return { receipt, follow, deliveryOutcome:channelSendDeliveryOutcome(receipt) };
  } finally {
    database.close();
  }
}

export async function followInteractiveChannel(
  repoRoot: string,
  followToken: string,
  waitMilliseconds: number,
  options: ChannelFollowQueryOptions = {}
) {
  if (!Number.isInteger(waitMilliseconds) || waitMilliseconds < 0 ||
    waitMilliseconds > MAX_WAIT_MILLISECONDS) {
    throw new Error(`Channel follow wait must be between 0 and ${MAX_WAIT_MILLISECONDS} milliseconds`);
  }
  const initial = inspectInteractiveChannelFollow(
    repoRoot, followToken, options.runtimeDirectory
  );
  const afterCursor = options.afterCursor ?? initial.receipt.observedCursor;
  const deadline = Date.now() + waitMilliseconds;
  const runtime = new InteractiveChannelRuntime(repoRoot, options);
  try {
    while (true) {
      await runtime.runCycle((options.now?.() ?? new Date()).toISOString());
      const current = inspectInteractiveChannelFollow(
        repoRoot, followToken, options.runtimeDirectory
      );
      const delta = channelDelta(repoRoot, current, afterCursor, options.runtimeDirectory);
      if (delta.length > 0 || terminal(current.follow.status) || Date.now() >= deadline) {
        return {
          ...current,
          afterCursor,
          delta,
          nextCursor: delta.at(-1)?.cursor ?? afterCursor
        };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
  } finally {
    runtime.close();
  }
}

function channelDelta(
  repoRoot: string,
  current: ReturnType<typeof inspectInteractiveChannelFollow>,
  afterCursor: string | undefined,
  runtimeDirectory: string | undefined
): readonly ChannelDeltaEvent[] {
  if (afterCursor === undefined) return [];
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  if (current.follow.channelRef.kind === "local-chat") {
    const database = openRuntimeDatabaseReadOnly(paths.database);
    try {
      assertCurrentLocalSchema(database);
      const chat = new LocalChatStore(database);
      return boundedDelta(chat.eventsAfter(
        current.follow.channelRef.channelId, afterCursor, MAX_DELTA_EVENTS, { messagesOnly: true }
      ).flatMap((event) => event.type !== "chat.message" ? [] : [{
          cursor: event.eventId,
          eventId: event.eventId,
          createdAt: event.createdAt,
          sender: event.sender,
          body: event.body,
          correlation: current.receipt.conversationRootId !== undefined &&
            event.causality.rootEventId === current.receipt.conversationRootId
            ? "conversation_reply"
            : "new_message"
        }]));
    } finally {
      database.close();
    }
  }
  const inbox = new TopicInboxStore(paths.topicInbox);
  const sequence = Number(afterCursor);
  const events = inbox.topics().find(
    ({ topic }) => topic.id === current.follow.channelRef.channelId
  )?.events ?? [];
  return boundedDelta(events.filter(({ sequence: candidate }) => candidate > sequence)
    .slice(0, MAX_DELTA_EVENTS).map((event) => ({
      cursor: String(event.sequence),
      eventId: event.eventId,
      createdAt: event.createdAt,
      publisher: event.publisher,
      body: event.body,
      correlation: "new_message"
    })));
}

function boundedDelta(events: readonly ChannelDeltaEvent[]): readonly ChannelDeltaEvent[] {
  const result: ChannelDeltaEvent[] = [];
  let bytes = 2;
  for (const event of events.slice(0, MAX_DELTA_EVENTS)) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
    if (bytes + eventBytes > MAX_DELTA_BYTES) {
      if (result.length === 0) {
        const reference = {
          cursor: event.cursor,
          ...(typeof event.eventId === "string" ? { eventId: event.eventId } : {}),
          ...(typeof event.createdAt === "string" ? { createdAt: event.createdAt } : {}),
          ...(typeof event.correlation === "string" ? { correlation: event.correlation } : {}),
          truncated: true
        };
        result.push(reference);
      }
      break;
    }
    result.push(event);
    bytes += eventBytes;
  }
  return result;
}

function terminal(status: string): boolean {
  return ["quiet", "terminal", "failed", "expired", "stopped"].includes(status);
}

/** Bounded source-owned discovery for the invoking Agent. */
export function listInteractiveChannels(database: DatabaseSync, agentId: string, page = 1) {
  const rows = database.prepare(`SELECT binding_id FROM interactive_channel_bindings
    WHERE agent_id = ? ORDER BY updated_at DESC, binding_id DESC LIMIT 21 OFFSET ?`)
    .all(agentId,(page-1)*20) as {binding_id:string}[];
  const store = new ChannelStore(database,{migrate:false});
  try { return {page,hasMore:rows.length>20,items:rows.slice(0,20).map(row => ({
    binding:store.requireBinding(row.binding_id),
    follows:store.followsForBinding(row.binding_id,10)
  }))}; } finally {store.close();}
}

/** Snapshot only. Unlike the CLI wait helper this never advances Runtime work. */
export function readInteractiveChannelFollow(repoRoot: string, followToken: string,
  options: ChannelFollowQueryOptions = {}) {
  const current = inspectInteractiveChannelFollow(repoRoot,followToken,options.runtimeDirectory);
  const afterCursor = options.afterCursor ?? current.receipt.observedCursor;
  const delta = channelDelta(repoRoot,current,afterCursor,options.runtimeDirectory);
  return {...current,delta,nextCursor:delta.at(-1)?.cursor ?? afterCursor};
}
