import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  addLocalAgent,
  localRuntimeSnapshot
} from "../src/application/agent/control.js";
import {
  handoffLocalChatMessageToRun,
  localChatPresenceView,
  localChatView,
  postLocalChatMessage
} from "../src/application/chat/control.js";
import {
  confirmLocalChatRunProposal,
  declineLocalChatRunProposal,
  preflightLocalChatRunProposal
} from
  "../src/application/chat/run-proposal-control.js";
import {
  chatMentionPromptResourceId,
  chatPromptResourceId
} from "../src/core/chat/model.js";
import type { ChatAttentionPlan } from "../src/core/chat/state-machine.js";
import { AgentHandler, type RuntimeAgentAdapter } from "../src/core/runtime/handlers.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { AgentRunStore } from "../src/infrastructure/sqlite/agent-run-store.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";

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
        sessionId: reply?.sessionId,
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

test("concurrent propose_run decisions become independent stable Chat-owned proposals", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-proposal-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-proposal-runtime-"));
  const options = { runtimeDirectory };
  const at = "2026-07-25T12:00:00.000Z";
  try {
    const alice = addLocalAgent(repo, "alice", "codex", options);
    const codex = addLocalAgent(repo, "codex", "codex", options);
    const source = postLocalChatMessage(repo, "Please inspect this regression", {
      ...options,
      now: () => new Date(at)
    }).message;
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    try {
      const chatExecution = runtime.claimDueExecutions(1, at)[0]!;
      const dispatches = runtime.admitChatAttention(chatExecution.executionId, [
        {
          plan: plan(alice.principalId, alice.handle, "dispatch", "available"),
          prompt: "alice proposal prompt",
          promptResourceId: chatPromptResourceId
        },
        {
          plan: plan(codex.principalId, codex.handle, "dispatch", "available"),
          prompt: "codex proposal prompt",
          promptResourceId: chatPromptResourceId
        }
      ], at);
      const executions = runtime.claimDueExecutions(2, at);
      const byEvent = new Map(executions.map((execution) => [execution.eventId, execution]));
      const later = byEvent.get(dispatches[1]!.eventId)!;
      runtime.completeExecution(later.executionId, {
        adapterId: "fixture",
        workspace: repo,
        providerSessionId: "codex-proposal-session",
        chatDecision: proposalDecision("Later proposal")
      }, at);
      assert.equal(localChatView(repo, options).messages.items[0]?.runProposals?.length, 1);

      const earlier = byEvent.get(dispatches[0]!.eventId)!;
      runtime.completeExecution(earlier.executionId, {
        adapterId: "fixture",
        workspace: repo,
        providerSessionId: "alice-proposal-session",
        chatDecision: proposalDecision("Earlier proposal")
      }, at);
      const proposals = localChatView(repo, options).messages.items[0]?.runProposals ?? [];
      const refreshed = localChatView(repo, options).messages.items[0]?.runProposals ?? [];
      const orderedDispatches = [...dispatches].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.eventId.localeCompare(right.eventId));
      assert.equal(proposals.length, 2);
      assert.deepEqual(proposals.map(({ dispatchEventId }) => dispatchEventId),
        orderedDispatches.map(({ eventId }) => eventId));
      assert.deepEqual(proposals.map(({ chatLead }) => chatLead.agentId),
        orderedDispatches.map(({ agentId }) => agentId));
      assert.ok(proposals.every(({ runOrchestrator }) =>
        runOrchestrator?.agentId === codex.principalId));
      for (const proposal of proposals) {
        const expectedParticipants = proposal.chatLead.agentId === codex.principalId
          ? [codex.principalId]
          : [alice.principalId, codex.principalId].sort();
        assert.deepEqual(proposal.participants.map(({ agentId }) => agentId).sort(),
          expectedParticipants);
        assert.equal(proposal.ready, true);
      }
      assert.deepEqual(proposals.map(({ revision }) => revision),
        refreshed.map(({ revision }) => revision));
      assert.equal(runtime.events().some((event) => event.type === "agent.request"), false);
      assert.equal(runtime.chatDecisionReceipt(dispatches[0]!.eventId)?.speechAction,
        "propose_run");
      assert.equal(localChatPresenceView(repo, options).agents
        .find(({ principalId }) => principalId === alice.principalId)?.lastTurn?.state,
      "proposed");
      const first = proposals[0]!;
      assert.throws(() => confirmLocalChatRunProposal(
        repo, source.eventId, first.dispatchEventId, "sha256:stale", options
      ), /revision is stale/u);
      assert.throws(() => handoffLocalChatMessageToRun(repo, source.eventId, options),
        /require current revision confirmation/u);
      const second = proposals[1]!;
      const declined = declineLocalChatRunProposal(
        repo, source.eventId, second.dispatchEventId, second.revision, options
      );
      assert.equal(declined.status, "declined");
      assert.equal(declined.proposal.decision?.status, "declined");
      assert.equal(declined.proposal.ready, false);
      assert.equal(declined.proposal.blocker, undefined);
      const repeatedDecline = declineLocalChatRunProposal(
        repo, source.eventId, second.dispatchEventId, second.revision, options
      );
      assert.equal(repeatedDecline.status, "duplicate");
      assert.equal(repeatedDecline.proposal.decision?.eventId,
        declined.proposal.decision?.eventId);
      const decisionEvent = runtime.event(declined.proposal.decision!.eventId);
      assert.equal(decisionEvent?.type, "chat.message");
      assert.equal(decisionEvent?.type === "chat.message"
        ? decisionEvent.runProposalDecision?.dispatchEventId
        : undefined, second.dispatchEventId);
      assert.equal(runtime.executionForEvent(declined.proposal.decision!.eventId), undefined);
      assert.throws(() => confirmLocalChatRunProposal(
        repo, source.eventId, second.dispatchEventId, second.revision, options
      ), /already been declined/u);
      const confirmed = confirmLocalChatRunProposal(
        repo, source.eventId, first.dispatchEventId, first.revision, options
      );
      assert.equal(confirmed.status, "accepted");
      const duplicate = confirmLocalChatRunProposal(
        repo, source.eventId, first.dispatchEventId, first.revision, options
      );
      assert.equal(duplicate.status, "duplicate");
      assert.equal(duplicate.run.runId, confirmed.run.runId);
      assert.equal(runtime.events().filter((event) => event.type === "agent.request").length, 1);
      const started = localChatView(repo, options).messages.items[0]?.runProposals ?? [];
      const linked = started.find(({ dispatchEventId }) =>
        dispatchEventId === first.dispatchEventId);
      assert.equal(linked?.linkedRun?.runId, confirmed.run.runId);
      assert.equal(linked?.linkedRun?.state, "started");
      assert.equal(linked?.ready, false);
      assert.equal(linked?.blocker, undefined);
      assert.equal(linked?.workspaceChoices, undefined);
      const declinedReadback = started.find(({ dispatchEventId }) =>
        dispatchEventId === second.dispatchEventId);
      assert.equal(declinedReadback?.decision?.status, "declined");
      assert.equal(declinedReadback?.linkedRun, undefined);
      assert.ok(localChatView(repo, options).messages.items.some((message) =>
        message.sender.kind === "system" &&
        message.body === `Owner declined Run proposal from @${second.chatLead.handle}.`));
      const database = openRuntimeDatabase(join(runtimeDirectory, "runtime.db"));
      const runs = new AgentRunStore(database);
      try {
        runs.terminalizeInTransaction({
          runId: confirmed.run.runId,
          expectedVersion: confirmed.run.version,
          status: "needs_human",
          summary: "Owner must choose the target branch.",
          updatedAt: "2026-07-25T12:01:00.000Z"
        });
      } finally {
        runs.close();
        database.close();
      }
      const needsHuman = localChatView(repo, options).messages.items[0]
        ?.runProposals?.find(({ dispatchEventId }) =>
          dispatchEventId === first.dispatchEventId)?.linkedRun;
      assert.equal(needsHuman?.state, "needs_human");
      assert.equal(needsHuman?.terminalSummary, "Owner must choose the target branch.");
    } finally {
      runtime.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("workspace proposal requires Owner preflight before exact revision confirmation", () => {
  const repo = gitRepoFixture("rollerskate-chat-workspace-repo-");
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-workspace-runtime-"));
  const options = { runtimeDirectory };
  const at = "2026-07-25T12:00:00.000Z";
  try {
    const alice = addLocalAgent(repo, "alice", "codex", options);
    const codex = addLocalAgent(repo, "codex", "codex", options);
    const source = postLocalChatMessage(repo, "Please inspect this workspace", {
      ...options,
      now: () => new Date(at)
    }).message;
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    try {
      const chatExecution = runtime.claimDueExecutions(1, at)[0]!;
      runtime.admitChatAttention(chatExecution.executionId, [{
        plan: plan(alice.principalId, alice.handle, "dispatch", "available"),
        prompt: "workspace proposal prompt",
        promptResourceId: chatPromptResourceId
      }], at);
      const agentExecution = runtime.claimDueExecutions(1, at)[0]!;
      runtime.completeExecution(agentExecution.executionId, {
        adapterId: "fixture",
        workspace: repo,
        providerSessionId: "alice-workspace-session",
        chatDecision: proposalDecision("Inspect the workspace", "read")
      }, at);

      const sourceProposal = localChatView(repo, options).messages.items[0]?.runProposals?.[0];
      assert.equal(sourceProposal?.ready, false);
      assert.equal(sourceProposal?.blocker?.code, "workspace_required");
      assert.deepEqual(sourceProposal?.workspaceChoices?.map(({ kind }) => kind), [
        "project", "local", "path"
      ]);
      assert.deepEqual(sourceProposal?.participants.map(({ agentId }) => agentId).sort(),
        [alice.principalId, codex.principalId].sort());

      const invalid = preflightLocalChatRunProposal(
        repo,
        source.eventId,
        sourceProposal!.dispatchEventId,
        sourceProposal!.revision,
        { kind: "local" },
        options
      );
      assert.equal(invalid.proposal.ready, false);
      assert.equal(invalid.proposal.blocker?.code, "workspace_invalid");

      const checked = preflightLocalChatRunProposal(
        repo,
        source.eventId,
        sourceProposal!.dispatchEventId,
        sourceProposal!.revision,
        { kind: "project" },
        options
      );
      assert.equal(checked.proposal.ready, true);
      assert.equal(checked.proposal.selectedWorkspace?.root, realpathSync(repo));
      assert.equal(checked.proposal.authority?.workspace?.root, realpathSync(repo));
      assert.match(checked.proposal.authority?.workspace?.revision ?? "", /^wrk1_/u);
      assert.throws(() => confirmLocalChatRunProposal(
        repo, source.eventId, sourceProposal!.dispatchEventId,
        sourceProposal!.revision, options, { kind: "project" }
      ), /revision is stale/u);
      const confirmed = confirmLocalChatRunProposal(
        repo, source.eventId, sourceProposal!.dispatchEventId,
        checked.proposal.revision, options, { kind: "project" }
      );
      assert.equal(confirmed.status, "accepted");
    } finally {
      runtime.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("proposal admission stays blocked without a Steward and ignores proactive proposal facts", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-proposal-guard-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-proposal-guard-runtime-"));
  const options = { runtimeDirectory };
  const at = "2026-07-25T12:00:00.000Z";
  try {
    const alice = addLocalAgent(repo, "alice", "codex", options);
    const source = postLocalChatMessage(repo, "Please inspect this", {
      ...options,
      now: () => new Date(at)
    }).message;
    const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
    try {
      const chatExecution = runtime.claimDueExecutions(1, at)[0]!;
      runtime.admitChatAttention(chatExecution.executionId, [{
        plan: plan(alice.principalId, alice.handle, "dispatch", "available"),
        prompt: "proposal prompt",
        promptResourceId: chatPromptResourceId
      }], at);
      const agentExecution = runtime.claimDueExecutions(1, at)[0]!;
      runtime.completeExecution(agentExecution.executionId, {
        adapterId: "fixture",
        workspace: repo,
        providerSessionId: "alice-proposal-session",
        chatDecision: proposalDecision("Inspect the source")
      }, at);
      const blocked = localChatView(repo, options).messages.items[0]?.runProposals?.[0];
      assert.equal(blocked?.ready, false);
      assert.equal(blocked?.blocker?.code, "steward_unavailable");
      assert.match(blocked?.blocker?.detail ?? "", /active supported Steward Agent/u);
      assert.throws(() => confirmLocalChatRunProposal(
        repo, source.eventId, blocked!.dispatchEventId, blocked!.revision, options
      ), /selected Steward Agent must be active/u);

      const snapshot = localRuntimeSnapshot(repo, options);
      const activation = runtime.createChatActivation({
        topicId: snapshot.foundation.topicId,
        reason: "manual",
        strategyId: "manual",
        conversationIntent: {
          schema: "ConversationIntentSnapshot@1",
          mode: "continue_recent",
          governanceRevision: 1
        },
        candidateAgentIds: [alice.principalId],
        idempotencyKey: "proactive-proposal-guard",
        turnBudget: 1
      }, at).event;
      const activationExecution = runtime.claimDueExecutions(1, at)[0]!;
      runtime.admitChatAttention(activationExecution.executionId, [{
        plan: plan(alice.principalId, alice.handle, "dispatch", "activation"),
        prompt: "proactive prompt",
        promptResourceId: chatPromptResourceId
      }], at);
      const proactiveExecution = runtime.claimDueExecutions(1, at)[0]!;
      runtime.completeExecution(proactiveExecution.executionId, {
        adapterId: "fixture",
        workspace: repo,
        providerSessionId: "alice-proposal-session",
        chatDecision: proposalDecision("Unrequested proactive work")
      }, at);
      assert.equal(runtime.event(activation.eventId)?.type, "chat.activation");
      assert.equal(localChatView(repo, options).messages.items
        .filter(({ runProposals }) => runProposals !== undefined).length, 1);
      assert.equal(runtime.events().some((event) => event.type === "agent.request"), false);
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
        sessionId: reply?.sessionId,
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
        assert.equal(runtime.execution(secondAgent.executionId)?.status, "failed");
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

function proposalDecision(goal: string, desiredEffect: "none" | "read" = "none") {
  return {
    schema: "ChatDecision@2" as const,
    speech: {
      action: "propose_run" as const,
      proposal: {
        schema: "ChatRunProposalDraft@1" as const,
        goal,
        scope: { include: ["Inspect the exact regression"], exclude: ["Do not deploy"] },
        acceptance: ["The root cause is evidenced"],
        desiredEffect
      }
    },
    presence: { scope: "topic" as const, mode: "available" as const, wakeKeywords: [] }
  };
}

function gitRepoFixture(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "add", "README.md"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-qm", "fixture"], { cwd: repo });
  return repo;
}
