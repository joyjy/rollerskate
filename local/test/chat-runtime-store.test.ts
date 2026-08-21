import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addLocalAgent } from "../src/application/agent/control.js";
import {
  localChatPresenceView,
  localChatView,
  postLocalChatMessage
} from "../src/application/chat/control.js";
import {
  chatMentionPromptResourceId,
  chatPromptResourceId
} from "../src/core/chat/model.js";
import type { ChatAttentionPlan } from "../src/core/chat/state-machine.js";
import { AgentHandler, type RuntimeAgentAdapter } from "../src/core/runtime/handlers.js";
import { RuntimeStore } from "../src/core/runtime/store.js";

test("RuntimeStore atomically admits Chat attention and completes routed reply Delivery", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-atomic-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-atomic-runtime-"));
  const options = { runtimeDirectory };
  const at = "2026-07-25T12:00:00.000Z";
  try {
    const alice = addLocalAgent(repo, "alice", "codex", options);
    const bob = addLocalAgent(repo, "bob", "codex", options);
    const source = postLocalChatMessage(repo, "who wants this?", {
      ...options,
      now: () => new Date(at)
    }).message;
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    try {
      const chatExecution = runtime.claimDueExecutions(1, at)[0]!;
      assert.equal(chatExecution.handler, "chat");
      const alicePlan = plan(alice.principalId, alice.handle, "dispatch", "available");
      const bobPlan = plan(bob.principalId, bob.handle, "skip", "topic-snoozed");
      const dispatches = runtime.admitChatAttention(chatExecution.executionId, [
        {
          plan: alicePlan,
          prompt: "resource-rendered prompt",
          promptResourceId: chatPromptResourceId
        },
        { plan: bobPlan }
      ], at);
      assert.equal(dispatches.length, 1);
      assert.equal(runtime.execution(chatExecution.executionId)?.status, "succeeded");
      assert.deepEqual(
        runtime.chatAttentionReceipts(source.eventId).map(
          ({ agentId, outcome, reason }) => ({ agentId, outcome, reason })
        ),
        [
          { agentId: alice.principalId, outcome: "dispatched", reason: "available" },
          { agentId: bob.principalId, outcome: "skipped", reason: "topic-snoozed" }
        ]
      );
      assert.equal(dispatches[0]?.promptResourceId, chatPromptResourceId);

      const agentExecution = runtime.claimDueExecutions(1, at)[0]!;
      const reply = runtime.completeExecution(agentExecution.executionId, {
        adapterId: "fake",
        workspace: join(runtimeDirectory, "workspace"),
        providerSessionId: "provider-alice",
        invocation: {
          schemaVersion: "AgentInvocationDiagnostics@1",
          effectivePrompt: "chat invocation prompt",
          startedAt: at,
          completedAt: at,
          durationMilliseconds: 0,
          toolUsage: []
        },
        chatDecision: {
          schema: "ChatDecision@1",
          speech: { action: "reply", body: "I will take it." },
          presence: {
            scope: "global",
            mode: "snoozed",
            until: "2026-07-25T13:00:00.000Z",
            wakeKeywords: ["urgent"]
          }
        },
        chatReplyRoute: {
          continueAttention: false,
          delivery: {
            destinationId: "dst_019f0000-0000-7000-8000-000000000001",
            kind: "server-topic",
            address: { topicId: source.topicId, agentId: alice.principalId }
          }
        }
      }, at);
      assert.equal(reply?.type, "chat.message");
      assert.equal(reply?.body, "I will take it.");
      assert.equal(runtime.currentLocalAgentSession(alice.principalId)?.sessionId, reply?.sessionId);
      assert.deepEqual(runtime.chatPresence(alice.principalId, source.topicId).global, {
        scope: "global",
        mode: "snoozed",
        until: "2026-07-25T13:00:00.000Z",
        wakeKeywords: ["urgent"]
      });
      assert.deepEqual(runtime.chatDecisionReceipt(dispatches[0]!.eventId), {
        dispatchEventId: dispatches[0]!.eventId,
        speechAction: "reply",
        presenceTransition: {
          scope: "global",
          mode: "snoozed",
          until: "2026-07-25T13:00:00.000Z",
          wakeKeywords: ["urgent"]
        },
        replyEventId: reply?.eventId,
        createdAt: at
      });
      assert.deepEqual(
        runtime.audit(dispatches[0]!.eventId)?.invocation,
        {
          schemaVersion: "AgentInvocationDiagnostics@1",
          effectivePrompt: "chat invocation prompt",
          startedAt: at,
          completedAt: at,
          durationMilliseconds: 0,
          toolUsage: []
        }
      );
      assert.equal(runtime.claimDueExecutions(1, at).length, 0);
      const delivery = runtime.claimDueDeliveries(1, at)[0]!;
      assert.equal(delivery.origin.kind, "host");
      assert.equal(delivery.origin.id, reply?.eventId);
      assert.equal(delivery.destinationId, "dst_019f0000-0000-7000-8000-000000000001");
      assert.deepEqual(delivery.payload, { body: "I will take it." });
    } finally {
      runtime.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("Topic presence is isolated while Global presence is visible from every Topic", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-scope-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-scope-runtime-"));
  const at = "2026-07-25T12:00:00.000Z";
  try {
    const alice = addLocalAgent(repo, "alice", "codex", { runtimeDirectory });
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    try {
      runtime.setChatPresence(alice.principalId, "topic-a", {
        scope: "topic",
        mode: "snoozed",
        until: "2026-07-25T13:00:00.000Z",
        wakeKeywords: ["alpha"]
      }, at);
      assert.equal(
        runtime.chatPresence(alice.principalId, "topic-a").topic?.mode,
        "snoozed"
      );
      assert.equal(
        runtime.chatPresence(alice.principalId, "topic-b").topic,
        undefined
      );

      runtime.setChatPresence(alice.principalId, "topic-a", {
        scope: "global",
        mode: "snoozed",
        until: "2026-07-25T14:00:00.000Z",
        wakeKeywords: ["global"]
      }, at);
      assert.equal(
        runtime.chatPresence(alice.principalId, "topic-a").global?.mode,
        "snoozed"
      );
      assert.equal(
        runtime.chatPresence(alice.principalId, "topic-b").global?.mode,
        "snoozed"
      );
    } finally {
      runtime.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("direct mention completion cannot change the Agent presence strategy", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-mention-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-mention-runtime-"));
  const at = "2026-07-25T12:00:00.000Z";
  try {
    const alice = addLocalAgent(repo, "alice", "codex", { runtimeDirectory });
    const source = postLocalChatMessage(repo, "@alice are you there?", {
      runtimeDirectory,
      now: () => new Date(at)
    }).message;
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    try {
      const existing = {
        scope: "global" as const,
        mode: "snoozed" as const,
        until: "2026-07-25T14:00:00.000Z",
        wakeKeywords: ["urgent"]
      };
      runtime.setChatPresence(alice.principalId, source.topicId, existing, at);
      const chatExecution = runtime.claimDueExecutions(1, at)[0]!;
      const dispatch = runtime.admitChatAttention(chatExecution.executionId, [{
        plan: plan(alice.principalId, alice.handle, "dispatch", "direct-mention"),
        prompt: "mentioned-turn prompt",
        promptResourceId: chatMentionPromptResourceId
      }], at)[0]!;
      const agentExecution = runtime.claimDueExecutions(1, at)[0]!;
      const reply = runtime.completeExecution(agentExecution.executionId, {
        adapterId: "fake",
        workspace: join(runtimeDirectory, "workspace"),
        providerSessionId: "provider-alice",
        chatDecision: {
          schema: "ChatMentionDecision@1",
          speech: { action: "reply", body: "Yes." }
        }
      }, at);
      assert.equal(reply?.type, "chat.message");
      assert.equal(reply.type === "chat.message" ? reply.body : undefined, "Yes.");
      assert.deepEqual(
        runtime.chatPresence(alice.principalId, source.topicId).global,
        existing
      );
      assert.deepEqual(runtime.chatDecisionReceipt(dispatch.eventId), {
        dispatchEventId: dispatch.eventId,
        speechAction: "reply",
        replyEventId: reply?.eventId,
        createdAt: at
      });
    } finally {
      runtime.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("Chat current state uses targeted queries beyond bounded history windows", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-current-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-current-runtime-"));
  const options = { runtimeDirectory };
  const at = "2026-07-25T12:00:00.000Z";
  try {
    const alice = addLocalAgent(repo, "alice", "codex", options);
    const mentioned = postLocalChatMessage(repo, "@alice keep this turn visible", {
      ...options,
      now: () => new Date(at)
    }).message;
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    try {
      const chatExecution = runtime.claimDueExecutions(1, at)[0]!;
      const dispatch = runtime.admitChatAttention(chatExecution.executionId, [{
        plan: plan(alice.principalId, alice.handle, "dispatch", "direct-mention"),
        prompt: "mentioned-turn prompt",
        promptResourceId: chatMentionPromptResourceId
      }], at)[0]!;
      const agentExecution = runtime.claimDueExecutions(1, at)[0]!;
      runtime.completeExecution(agentExecution.executionId, {
        adapterId: "fake",
        workspace: join(runtimeDirectory, "workspace"),
        providerSessionId: "provider-alice",
        chatDecision: {
          schema: "ChatMentionDecision@1",
          speech: { action: "reply", body: "Visible after a long history." }
        }
      }, at);

      for (let index = 0; index < 205; index += 1) {
        postLocalChatMessage(repo, `history ${index}`, {
          ...options,
          now: () => new Date(Date.parse(at) + index + 1)
        });
      }
      const activationAt = "2026-07-25T13:00:00.000Z";
      const activation = runtime.createChatActivation({
        topicId: mentioned.topicId,
        reason: "manual",
        strategyId: "manual",
        conversationIntent: {
          schema: "ConversationIntentSnapshot@1",
          mode: "continue_recent",
          governanceRevision: 1
        },
        candidateAgentIds: [alice.principalId],
        idempotencyKey: "long-history-activation",
        turnBudget: 8
      }, activationAt);

      assert.equal(runtime.latestChatDispatch(
        mentioned.topicId,
        alice.principalId
      )?.eventId, dispatch.eventId);
      assert.equal(localChatPresenceView(repo, options).agents[0]?.lastTurn?.state, "replied");
      const view = localChatView(repo, options);
      assert.equal(view.conversation.latestReason, "manual");
      assert.equal(view.conversation.state, "active");
      assert.equal(runtime.latestChatActivation(mentioned.topicId)?.eventId,
        activation.event.eventId);
    } finally {
      runtime.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("Chat rejects a current Session when the provider policy adapter identity changes",
  async () => {
    const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-policy-session-repo-"));
    const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-policy-session-runtime-"));
    const options = { runtimeDirectory };
    const at = "2026-07-25T12:00:00.000Z";
    try {
      const alice = addLocalAgent(repo, "alice", "kimi-code", options);
      postLocalChatMessage(repo, "@alice first", {
        ...options,
        now: () => new Date(at)
      });
      const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
      try {
        const firstChat = runtime.claimDueExecutions(1, at)[0]!;
        runtime.admitChatAttention(firstChat.executionId, [{
          plan: plan(alice.principalId, alice.handle, "dispatch", "direct-mention"),
          prompt: "first prompt",
          promptResourceId: chatMentionPromptResourceId
        }], at);
        const firstAgent = runtime.claimDueExecutions(1, at)[0]!;
        runtime.completeExecution(firstAgent.executionId, {
          adapterId: `kimi-code-runtime-jsonl-v3:${"a".repeat(64)}`,
          workspace: join(runtimeDirectory, "workspace"),
          providerSessionId: "provider-kimi",
          chatDecision: {
            schema: "ChatMentionDecision@1",
            speech: { action: "reply", body: "first" }
          }
        }, at);

        postLocalChatMessage(repo, "@alice second", {
          ...options,
          now: () => new Date(Date.parse(at) + 1)
        });
        const secondChat = runtime.claimDueExecutions(1, at)[0]!;
        runtime.admitChatAttention(secondChat.executionId, [{
          plan: plan(alice.principalId, alice.handle, "dispatch", "direct-mention"),
          prompt: "second prompt",
          promptResourceId: chatMentionPromptResourceId
        }], at);
        const secondAgent = runtime.claimDueExecutions(1, at)[0]!;
        let invocations = 0;
        const changedPolicyAdapter: RuntimeAgentAdapter = {
          adapterId: `kimi-code-runtime-jsonl-v3:${"b".repeat(64)}`,
          workspace: join(runtimeDirectory, "workspace"),
          async invoke() {
            invocations += 1;
            return {
              providerSessionId: "provider-kimi",
              outcome: { kind: "message", body: "unreachable" }
            };
          }
        };
        await new AgentHandler({
          store: runtime,
          adapters: new Map([[alice.principalId, changedPolicyAdapter]])
        }).handle(secondAgent, at);

        assert.equal(invocations, 0);
        assert.equal(runtime.execution(secondAgent.executionId)?.status, "retry_wait");
        assert.match(
          runtime.execution(secondAgent.executionId)?.lastError ?? "",
          /adapter=mismatch/
        );
      } finally {
        runtime.close();
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  });

function plan(
  agentId: string,
  handle: string,
  outcome: ChatAttentionPlan["outcome"],
  reason: ChatAttentionPlan["reason"]
): ChatAttentionPlan {
  return {
    agentId,
    handle,
    outcome,
    reason,
    presenceSnapshot: {
      global: { scope: "global", mode: "available", wakeKeywords: [] },
      topic: outcome === "skip"
        ? {
            scope: "topic",
            mode: "snoozed",
            until: "2026-07-25T13:00:00.000Z",
            wakeKeywords: []
          }
        : { scope: "topic", mode: "available", wakeKeywords: [] }
    }
  };
}
