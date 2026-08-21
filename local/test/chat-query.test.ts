import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  boundedChatPromptHistory,
  chatTimelineFromStore,
  incrementalChatPromptHistory
} from "../src/application/chat/query.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";

test("ChatTimeline pages one Topic by the stable createdAt and eventId cursor", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-chat-query-"));
  const databasePath = join(directory, "runtime.db");
  new RuntimeStore(databasePath).close();
  const chat = new LocalChatStore(databasePath);
  const at = "2026-07-25T12:00:00.000Z";
  try {
    const messages = Array.from({ length: 5 }, (_, index) => chat.postOwnerMessage({
      topicId: "topic-a",
      ownerPrincipalId: "owner-a",
      body: `message-${index}`,
      at
    }).message);
    const foreign = chat.postOwnerMessage({
      topicId: "topic-b",
      ownerPrincipalId: "owner-b",
      body: "foreign",
      at
    }).message;

    const newest = chatTimelineFromStore(chat, "topic-a", { limit: 2 });
    assert.equal(newest.items.length, 2);
    assert.equal(newest.hasEarlier, true);
    assert.equal(newest.beforeEventId, newest.items[0]?.eventId);
    assert.ok(newest.items.every((item) => item.sender.handleSnapshot === "owner"));

    const middle = chatTimelineFromStore(chat, "topic-a", {
      beforeEventId: newest.beforeEventId!,
      limit: 2
    });
    const oldest = chatTimelineFromStore(chat, "topic-a", {
      beforeEventId: middle.beforeEventId!,
      limit: 2
    });
    assert.equal(oldest.hasEarlier, false);
    assert.equal(oldest.beforeEventId, undefined);

    const paged = [...oldest.items, ...middle.items, ...newest.items].map(
      ({ eventId }) => eventId
    );
    const expected = messages.map(({ eventId }) => eventId).sort();
    assert.deepEqual(paged, expected);
    assert.throws(
      () => chat.messagePage("topic-a", { beforeEventId: foreign.eventId }),
      /not a message in Topic/u
    );
    assert.throws(
      () => chat.messagePage("topic-a", { limit: 10_001 }),
      /limit must be between 1 and 10000/u
    );
  } finally {
    chat.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bounded Chat prompt history keeps the newest complete message records", () => {
  const history = boundedChatPromptHistory({
    topicId: "topic-a",
    items: [
      summary("evt-1", "older"),
      summary("evt-2", "newer")
    ],
    hasEarlier: false
  }, 180);
  assert.equal(history.hasEarlier, true);
  assert.equal(history.beforeEventId, history.items[0]?.eventId ?? "evt-2");
  assert.ok(history.items.length < 2);
});

test("incremental Chat prompt history omits messages already held by a resumed Session", () => {
  const history = incrementalChatPromptHistory({
    items: [
      { ...summary("evt-1", "dispatch source"), createdAt: "2026-07-25T11:59:59.000Z" },
      {
        ...summary("evt-2", "own reply"),
        createdAt: "2026-07-25T12:00:01.000Z",
        sender: { kind: "agent", principalId: "agent-a", handleSnapshot: "alice" }
      },
      { ...summary("evt-3", "arrived while running"), createdAt: "2026-07-25T12:00:02.000Z" }
    ],
    hasEarlier: true,
    beforeEventId: "evt-1"
  }, {
    sourceMessageEventId: "evt-1",
    dispatchCreatedAt: "2026-07-25T12:00:00.000Z",
    agentId: "agent-a"
  });
  assert.deepEqual(history.items.map(({ eventId }) => eventId), ["evt-3"]);
  assert.equal(history.hasEarlier, false);
  assert.equal(history.beforeEventId, undefined);
});

function summary(eventId: string, body: string) {
  return {
    eventId,
    createdAt: "2026-07-25T12:00:00.000Z",
    sender: {
      kind: "owner" as const,
      principalId: "owner-a",
      handleSnapshot: "owner"
    },
    body
  };
}
