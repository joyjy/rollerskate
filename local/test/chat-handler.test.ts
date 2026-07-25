import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChatHandler } from "../src/application/chat/handler.js";
import {
  loadChatMentionPromptResource,
  loadChatPromptResource
} from "../src/application/chat/prompt.js";
import { addLocalAgent, localRuntimeSnapshot } from "../src/application/agent/control.js";
import { postLocalChatMessage } from "../src/application/chat/control.js";
import {
  chatMentionPromptResourceId,
  chatPromptResourceId
} from "../src/core/chat/model.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";

test("ChatHandler dispatches an unmentioned message to each available Agent with resource context", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-handler-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-handler-runtime-"));
  const options = { runtimeDirectory };
  try {
    addLocalAgent(repo, "alice", "codex", options);
    addLocalAgent(repo, "bob", "codex", options);
    const source = postLocalChatMessage(repo, "Can either of you inspect this?", options).message;
    const snapshot = localRuntimeSnapshot(repo, options);
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    const chat = new LocalChatStore(join(runtimeDirectory, "runtime.db"));
    try {
      const execution = runtime.claimDueExecutions(1, source.createdAt)[0]!;
      const handler = new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => snapshot.agents,
        prompt: {
          resourceId: chatPromptResourceId,
          render: (context) => JSON.stringify(context)
        }
      });
      const dispatchIds = handler.handle(execution, source.createdAt);
      assert.equal(dispatchIds.length, 2);
      const dispatches = dispatchIds.map((eventId) => runtime.event(eventId));
      assert.deepEqual(
        dispatches.map((event) => event?.type === "chat.dispatch"
          ? event.targetHandleSnapshot
          : undefined),
        ["alice", "bob"]
      );
      for (const event of dispatches) {
        assert.equal(event?.type, "chat.dispatch");
        if (event?.type !== "chat.dispatch") continue;
        assert.equal(event.promptResourceId, chatPromptResourceId);
        assert.match(event.prompt, /Can either of you inspect this/);
        assert.match(event.prompt, /attentionReason/);
      }
    } finally {
      chat.close();
      runtime.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("ChatHandler prompt history excludes later queued messages", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-causal-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-causal-runtime-"));
  const options = { runtimeDirectory };
  try {
    const alice = addLocalAgent(repo, "alice", "codex", options);
    const earlier = postLocalChatMessage(repo, "earlier", {
      ...options,
      now: () => new Date("2026-07-25T10:00:00.000Z")
    }).message;
    const current = postLocalChatMessage(repo, "current", {
      ...options,
      now: () => new Date("2026-07-25T11:00:00.000Z")
    }).message;
    const later = postLocalChatMessage(repo, "later queued", {
      ...options,
      now: () => new Date("2026-07-25T12:00:00.000Z")
    }).message;
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    const chat = new LocalChatStore(join(runtimeDirectory, "runtime.db"));
    try {
      const firstExecution = runtime.claimDueExecutions(
        1,
        "2026-07-25T12:00:00.000Z"
      )[0]!;
      new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => []
      }).handle(firstExecution, "2026-07-25T12:00:00.000Z");

      const currentExecution = runtime.claimDueExecutions(
        1,
        "2026-07-25T12:00:00.000Z"
      )[0]!;
      const dispatchId = new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => [alice],
        prompt: {
          resourceId: chatPromptResourceId,
          render: (context) => JSON.stringify(context)
        }
      }).handle(currentExecution, "2026-07-25T12:00:00.000Z")[0]!;
      const dispatch = runtime.event(dispatchId);
      assert.equal(dispatch?.type, "chat.dispatch");
      if (dispatch?.type !== "chat.dispatch") return;
      const context = JSON.parse(dispatch.prompt) as {
        latestMessage: { eventId: string };
        history: { items: Array<{ eventId: string }> };
      };
      assert.equal(context.latestMessage.eventId, current.eventId);
      assert.deepEqual(context.history.items.map(({ eventId }) => eventId), [earlier.eventId]);
      assert.ok(!context.history.items.some(({ eventId }) => eventId === later.eventId));
    } finally {
      chat.close();
      runtime.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("bundled Chat prompt is a separately loaded resource", () => {
  const resource = loadChatPromptResource();
  const rendered = resource.render({
    agent: { agentId: "agent-a", handle: "alice" },
    topicId: "topic-a",
    attentionReason: "available",
    currentPresence: {
      global: { scope: "global", mode: "available", wakeKeywords: [] },
      topic: { scope: "topic", mode: "available", wakeKeywords: [] }
    },
    latestMessage: {
      eventId: "evt-latest",
      type: "chat.message",
      source: { kind: "cli" },
      destinationIds: [],
      topicId: "topic-a",
      sender: { kind: "owner", handleSnapshot: "owner" },
      body: "hello",
      causality: { rootEventId: "evt-latest", hop: 0 },
      createdAt: "2026-07-25T12:00:00.000Z"
    },
    history: { items: [], hasEarlier: false },
    now: "2026-07-25T12:00:00.000Z"
  });
  assert.equal(resource.resourceId, chatPromptResourceId);
  assert.match(rendered, /ChatDecision@1/);
  assert.match(rendered, /"topicId": "topic-a"/);
  assert.ok(!rendered.includes("type: Prompt"));
  assert.ok(!rendered.includes("resource: prompt.chat.free-turn"));
  assert.ok(!rendered.includes("{{CHAT_CONTEXT_JSON}}"));
});

test("direct mention uses a speech-only prompt resource", () => {
  const resource = loadChatMentionPromptResource();
  const rendered = resource.render({
    agent: { agentId: "agent-a", handle: "alice" },
    topicId: "topic-a",
    attentionReason: "direct-mention",
    currentPresence: {
      global: {
        scope: "global",
        mode: "snoozed",
        until: "2026-07-25T13:00:00.000Z",
        wakeKeywords: []
      },
      topic: { scope: "topic", mode: "available", wakeKeywords: [] }
    },
    latestMessage: {
      eventId: "evt-latest",
      type: "chat.message",
      source: { kind: "cli" },
      destinationIds: [],
      topicId: "topic-a",
      sender: { kind: "owner", handleSnapshot: "owner" },
      target: { principalId: "agent-a", handleSnapshot: "alice" },
      body: "@alice hello",
      causality: { rootEventId: "evt-latest", hop: 0 },
      createdAt: "2026-07-25T12:00:00.000Z"
    },
    history: { items: [], hasEarlier: false },
    now: "2026-07-25T12:00:00.000Z"
  });
  assert.equal(resource.resourceId, chatMentionPromptResourceId);
  assert.match(rendered, /ChatMentionDecision@1/);
  assert.match(rendered, /cannot change Topic or Global presence/);
  assert.ok(!rendered.includes("type: Prompt"));
  assert.ok(!rendered.includes("{{CHAT_CONTEXT_JSON}}"));
});
