import assert from "node:assert/strict";
import test from "node:test";

import {
  parseChatMentionDecision,
  parseChatDecision,
  parseChatProfileContext,
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
      speech: { action: "silent", reason: "Already covered." },
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

test("ChatDecision@2 admits a bounded Run proposal and keeps incomplete work blocked", () => {
  assert.deepEqual(parseChatDecision(JSON.stringify({
    schema: "ChatDecision@2",
    speech: {
      action: "propose_run",
      proposal: {
        schema: "ChatRunProposalDraft@1",
        goal: "Inspect the regression",
        scope: { include: ["Read the failing path"], exclude: ["Do not deploy"] },
        acceptance: ["Root cause is evidenced"],
        desiredEffect: "read",
        workspaceRef: "local:workspace"
      }
    },
    presence: { scope: "topic", mode: "available", wakeKeywords: [] }
  }), now), {
    schema: "ChatDecision@2",
    speech: {
      action: "propose_run",
      proposal: {
        schema: "ChatRunProposalDraft@1",
        goal: "Inspect the regression",
        scope: { include: ["Read the failing path"], exclude: ["Do not deploy"] },
        acceptance: ["Root cause is evidenced"],
        desiredEffect: "read",
        workspaceRef: "local:workspace"
      }
    },
    presence: { scope: "topic", mode: "available", wakeKeywords: [] }
  });
  const blocked = parseChatDecision(JSON.stringify({
    schema: "ChatDecision@2",
    speech: {
      action: "propose_run",
      proposal: {
        schema: "ChatRunProposalDraft@1",
        goal: "Inspect the regression"
      }
    },
    presence: { scope: "topic", mode: "available", wakeKeywords: [] }
  }), now);
  assert.equal(blocked.speech.action, "propose_run");
  if (blocked.speech.action !== "propose_run") return;
  assert.equal(
    blocked.speech.proposal.blockingQuestion,
    "Please clarify scope.include, acceptance, desiredEffect before starting this Run."
  );
  assert.throws(() => parseChatDecision(JSON.stringify({
    schema: "ChatDecision@1",
    speech: {
      action: "propose_run",
      proposal: { schema: "ChatRunProposalDraft@1" }
    },
    presence: { scope: "topic", mode: "available", wakeKeywords: [] }
  }), now), /must be reply or silent/u);
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
      speech: { action: "silent", reason: "No useful addition." },
      presence: { scope: "global", mode: "available", wakeKeywords: [] }
    })),
    /must not include presence/
  );
  assert.throws(
    () => parseChatMentionDecision(JSON.stringify({
      schema: "ChatDecision@1",
      speech: { action: "silent", reason: "No useful reply." }
    })),
    /must use schema ChatMentionDecision@1/
  );
});

test("ChatMentionDecision@2 can propose work without changing presence", () => {
  const decision = parseChatMentionDecision(JSON.stringify({
    schema: "ChatMentionDecision@2",
    speech: {
      action: "propose_run",
      proposal: {
        schema: "ChatRunProposalDraft@1",
        goal: "Summarize the evidence",
        scope: { include: ["Read the supplied context"], exclude: [] },
        acceptance: ["A bounded summary is returned"],
        desiredEffect: "none"
      }
    }
  }));
  assert.equal(decision.speech.action, "propose_run");
  assert.equal("presence" in decision, false);
});

test("public Chat profile context rejects stale, mismatched and unbounded snapshots", () => {
  const valid = {
    schema: "ChatProfileContext@1",
    visibility: "public",
    resolvedAt: now,
    validUntil: later,
    agent: {
      agentId: "agent-a",
      displayName: "Alice",
      role: "Research Agent",
      disclosure: "Automated Agent",
      expressionRules: ["Label inference."],
      revision: 1
    },
    topic: {
      topicId: "topic-a",
      purpose: "Research",
      participationRules: [],
      expressionRules: ["Stay on topic."],
      revision: 2
    },
    precedence: "topic-rules-further-restrict-agent-rules"
  };
  assert.equal(parseChatProfileContext(valid, "agent-a", "topic-a", now).topic.revision, 2);
  assert.throws(() => parseChatProfileContext(
    { ...valid, validUntil: "2026-07-25T11:00:00.000Z" },
    "agent-a", "topic-a", now
  ), /stale/);
  assert.throws(() => parseChatProfileContext(valid, "agent-b", "topic-a", now),
    /identity does not match/);
  assert.throws(() => parseChatProfileContext({
    ...valid,
    agent: { ...valid.agent, expressionRules: Array.from({ length: 33 }, () => "rule") }
  }, "agent-a", "topic-a", now), /at most 32 rules/);
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
          targets: [{
            principalId: input.targetAgentId,
            handleSnapshot: "bob"
          }]
        }),
    causality: { rootEventId: "evt-test", hop: 0 },
    createdAt: now
  };
}
