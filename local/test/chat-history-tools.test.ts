import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  chatTimelineFromStore,
  type ChatTimelineOptions
} from "../src/application/chat/query.js";
import {
  callChatHistoryTool,
  chatHistoryToolDefinitions,
  type ChatHistoryMcpContext
} from "../src/entrypoints/mcp/chat-history.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";

test("Chat history tool pages only the current Topic through a chained cursor", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-chat-history-tool-"));
  const database = join(directory, "runtime.db");
  new RuntimeStore(database).close();
  const chat = new LocalChatStore(database);
  try {
    const first = chat.postOwnerMessage({
      topicId: "topic-a",
      ownerPrincipalId: "owner-a",
      body: "first",
      at: "2026-08-19T00:00:00.000Z"
    }).message;
    const second = chat.postOwnerMessage({
      topicId: "topic-a",
      ownerPrincipalId: "owner-a",
      body: "second",
      at: "2026-08-19T00:01:00.000Z"
    }).message;
    const current = chat.postOwnerMessage({
      topicId: "topic-a",
      ownerPrincipalId: "owner-a",
      body: "current",
      at: "2026-08-19T00:02:00.000Z"
    }).message;
    chat.postOwnerMessage({
      topicId: "topic-b",
      ownerPrincipalId: "owner-b",
      body: "foreign",
      at: "2026-08-19T00:01:30.000Z"
    });
    const context: ChatHistoryMcpContext = {
      history: {
        read: (topicId: string, options: ChatTimelineOptions = {}) =>
          chatTimelineFromStore(chat, topicId, options)
      },
      topicId: "topic-a",
      initialCursor: current.eventId,
      expectedCursor: undefined,
      requests: 0,
      returnedBytes: 0
    };
    const newest = callChatHistoryTool(context, "read_chat_history", { limit: 1 }) as {
      readonly items: readonly { readonly eventId: string }[];
      readonly beforeEventId?: string;
    };
    assert.deepEqual(newest.items.map(({ eventId }) => eventId), [second.eventId]);
    assert.equal(newest.beforeEventId, second.eventId);
    assert.throws(
      () => callChatHistoryTool(context, "read_chat_history", {
        beforeEventId: current.eventId,
        limit: 1
      }),
      /cursor does not match/u
    );
    const oldest = callChatHistoryTool(context, "read_chat_history", {
      beforeEventId: second.eventId,
      limit: 1
    }) as { readonly items: readonly { readonly eventId: string }[] };
    assert.deepEqual(oldest.items.map(({ eventId }) => eventId), [first.eventId]);
    assert.deepEqual(chatHistoryToolDefinitions.map((tool) => tool.name), [
      "read_chat_history"
    ]);
  } finally {
    chat.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
