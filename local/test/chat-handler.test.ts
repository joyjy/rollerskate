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
import {
  localChatView,
  postLocalChatMessage
} from "../src/application/chat/control.js";
import { eventTraceViews } from "../src/application/event/query.js";
import {
  chatMentionPromptResourceId,
  chatPromptResourceId
} from "../src/core/chat/model.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { parseChatDecisionReceipt } from "../src/core/runtime/store/codec.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";

test("legacy typed silence without a reason remains readable", () => {
  assert.deepEqual(parseChatDecisionReceipt(JSON.stringify({
    schema: "ChatDecisionReceipt@1",
    dispatchEventId: "evt_019f92c9-0000-7000-8000-000000000011",
    speechAction: "silent",
    createdAt: "2026-07-25T00:00:00.000Z"
  })), {
    dispatchEventId: "evt_019f92c9-0000-7000-8000-000000000011",
    speechAction: "silent",
    createdAt: "2026-07-25T00:00:00.000Z"
  });
});

test("Chat activation starts an empty Topic exactly once and enforces its turn budget", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-activation-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-activation-runtime-"));
  const options = { runtimeDirectory };
  const at = "2026-07-31T10:00:00.000Z";
  try {
    const alice = addLocalAgent(repo, "alice", "codex", options);
    const bob = addLocalAgent(repo, "bob", "codex", options);
    const snapshot = localRuntimeSnapshot(repo, options);
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    const chat = new LocalChatStore(join(runtimeDirectory, "runtime.db"));
    try {
      const first = runtime.createChatActivation({
        topicId: snapshot.foundation.topicId,
        reason: "topic_opened",
        strategyId: "starter",
        conversationIntent: continueRecentIntent(1),
        candidateAgentIds: [bob.principalId, alice.principalId],
        idempotencyKey: "empty-topic-starter",
        turnBudget: 1
      }, at);
      const duplicate = runtime.createChatActivation({
        topicId: snapshot.foundation.topicId,
        reason: "topic_opened",
        strategyId: "starter",
        conversationIntent: continueRecentIntent(1),
        candidateAgentIds: [alice.principalId],
        idempotencyKey: "empty-topic-starter",
        turnBudget: 8
      }, at);
      assert.equal(first.status, "accepted");
      assert.equal(duplicate.status, "duplicate");
      assert.equal(duplicate.event.eventId, first.event.eventId);
      const overlapping = runtime.createChatActivation({
        topicId: snapshot.foundation.topicId,
        reason: "manual",
        strategyId: "manual",
        conversationIntent: continueRecentIntent(1),
        candidateAgentIds: [alice.principalId, bob.principalId],
        idempotencyKey: "second-click",
        turnBudget: 8
      }, at);
      assert.equal(overlapping.status, "duplicate");
      assert.equal(overlapping.event.eventId, first.event.eventId);

      const execution = runtime.claimDueExecutions(1, at)[0]!;
      const dispatchIds = new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => snapshot.agents,
        prompt: {
          resourceId: chatPromptResourceId,
          render: (context) => JSON.stringify(context)
        }
      }).handle(execution, at);
      assert.equal(dispatchIds.length, 1);
      const overlappingWhileAgentRuns = runtime.createChatActivation({
        topicId: snapshot.foundation.topicId,
        reason: "manual",
        strategyId: "manual",
        conversationIntent: continueRecentIntent(1),
        candidateAgentIds: [alice.principalId],
        idempotencyKey: "third-click",
        turnBudget: 8
      }, at);
      assert.equal(overlappingWhileAgentRuns.status, "duplicate");
      assert.equal(overlappingWhileAgentRuns.event.eventId, first.event.eventId);
      const dispatch = runtime.event(dispatchIds[0]!);
      assert.equal(dispatch?.type, "chat.dispatch");
      if (dispatch?.type !== "chat.dispatch") return;
      const context = JSON.parse(dispatch.prompt) as {
        turnMode: string;
        latestMessage?: unknown;
        conversationIntent: { mode: string };
        activation?: unknown;
        history: { items: unknown[] };
      };
      assert.equal(context.turnMode, "proactive_contribution");
      assert.equal(context.latestMessage, undefined);
      assert.equal(context.conversationIntent.mode, "continue_recent");
      assert.equal(context.activation, undefined);
      assert.ok(!dispatch.prompt.includes("first-click"));
      assert.ok(!dispatch.prompt.includes(first.event.eventId));
      assert.deepEqual(context.history.items, []);
      assert.equal(runtime.chatAttentionReceipts(first.event.eventId).length, 2);
      assert.equal(runtime.chatAttentionReceipts(first.event.eventId)
        .filter((receipt) => receipt.outcome === "dispatched").length, 1);
      assert.equal(runtime.chatAttentionReceipts(first.event.eventId)
        .some((receipt) => receipt.reason === "turn-budget-exhausted"), true);
      const agentExecution = runtime.claimDueExecutions(1, at)[0]!;
      const reply = runtime.completeExecution(agentExecution.executionId, {
        adapterId: "fixture",
        workspace: repo,
        providerSessionId: "activation-session",
        chatDecision: {
          schema: "ChatDecision@1",
          speech: { action: "reply", body: "I will open this conversation." },
          presence: { scope: "topic", mode: "available", wakeKeywords: [] }
        }
      }, at);
      assert.equal(reply?.type, "chat.message");
      if (reply?.type !== "chat.message") return;
      assert.equal(reply.sender.kind, "agent");
      assert.equal(reply.body, "I will open this conversation.");
      const continuation = runtime.claimDueExecutions(1, at)[0]!;
      assert.deepEqual(new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => snapshot.agents
      }).handle(continuation, at), []);
      assert.equal(runtime.claimDueExecutions(10, at).length, 0);
      const projected = localChatView(repo, options);
      assert.equal(projected.conversation.state, "budget_exhausted");
      assert.ok(projected.messages.items.some((message) =>
        message.readProgress?.agents.some((agent) =>
          agent.reason === "turn-budget-exhausted")));
      const rootTimeline = eventTraceViews(runtime.audits()).find((audit) =>
        audit.event.eventId === first.event.eventId)?.conversationTimeline;
      assert.deepEqual(rootTimeline?.map((step) => step.type), [
        "chat.activation",
        "chat.dispatch",
        "chat.message"
      ]);
      assert.ok(rootTimeline?.some((step) =>
        step.status === "stopped" && step.reason === "turn-budget-exhausted"));
    } finally {
      chat.close();
      runtime.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("Agent conversation excludes each sender and stops at the shared activation budget", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-conversation-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-conversation-runtime-"));
  const options = { runtimeDirectory };
  const at = "2026-07-31T10:30:00.000Z";
  try {
    const alice = addLocalAgent(repo, "alice", "codex", options);
    const bob = addLocalAgent(repo, "bob", "kimi-code", options);
    const snapshot = localRuntimeSnapshot(repo, options);
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    const chat = new LocalChatStore(join(runtimeDirectory, "runtime.db"));
    const handler = new ChatHandler({
      store: runtime,
      chat,
      listAgents: () => snapshot.agents
    });
    try {
      const activation = runtime.createChatActivation({
        topicId: snapshot.foundation.topicId,
        reason: "topic_opened",
        strategyId: "starter",
        conversationIntent: continueRecentIntent(1),
        candidateAgentIds: [alice.principalId],
        idempotencyKey: "agent-conversation",
        turnBudget: 3
      }, at).event;

      const starterExecution = runtime.claimDueExecutions(1, at)[0]!;
      const aliceDispatchId = handler.handle(starterExecution, at)[0]!;
      const aliceExecution = runtime.claimDueExecutions(1, at)[0]!;
      const aliceMessage = runtime.completeExecution(aliceExecution.executionId, {
        adapterId: "fixture",
        workspace: repo,
        providerSessionId: "alice-session",
        chatDecision: {
          schema: "ChatDecision@1",
          speech: { action: "reply", body: "Alice opens the discussion." },
          presence: { scope: "topic", mode: "available", wakeKeywords: [] }
        }
      }, at);
      assert.equal(aliceMessage?.type, "chat.message");

      const firstContinuation = runtime.claimDueExecutions(1, at)[0]!;
      const bobDispatchId = handler.handle(firstContinuation, at)[0]!;
      assert.equal(runtime.event(bobDispatchId)?.type, "chat.dispatch");
      assert.equal(
        runtime.chatAttentionReceipts(aliceMessage!.eventId)
          .find((receipt) => receipt.agentId === alice.principalId)?.reason,
        "sender"
      );
      const bobExecution = runtime.claimDueExecutions(1, at)[0]!;
      const bobMessage = runtime.completeExecution(bobExecution.executionId, {
        adapterId: "fixture",
        workspace: repo,
        providerSessionId: "bob-session",
        chatDecision: {
          schema: "ChatDecision@1",
          speech: { action: "reply", body: "Bob challenges that opening." },
          presence: { scope: "topic", mode: "available", wakeKeywords: [] }
        }
      }, at);
      assert.equal(bobMessage?.type, "chat.message");

      const secondContinuation = runtime.claimDueExecutions(1, at)[0]!;
      const secondAliceDispatchId = handler.handle(secondContinuation, at)[0]!;
      assert.notEqual(secondAliceDispatchId, aliceDispatchId);
      assert.equal(
        runtime.chatAttentionReceipts(bobMessage!.eventId)
          .find((receipt) => receipt.agentId === bob.principalId)?.reason,
        "sender"
      );
      const secondAliceExecution = runtime.claimDueExecutions(1, at)[0]!;
      const secondAliceMessage = runtime.completeExecution(secondAliceExecution.executionId, {
        adapterId: "fixture",
        workspace: repo,
        providerSessionId: "alice-session",
        chatDecision: {
          schema: "ChatDecision@1",
          speech: { action: "reply", body: "Alice answers the challenge." },
          presence: { scope: "topic", mode: "available", wakeKeywords: [] }
        }
      }, at);
      assert.equal(secondAliceMessage?.type, "chat.message");

      const budgetStop = runtime.claimDueExecutions(1, at)[0]!;
      assert.deepEqual(handler.handle(budgetStop, at), []);
      assert.equal(
        runtime.chatAttentionReceipts(secondAliceMessage!.eventId)
          .find((receipt) => receipt.agentId === bob.principalId)?.reason,
        "turn-budget-exhausted"
      );
      assert.equal(runtime.events().filter((event) =>
        event.type === "chat.dispatch" &&
        event.causality.rootEventId === activation.eventId).length, 3);
      assert.equal(runtime.claimDueExecutions(10, at).length, 0);
    } finally {
      chat.close();
      runtime.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("ChatHandler dispatches an unmentioned message to each available Agent with resource context", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-handler-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-handler-runtime-"));
  const options = { runtimeDirectory };
  try {
    addLocalAgent(repo, "alice", "codex", options);
    addLocalAgent(repo, "bob", "kimi-code", options);
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
      const contexts = dispatches.map((event) => event?.type === "chat.dispatch"
        ? JSON.parse(event.prompt) as {
            agent: { handle: string };
            chatHistory: { schema: string };
          }
        : undefined);
      assert.equal(
        contexts.find((context) => context?.agent.handle === "alice")?.chatHistory.schema,
        "ChatHistoryToolsCapability@1"
      );
      assert.equal(
        contexts.find((context) => context?.agent.handle === "bob")?.chatHistory.schema,
        "ChatHistoryRequestCapability@1"
      );
    } finally {
      chat.close();
      runtime.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("ChatHandler isolates optional client-history failure to one Agent dispatch", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-agent-isolation-repo-"));
  const runtimeDirectory = mkdtempSync(
    join(tmpdir(), "rollerskate-chat-agent-isolation-runtime-")
  );
  const options = { runtimeDirectory };
  const at = "2099-07-25T12:00:00.000Z";
  try {
    const alice = addLocalAgent(repo, "alice", "codex", options);
    const pi = addLocalAgent(repo, "pi-deepseek", "pi", options);
    const source = postLocalChatMessage(repo, "@alice @pi-deepseek inspect this", {
      ...options,
      now: () => new Date(at)
    }).message;
    assert.deepEqual(source.targets, [
      { principalId: alice.principalId, handleSnapshot: "alice" },
      { principalId: pi.principalId, handleSnapshot: "pi-deepseek" }
    ]);
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    const chat = new LocalChatStore(join(runtimeDirectory, "runtime.db"));
    try {
      const execution = runtime.claimDueExecutions(1, at)[0]!;
      const historyFailures: Array<{ agentId: string; error: unknown }> = [];
      const dispatchIds = new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => [alice, pi],
        resolveClientHistory: (agentId) => {
          if (agentId === pi.principalId) {
            throw new Error("pi executable was not found in PATH");
          }
          return undefined;
        },
        reportClientHistoryFailure: (agentId, error) => {
          historyFailures.push({ agentId, error });
        }
      }).handle(execution, at);
      assert.equal(dispatchIds.length, 2);
      assert.equal(historyFailures.length, 1);
      assert.equal(historyFailures[0]?.agentId, pi.principalId);
      assert.match(String(historyFailures[0]?.error), /pi executable was not found in PATH/);

      const agentExecutions = runtime.claimDueExecutions(10, at);
      const aliceExecution = agentExecutions.find((candidate) =>
        runtime.event(candidate.eventId)?.agentId === alice.principalId
      )!;
      let piExecution = agentExecutions.find((candidate) =>
        runtime.event(candidate.eventId)?.agentId === pi.principalId
      )!;
      runtime.completeExecution(aliceExecution.executionId, {
        adapterId: "fixture",
        workspace: repo,
        providerSessionId: "alice-session",
        chatDecision: {
          schema: "ChatMentionDecision@1",
          speech: { action: "silent", reason: "Nothing to add." }
        }
      }, at);
      runtime.failExecution(
        piExecution.executionId,
        "pi executable was not found in PATH",
        at,
        1
      );
      piExecution = runtime.claimDueExecutions(1, "2099-07-25T12:00:01.000Z")[0]!;
      runtime.failExecution(
        piExecution.executionId,
        "pi executable was not found in PATH",
        "2099-07-25T12:00:01.000Z",
        1
      );
      piExecution = runtime.claimDueExecutions(1, "2099-07-25T12:00:02.000Z")[0]!;
      runtime.failExecution(
        piExecution.executionId,
        "pi executable was not found in PATH",
        "2099-07-25T12:00:02.000Z",
        1
      );

      assert.deepEqual(
        localChatView(repo, options).messages.items.find(
          (message) => message.eventId === source.eventId
        )?.readProgress?.agents.map(({ handleSnapshot, state }) => ({
          handleSnapshot,
          state
        })),
        [
          { handleSnapshot: "alice", state: "read" },
          { handleSnapshot: "pi-deepseek", state: "failed" }
        ]
      );
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

test("ChatHandler sends only the per-Agent message slice after a resumed Session", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-slice-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-slice-runtime-"));
  const options = { runtimeDirectory };
  try {
    const alice = addLocalAgent(repo, "alice", "codex", options);
    const first = postLocalChatMessage(repo, "first bootstrap", {
      ...options,
      now: () => new Date("2026-07-25T10:00:00.000Z")
    }).message;
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    const chat = new LocalChatStore(join(runtimeDirectory, "runtime.db"));
    try {
      const firstMessageExecution = runtime.claimDueExecutions(
        1,
        "2026-07-25T10:00:00.000Z"
      )[0]!;
      const firstDispatchId = new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => [alice],
        prompt: {
          resourceId: chatPromptResourceId,
          render: (context) => JSON.stringify(context)
        }
      }).handle(firstMessageExecution, "2026-07-25T10:00:00.000Z")[0]!;
      const firstAgentExecution = runtime.claimDueExecutions(
        1,
        "2026-07-25T10:00:00.000Z"
      )[0]!;
      assert.equal(firstAgentExecution.eventId, firstDispatchId);
      runtime.completeExecution(firstAgentExecution.executionId, {
        adapterId: "fixture",
        workspace: repo,
        providerSessionId: "provider-alice",
        chatDecision: {
          schema: "ChatDecision@1",
          speech: { action: "reply", body: "first reply" },
          presence: { scope: "topic", mode: "available", wakeKeywords: [] }
        }
      }, "2026-07-25T10:30:00.000Z");
      const replyExecution = runtime.claimDueExecutions(
        1,
        "2026-07-25T10:30:00.000Z"
      )[0]!;
      new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => []
      }).handle(replyExecution, "2026-07-25T10:30:00.000Z");

      const between = postLocalChatMessage(repo, "new since alice turn", {
        ...options,
        now: () => new Date("2026-07-25T11:00:00.000Z")
      }).message;
      const betweenExecution = runtime.claimDueExecutions(
        1,
        "2026-07-25T11:00:00.000Z"
      )[0]!;
      new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => []
      }).handle(betweenExecution, "2026-07-25T11:00:00.000Z");

      const current = postLocalChatMessage(repo, "@alice current", {
        ...options,
        now: () => new Date("2026-07-25T12:00:00.000Z")
      }).message;
      const currentExecution = runtime.claimDueExecutions(
        1,
        "2026-07-25T12:00:00.000Z"
      )[0]!;
      const currentDispatchId = new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => [alice],
        prompt: {
          resourceId: chatPromptResourceId,
          render: (context) => JSON.stringify(context)
        },
        mentionPrompt: {
          resourceId: chatMentionPromptResourceId,
          render: (context) => JSON.stringify(context)
        }
      }).handle(currentExecution, "2026-07-25T12:00:00.000Z")[0]!;
      const dispatch = runtime.event(currentDispatchId);
      assert.equal(dispatch?.type, "chat.dispatch");
      if (dispatch?.type !== "chat.dispatch") return;
      const context = JSON.parse(dispatch.prompt) as {
        latestMessage: { eventId: string };
        history: { items: Array<{ eventId: string }> };
      };
      assert.equal(context.latestMessage.eventId, current.eventId);
      assert.deepEqual(context.history.items.map(({ eventId }) => eventId), [between.eventId]);
      assert.ok(!context.history.items.some(({ eventId }) => eventId === first.eventId));
    } finally {
      chat.close();
      runtime.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("public Chat snapshots profile rules and revisions while missing context fails closed", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-profile-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-profile-runtime-"));
  const options = { runtimeDirectory };
  const at = "2026-07-27T12:00:00.000Z";
  try {
    const alice = addLocalAgent(repo, "alice", "codex", options);
    const source = postLocalChatMessage(repo, "Make a bounded public statement", {
      ...options,
      now: () => new Date(at)
    }).message;
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    const chat = new LocalChatStore(join(runtimeDirectory, "runtime.db"));
    try {
      const execution = runtime.claimDueExecutions(1, at)[0]!;
      let agentRevision = 1;
      const dispatchId = new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => [alice],
        prompt: {
          resourceId: chatPromptResourceId,
          render: (context) => JSON.stringify(context)
        },
        resolveProfileContext: (agentId, topicId) => ({
          kind: "public",
          context: profileContext(agentId, topicId, agentRevision)
        })
      }).handle(execution, at)[0]!;
      const dispatch = runtime.event(dispatchId);
      assert.equal(dispatch?.type, "chat.dispatch");
      if (dispatch?.type !== "chat.dispatch") return;
      assert.equal(dispatch.profileContext?.agent.revision, 1);
      assert.match(dispatch.prompt, /Automated research Agent/);
      assert.match(dispatch.prompt, /topic-rules-further-restrict-agent-rules/);
      assert.doesNotMatch(dispatch.prompt, /credential|workspaceRoot|toolPermissions/);

      agentRevision = 2;
      const agentExecution = runtime.claimDueExecutions(1, at)[0]!;
      runtime.completeExecution(agentExecution.executionId, {
        adapterId: "fixture",
        workspace: repo,
        providerSessionId: "profile-session",
        chatDecision: {
          schema: "ChatDecision@1",
          speech: { action: "reply", body: "Bounded statement" },
          presence: { scope: "topic", mode: "available", wakeKeywords: [] }
        }
      }, at);
      assert.deepEqual(runtime.chatDecisionReceipt(dispatchId)?.profileRevisions, {
        schema: "ChatProfileRevisionReceipt@1",
        agentId: alice.principalId,
        agentRevision: 1,
        topicId: source.topicId,
        topicRevision: 3,
        resolvedAt: at
      });
      const historical = runtime.event(dispatchId);
      assert.equal(historical?.type === "chat.dispatch"
        ? historical.profileContext?.agent.revision
        : undefined, 1);
      const replyChatExecution = runtime.claimDueExecutions(1, at)[0]!;
      new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => []
      }).handle(replyChatExecution, at);
    } finally {
      chat.close();
      runtime.close();
    }

    const missingSource = postLocalChatMessage(repo, "Missing public profile", {
      ...options,
      now: () => new Date("2026-07-27T12:01:00.000Z")
    }).message;
    const missingRuntime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    const missingChat = new LocalChatStore(join(runtimeDirectory, "runtime.db"));
    try {
      const missingExecution = missingRuntime.claimDueExecutions(
        1,
        missingSource.createdAt
      )[0]!;
      assert.throws(() => new ChatHandler({
        store: missingRuntime,
        chat: missingChat,
        listAgents: () => [alice],
        resolveProfileContext: () => ({ kind: "public" })
      }).handle(missingExecution, missingSource.createdAt), /ChatProfileContext@1/);
      assert.equal(missingRuntime.events().filter((event) =>
        event.type === "chat.dispatch" && event.sourceMessageEventId === missingSource.eventId
      ).length, 0);
    } finally {
      missingChat.close();
      missingRuntime.close();
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
      turnMode: "reply_to_message",
    conversationIntent: continueRecentIntent(1),
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
  assert.match(rendered, /Your default is to contribute/);
  assert.match(rendered, /that thread is exhausted: start a fresh, specific subject/);
  assert.match(rendered, /history result is not by itself a reason to stay silent/);
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
      turnMode: "reply_to_message",
    conversationIntent: continueRecentIntent(1),
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
      targets: [{ principalId: "agent-a", handleSnapshot: "alice" }],
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
  assert.match(rendered, /real `list_client_threads` and `read_client_thread` tools/);
  assert.ok(!rendered.includes("type: Prompt"));
  assert.ok(!rendered.includes("{{CHAT_CONTEXT_JSON}}"));
});

function profileContext(agentId: string, topicId: string, agentRevision: number) {
  return {
    schema: "ChatProfileContext@1",
    visibility: "public",
    resolvedAt: "2026-07-27T12:00:00.000Z",
    validUntil: "2026-07-27T12:05:00.000Z",
    agent: {
      agentId,
      displayName: "Alice Researcher",
      role: "Independent research Agent",
      disclosure: "Automated research Agent",
      expressionRules: ["Separate evidence from inference."],
      revision: agentRevision
    },
    topic: {
      topicId,
      purpose: "Bounded public research",
      participationRules: ["Disclose automation."],
      expressionRules: ["Label uncertainty."],
      revision: 3
    },
    precedence: "topic-rules-further-restrict-agent-rules"
  };
}

function continueRecentIntent(governanceRevision: number) {
  return {
    schema: "ConversationIntentSnapshot@1" as const,
    mode: "continue_recent" as const,
    governanceRevision
  };
}
