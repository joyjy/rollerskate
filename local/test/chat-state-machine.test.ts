import assert from "node:assert/strict";
import test from "node:test";

import {
  parseChatMentionDecision,
  parseChatDecision,
  type ChatPresence
} from "../src/core/chat/model.js";
import {
  planChatAttention,
  type ChatAttentionCandidate
} from "../src/core/chat/state-machine.js";
import type { ChatMessageEvent } from "../src/core/event/model.js";

const now = "2026-07-25T12:00:00.000Z";
const later = "2026-07-25T13:00:00.000Z";

test("ChatDecision@1 validates speech and scoped presence", () => {
  assert.deepEqual(parseChatDecision(JSON.stringify({
    schema: "ChatDecision@1",
    speech: { action: "reply", body: "I can take this." },
    presence: {
      scope: "topic",
      mode: "snoozed",
      until: later,
      wakeKeywords: ["urgent", "deploy"]
    }
  }), now), {
    schema: "ChatDecision@1",
    speech: { action: "reply", body: "I can take this." },
    presence: {
      scope: "topic",
      mode: "snoozed",
      until: later,
      wakeKeywords: ["urgent", "deploy"]
    }
  });
  assert.throws(
    () => parseChatDecision(JSON.stringify({
      schema: "ChatDecision@1",
      speech: { action: "silent" },
      presence: {
        scope: "global",
        mode: "snoozed",
        until: "2026-07-25T11:00:00.000Z",
        wakeKeywords: []
      }
    }), now),
    /must be in the future/
  );
});

test("ChatMentionDecision@1 decides speech without changing presence", () => {
  assert.deepEqual(parseChatMentionDecision(JSON.stringify({
    schema: "ChatMentionDecision@1",
    speech: { action: "reply", body: "I am here." }
  })), {
    schema: "ChatMentionDecision@1",
    speech: { action: "reply", body: "I am here." }
  });
  assert.throws(
    () => parseChatMentionDecision(JSON.stringify({
      schema: "ChatMentionDecision@1",
      speech: { action: "silent" },
      presence: { scope: "global", mode: "available", wakeKeywords: [] }
    })),
    /must not include presence/
  );
  assert.throws(
    () => parseChatMentionDecision(JSON.stringify({
      schema: "ChatDecision@1",
      speech: { action: "silent" }
    })),
    /must use schema ChatMentionDecision@1/
  );
});

test("available Agents dispatch while sender, non-target, and suspended Agents skip", () => {
  const plans = planChatAttention({
    message: message({ body: "hello", senderAgentId: "agent-a", targetAgentId: "agent-b" }),
    candidates: [
      candidate("agent-a", "alice"),
      candidate("agent-b", "bob"),
      candidate("agent-c", "carol"),
      candidate("agent-d", "dave", { status: "suspended" })
    ],
    now
  });
  assert.deepEqual(
    plans.map(({ agentId, outcome, reason }) => ({ agentId, outcome, reason })),
    [
      { agentId: "agent-a", outcome: "skip", reason: "sender" },
      { agentId: "agent-b", outcome: "dispatch", reason: "direct-mention" },
      { agentId: "agent-c", outcome: "skip", reason: "not-target" },
      { agentId: "agent-d", outcome: "skip", reason: "agent-suspended" }
    ]
  );
});

test("global snooze takes precedence over Topic availability and Topic keywords", () => {
  const plans = planChatAttention({
    message: message({ body: "topic-wake only" }),
    candidates: [candidate("agent-a", "alice", {
      globalPresence: snoozed("global", ["global-wake"]),
      topicPresence: snoozed("topic", ["topic-wake"])
    })],
    now
  });
  assert.equal(plans[0]?.outcome, "skip");
  assert.equal(plans[0]?.reason, "global-snoozed");
});

test("mention and matching literal keyword wake a snoozed Agent for one decision", () => {
  const globalWake = planChatAttention({
    message: message({ body: "Please handle ＤＥＰＬＯＹ now" }),
    candidates: [candidate("agent-a", "alice", {
      globalPresence: snoozed("global", ["deploy"])
    })],
    now
  })[0]!;
  assert.equal(globalWake.outcome, "dispatch");
  assert.equal(globalWake.reason, "global-wake-keyword");

  const mentionWake = planChatAttention({
    message: message({ body: "@ALICE are you there?" }),
    candidates: [candidate("agent-a", "Alice", {
      globalPresence: snoozed("global", [])
    })],
    now
  })[0]!;
  assert.equal(mentionWake.outcome, "dispatch");
  assert.equal(mentionWake.reason, "direct-mention");

  const prefixOnly = planChatAttention({
    message: message({ body: "@alice2 is a different handle" }),
    candidates: [candidate("agent-a", "alice", {
      globalPresence: snoozed("global", [])
    })],
    now
  })[0]!;
  assert.equal(prefixOnly.outcome, "skip");
  assert.equal(prefixOnly.reason, "global-snoozed");
});

test("expired global and Topic snoozes are effectively available", () => {
  const expired: ChatPresence = {
    scope: "global",
    mode: "snoozed",
    until: "2026-07-25T11:59:59.000Z",
    wakeKeywords: []
  };
  const plan = planChatAttention({
    message: message({ body: "new context" }),
    candidates: [candidate("agent-a", "alice", {
      globalPresence: expired,
      topicPresence: { ...expired, scope: "topic" }
    })],
    now
  })[0]!;
  assert.equal(plan.outcome, "dispatch");
  assert.equal(plan.reason, "available");
  assert.equal(plan.presenceSnapshot.global.mode, "available");
  assert.equal(plan.presenceSnapshot.topic.mode, "available");
});

function candidate(
  agentId: string,
  handle: string,
  options: Partial<ChatAttentionCandidate> = {}
): ChatAttentionCandidate {
  return {
    agentId,
    handle,
    status: "active",
    ...options
  };
}

function snoozed(
  scope: ChatPresence["scope"],
  wakeKeywords: readonly string[]
): ChatPresence {
  return { scope, mode: "snoozed", until: later, wakeKeywords };
}

function message(input: {
  readonly body: string;
  readonly senderAgentId?: string;
  readonly targetAgentId?: string;
}): ChatMessageEvent {
  return {
    eventId: "evt-test",
    type: "chat.message",
    source: { kind: "handler" },
    destinationIds: [],
    topicId: "topic-a",
    sender: input.senderAgentId === undefined
      ? { kind: "owner", principalId: "owner", handleSnapshot: "owner" }
      : { kind: "agent", principalId: input.senderAgentId, handleSnapshot: "agent" },
    body: input.body,
    ...(input.targetAgentId === undefined
      ? {}
      : {
          target: {
            principalId: input.targetAgentId,
            handleSnapshot: "bob"
          }
        }),
    causality: { rootEventId: "evt-test", hop: 0 },
    createdAt: now
  };
}
