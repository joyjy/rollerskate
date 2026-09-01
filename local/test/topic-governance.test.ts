import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  addLocalAgent,
  localRuntimeSnapshot,
  suspendLocalAgent
} from "../src/application/agent/control.js";
import {
  activateLocalChat,
  dispatchLocalChatMessage,
  localChatView,
  postLocalChatMessage,
  resumeAndWakeLocalChat,
  rotateLocalAgentSession
} from "../src/application/chat/control.js";
import {
  grantClientHistoryAccess,
  inspectClientHistoryAccess
} from "../src/application/activity/client-history.js";
import { ChatHandler } from "../src/application/chat/handler.js";
import { TopicGovernanceAdmissionPolicy } from
  "../src/application/topic/admission.js";
import {
  addLocalTopicParticipant,
  materializeLocalTopicGovernance,
  pauseLocalTopic,
  removeLocalTopicParticipant,
  resumeLocalTopic
} from
  "../src/application/topic/governance-control.js";
import { inspectLocalTopicGovernance } from
  "../src/application/topic/governance-query.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";
import {
  AgentHandler,
  type RuntimeAgentAdapter
} from "../src/core/runtime/handlers.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { TopicGovernanceStore } from
  "../src/infrastructure/sqlite/topic-governance-store.js";
import {
  defaultTopicGovernance,
  parseTopicGovernance,
  parseTopicGovernanceControlReceipt,
  topicGovernanceControlReceiptSchema
} from "../src/modules/topic/governance.js";

test("first materialization snapshots active Local Agents and remains stable", () => {
  const fixture = runtimeFixture("materialization");
  try {
    const foundation = localRuntimeSnapshot(fixture.repo, fixture.options).foundation;
    const alice = addLocalAgent(fixture.repo, "alice", "codex", fixture.options);
    const bob = addLocalAgent(fixture.repo, "bob", "kimi-code", fixture.options);
    suspendLocalAgent(fixture.repo, bob.principalId, fixture.options);

    const first = materializeLocalTopicGovernance(
      fixture.repo,
      fixture.runtime,
      "2026-07-31T08:00:00.000Z"
    );
    assert.equal(first.created, true);
    assert.equal(first.governance.topicId, foundation.topicId);
    assert.deepEqual(
      first.governance.participants.map(({ agentId, status }) => ({ agentId, status })),
      [{ agentId: alice.principalId, status: "active" }]
    );
    assert.equal(first.receipt.schema, topicGovernanceControlReceiptSchema);
    assert.equal(first.receipt.action, "materialize_default");

    addLocalAgent(fixture.repo, "charlie", "claude-code", fixture.options);
    const restarted = inspectLocalTopicGovernance(fixture.repo, fixture.runtime);
    assert.equal(restarted.governance.revision, 1);
    assert.deepEqual(restarted.activeParticipantAgentIds, [alice.principalId]);
    assert.equal(restarted.recentReceipts[0]?.receiptId, first.receipt.receiptId);
  } finally {
    fixture.close();
  }
});

test("governance revision and its control receipt commit atomically with CAS", () => {
  const fixture = runtimeFixture("revision");
  try {
    const foundation = localRuntimeSnapshot(fixture.repo, fixture.options).foundation;
    const alice = addLocalAgent(fixture.repo, "alice", "codex", fixture.options);
    materializeLocalTopicGovernance(
      fixture.repo,
      fixture.runtime,
      "2026-07-31T08:00:00.000Z"
    );
    const store = new TopicGovernanceStore(join(fixture.runtime, "runtime.db"));
    try {
      const current = store.require(foundation.topicId);
      const committed = store.commitRevision(foundation.topicId, {
        expectedRevision: 1,
        action: "pause",
        actor: {
          kind: "owner",
          principalId: localRuntimeSnapshot(fixture.repo, fixture.options)
            .foundation.owner.principalId
        },
        changedFields: ["status"],
        next: {
          status: "paused",
          participants: current.participants,
          strategyPolicy: current.strategyPolicy,
          conversationPolicy: current.conversationPolicy
        }
      }, "2026-07-31T08:01:00.000Z");
      assert.equal(committed.governance.status, "paused");
      assert.equal(committed.governance.revision, 2);
      assert.equal(committed.receipt.previousRevision, 1);
      assert.equal(committed.receipt.resultingRevision, 2);
      assert.deepEqual(
        store.receipts(foundation.topicId).map(({ resultingRevision }) => resultingRevision),
        [2, 1]
      );

      assert.throws(() => store.commitRevision(foundation.topicId, {
        expectedRevision: 1,
        action: "participant_remove",
        actor: { kind: "owner", principalId: alice.principalId },
        changedFields: ["participants"],
        next: {
          status: "paused",
          participants: [],
          strategyPolicy: current.strategyPolicy,
          conversationPolicy: current.conversationPolicy
        }
      }), /revision conflict: expected 1, current 2/);
      assert.equal(store.receipts(foundation.topicId).length, 2);
    } finally {
      store.close();
    }
  } finally {
    fixture.close();
  }
});

test("Pause and Resume are idempotent, conflict-safe, durable and do not wake Chat", () => {
  const fixture = runtimeFixture("pause-resume-controls");
  try {
    addLocalAgent(fixture.repo, "alice", "codex", fixture.options);
    materializeLocalTopicGovernance(
      fixture.repo, fixture.runtime, "2026-07-31T10:00:00.000Z"
    );
    const paused = pauseLocalTopic(fixture.repo, 1, fixture.options);
    assert.equal(paused.outcome, "applied");
    assert.equal(paused.governance.status, "paused");
    assert.equal(paused.receipt?.action, "pause");
    assert.equal(paused.receipt?.actor.principalId,
      localRuntimeSnapshot(fixture.repo, fixture.options).foundation.owner.principalId);

    const repeatedPause = pauseLocalTopic(fixture.repo, 1, fixture.options);
    assert.equal(repeatedPause.outcome, "unchanged");
    assert.equal(repeatedPause.governance.revision, 2);
    assert.equal(repeatedPause.receipt, undefined);

    const staleResume = resumeLocalTopic(fixture.repo, 1, fixture.options);
    assert.equal(staleResume.outcome, "conflict");
    assert.equal(staleResume.governance.revision, 2);
    const store = new TopicGovernanceStore(join(fixture.runtime, "runtime.db"));
    const runtime = new RuntimeStore(join(fixture.runtime, "runtime.db"));
    try {
      assert.equal(store.receipts(paused.governance.topicId).length, 2);
      const resumed = resumeLocalTopic(fixture.repo, 2, fixture.options);
      assert.equal(resumed.outcome, "applied");
      assert.equal(resumed.governance.status, "active");
      assert.equal(runtime.latestChatActivation(resumed.governance.topicId), undefined);

      const restarted = inspectLocalTopicGovernance(fixture.repo, fixture.runtime);
      assert.equal(restarted.governance.status, "active");
      assert.equal(restarted.governance.revision, 3);
      assert.deepEqual(
        restarted.recentReceipts.map(({ action }) => action),
        ["resume", "pause", "materialize_default"]
      );
    } finally {
      runtime.close();
      store.close();
    }
  } finally {
    fixture.close();
  }
});

test("Resume & wake requires a key and creates at most one resumed activation", () => {
  const fixture = runtimeFixture("resume-wake");
  try {
    const alice = addLocalAgent(fixture.repo, "alice", "codex", fixture.options);
    materializeLocalTopicGovernance(
      fixture.repo, fixture.runtime, "2026-07-31T10:00:00.000Z"
    );
    pauseLocalTopic(fixture.repo, 1, fixture.options);
    assert.throws(
      () => resumeAndWakeLocalChat(fixture.repo, 2, " ", fixture.options),
      /requires an idempotency key/
    );
    const first = resumeAndWakeLocalChat(
      fixture.repo, 2, "resume-wake-once", fixture.options
    );
    assert.equal(first.governance.outcome, "applied");
    assert.equal(first.activation?.status, "accepted");
    assert.equal(first.activation?.event.type, "chat.activation");
    if (first.activation?.event.type !== "chat.activation") {
      assert.fail("expected chat.activation");
    }
    assert.equal(first.activation.event.reason, "resumed");
    assert.deepEqual(first.activation.event.candidateAgentIds, [alice.principalId]);

    const repeated = resumeAndWakeLocalChat(
      fixture.repo, 2, "resume-wake-once", fixture.options
    );
    assert.equal(repeated.governance.outcome, "unchanged");
    assert.equal(repeated.activation?.status, "duplicate");
    assert.equal(repeated.activation?.event.eventId, first.activation.event.eventId);
  } finally {
    fixture.close();
  }
});

test("participant controls preserve unrelated Agent and Chat state and allow an empty roster", () => {
  const fixture = runtimeFixture("participant-controls");
  try {
    const alice = addLocalAgent(fixture.repo, "alice", "codex", fixture.options);
    materializeLocalTopicGovernance(
      fixture.repo, fixture.runtime, "2026-07-31T10:00:00.000Z"
    );
    const message = postLocalChatMessage(fixture.repo, "keep this", fixture.options).message;
    grantClientHistoryAccess(fixture.repo, alice.principalId, fixture.options);
    const sessionGeneration = rotateLocalAgentSession(
      fixture.repo, alice.principalId, fixture.options
    );
    const bob = addLocalAgent(fixture.repo, "bob", "kimi-code", fixture.options);

    const added = addLocalTopicParticipant(
      fixture.repo, bob.principalId, 1, fixture.options
    );
    assert.equal(added.outcome, "applied");
    assert.deepEqual(
      added.governance.participants.filter(({ status }) => status === "active")
        .map(({ agentId }) => agentId),
      [alice.principalId, bob.principalId]
    );
    assert.equal(addLocalTopicParticipant(
      fixture.repo, bob.principalId, 1, fixture.options
    ).outcome, "unchanged");
    assert.equal(removeLocalTopicParticipant(
      fixture.repo, alice.principalId, 1, fixture.options
    ).outcome, "conflict");
    assert.equal(removeLocalTopicParticipant(
      fixture.repo, alice.principalId, 2, fixture.options
    ).outcome, "applied");
    const empty = removeLocalTopicParticipant(
      fixture.repo, bob.principalId, 3, fixture.options
    );
    assert.equal(empty.outcome, "applied");
    assert.deepEqual(empty.governance.participants
      .filter(({ status }) => status === "active"), []);

    const snapshot = localRuntimeSnapshot(fixture.repo, fixture.options);
    assert.deepEqual(snapshot.agents.map(({ principalId, status }) => ({ principalId, status })), [
      { principalId: alice.principalId, status: "active" },
      { principalId: bob.principalId, status: "active" }
    ]);
    assert.equal(sessionGeneration, 2);
    assert.equal(localChatView(fixture.repo, fixture.options).sessions
      .find(({ principalId }) => principalId === alice.principalId)?.generation, 2);
    assert.equal(
      inspectClientHistoryAccess(fixture.repo, alice.principalId, fixture.options)?.status,
      "active"
    );
    const chat = new LocalChatStore(join(fixture.runtime, "runtime.db"));
    try {
      const persistedMessage = chat.events(empty.governance.topicId)
        .find(({ eventId }) => eventId === message.eventId);
      assert.equal(
        persistedMessage?.type === "chat.message" ? persistedMessage.body : undefined,
        "keep this"
      );
    } finally {
      chat.close();
    }
    const restarted = inspectLocalTopicGovernance(fixture.repo, fixture.runtime);
    assert.deepEqual(restarted.activeParticipantAgentIds, []);
    assert.equal(restarted.governance.revision, 4);
    assert.equal(restarted.recentReceipts.length, 4);
    assert.equal(restarted.actionAvailability.participantRemoveAgentIds.length, 0);
    assert.deepEqual(
      [...restarted.actionAvailability.participantAddAgentIds].sort(),
      [alice.principalId, bob.principalId].sort()
    );
  } finally {
    fixture.close();
  }
});

test("governance validation rejects invalid theme policy and participant state", () => {
  const valid = {
    topicId: "topic-a",
    status: "active",
    participants: [],
    strategyPolicy: {
      starterEnabled: true,
      participantMessageEnabled: true,
      scheduledEnabled: true
    },
    conversationPolicy: {
      defaultIntent: "choose_from_themes",
      themes: []
    },
    revision: 1,
    createdAt: "2026-07-31T08:00:00.000Z",
    updatedAt: "2026-07-31T08:00:00.000Z"
  };
  assert.throws(
    () => parseTopicGovernance(valid),
    /requires at least one active theme/
  );
  assert.throws(() => parseTopicGovernance({
    ...valid,
    conversationPolicy: { defaultIntent: "continue_recent", themes: [] },
    participants: [{
      agentId: "agent-a",
      status: "removed",
      joinedAt: valid.createdAt,
      governanceRevision: 1
    }]
  }), /removed status and removedAt must agree/);
  assert.throws(
    () => defaultTopicGovernance("topic-a", [" "], valid.createdAt),
    /activeAgentIds\[0\]/
  );
  assert.throws(() => parseTopicGovernanceControlReceipt({
    schema: topicGovernanceControlReceiptSchema,
    receiptId: "topic-governance:topic-b:1",
    topicId: "topic-a",
    action: "materialize_default",
    actor: { kind: "system" },
    previousRevision: null,
    resultingRevision: 1,
    changedFields: ["status"],
    createdAt: valid.createdAt
  }), /receiptId must match/);
});

test("schema v69 upgrades v53 and materializes governance from existing active Agents", () => {
  const fixture = runtimeFixture("migration");
  try {
    const foundation = localRuntimeSnapshot(fixture.repo, fixture.options).foundation;
    const alice = addLocalAgent(fixture.repo, "alice", "codex", fixture.options);
    const bob = addLocalAgent(fixture.repo, "bob", "kimi-code", fixture.options);
    suspendLocalAgent(fixture.repo, bob.principalId, fixture.options);
    const databasePath = join(fixture.runtime, "runtime.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP TABLE free_chat_mode_receipts;
      DROP TABLE free_chat_modes;
      DROP TABLE channel_follows;
      DROP TABLE channel_send_receipts;
      DROP TABLE interactive_channel_bindings;
      DROP TABLE topic_activation_schedule_receipts;
      DROP TABLE topic_activation_schedules;
      DROP TABLE topic_governance_control_receipts;
      DROP TABLE topic_governance;
      UPDATE schema_meta SET value = '53' WHERE key = 'schema_version';
    `);
    legacy.close();

    const diagnostics = initializeRuntimeSchema(databasePath);
    assert.equal(diagnostics.schemaVersion, 69);
    assert.equal(diagnostics.tables.length, 29);
    const store = new TopicGovernanceStore(databasePath);
    try {
      const governance = store.require(foundation.topicId);
      assert.deepEqual(
        governance.participants.map(({ agentId }) => agentId),
        [alice.principalId]
      );
      assert.equal(store.requireReceipt(foundation.topicId, 1).action, "materialize_default");
    } finally {
      store.close();
    }
  } finally {
    fixture.close();
  }
});

test("starter, manual, Human and Agent continuation share governance admission", () => {
  const fixture = runtimeFixture("admission");
  try {
    const alice = addLocalAgent(fixture.repo, "alice", "codex", fixture.options);
    const materialized = materializeLocalTopicGovernance(
      fixture.repo,
      fixture.runtime,
      "2026-07-31T08:00:00.000Z"
    );
    const store = new TopicGovernanceStore(join(fixture.runtime, "runtime.db"));
    const runtime = new RuntimeStore(join(fixture.runtime, "runtime.db"));
    const chat = new LocalChatStore(join(fixture.runtime, "runtime.db"));
    try {
      const paused = store.commitRevision(materialized.governance.topicId, {
        expectedRevision: 1,
        action: "pause",
        actor: { kind: "owner", principalId: "owner" },
        changedFields: ["status"],
        next: { ...materialized.governance, status: "paused" }
      }, "2026-07-31T08:01:00.000Z").governance;
      assert.throws(() => activateLocalChat(fixture.repo, {
        strategy: "starter",
        idempotencyKey: "paused-starter"
      }, fixture.options), /Topic is paused/);
      assert.throws(() => activateLocalChat(fixture.repo, {
        strategy: "manual",
        idempotencyKey: "paused-manual"
      }, fixture.options), /Topic is paused/);

      const policy = admissionPolicy(fixture, store, runtime);
      const pausedMessage = postLocalChatMessage(
        fixture.repo,
        "Human message while paused",
        fixture.options
      ).message;
      const pausedExecution = runtime.claimDueExecutions(
        20,
        "2026-07-31T08:02:00.000Z"
      ).find(({ eventId }) => eventId === pausedMessage.eventId);
      assert.ok(pausedExecution);
      assert.deepEqual(new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => localRuntimeSnapshot(fixture.repo, fixture.options).agents,
        admissionPolicy: policy
      }).handle(pausedExecution, "2026-07-31T08:02:00.000Z"), []);

      const active = store.commitRevision(paused.topicId, {
        expectedRevision: 2,
        action: "resume",
        actor: { kind: "owner", principalId: "owner" },
        changedFields: ["status"],
        next: { ...paused, status: "active" }
      }, "2026-07-31T08:03:00.000Z").governance;
      const participantDisabled = store.commitRevision(active.topicId, {
        expectedRevision: 3,
        action: "strategy_policy_update",
        actor: { kind: "owner", principalId: "owner" },
        changedFields: ["strategyPolicy.participantMessageEnabled"],
        next: {
          ...active,
          strategyPolicy: { ...active.strategyPolicy, participantMessageEnabled: false }
        }
      }, "2026-07-31T08:04:00.000Z").governance;
      const agentMessage = chat.admitExternalAgentMessage({
        source: { kind: "server", externalId: "agent-continuation-disabled" },
        topicId: participantDisabled.topicId,
        sender: {
          principalId: alice.principalId,
          handleSnapshot: alice.handle
        },
        body: "Agent continuation",
        activation: { strategyId: "participant-message", turnBudget: 8 },
        at: "2026-07-31T08:05:00.000Z"
      }).message;
      const agentExecution = runtime.claimDueExecutions(
        20,
        "2026-07-31T08:06:00.000Z"
      ).find(({ eventId }) => eventId === agentMessage.eventId);
      assert.ok(agentExecution);
      assert.deepEqual(new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => localRuntimeSnapshot(fixture.repo, fixture.options).agents,
        admissionPolicy: policy
      }).handle(agentExecution, "2026-07-31T08:06:00.000Z"), []);
      assert.equal(runtime.chatAttentionReceipts(agentMessage.eventId).length, 0);

      const starterDisabled = store.commitRevision(participantDisabled.topicId, {
        expectedRevision: 4,
        action: "strategy_policy_update",
        actor: { kind: "owner", principalId: "owner" },
        changedFields: ["strategyPolicy.starterEnabled"],
        next: {
          ...participantDisabled,
          strategyPolicy: { ...participantDisabled.strategyPolicy, starterEnabled: false }
        }
      }, "2026-07-31T08:07:00.000Z").governance;
      assert.throws(() => activateLocalChat(fixture.repo, {
        strategy: "starter",
        idempotencyKey: "disabled-starter"
      }, fixture.options), /starter strategy is disabled/);
      const manual = activateLocalChat(fixture.repo, {
        strategy: "manual",
        idempotencyKey: "manual-remains-enabled",
        intentPolicy: {
          kind: "fixed_directed",
          brief: "Review the release boundary together."
        }
      }, fixture.options);
      assert.equal(manual.status, "accepted");
      assert.equal(manual.event.type, "chat.activation");
      assert.equal(manual.event.contextRevision, starterDisabled.revision);
      assert.deepEqual(manual.event.candidateAgentIds, [alice.principalId]);
      assert.deepEqual(manual.event.conversationIntent, {
        schema: "ConversationIntentSnapshot@1",
        mode: "directed",
        brief: "Review the release boundary together.",
        governanceRevision: starterDisabled.revision
      });
    } finally {
      chat.close();
      runtime.close();
      store.close();
    }
  } finally {
    fixture.close();
  }
});

test("queued dispatch rechecks participant revision and records a durable skip", async () => {
  const fixture = runtimeFixture("claim-recheck");
  try {
    const alice = addLocalAgent(fixture.repo, "alice", "codex", fixture.options);
    const materialized = materializeLocalTopicGovernance(
      fixture.repo,
      fixture.runtime,
      "2026-07-31T09:00:00.000Z"
    );
    const store = new TopicGovernanceStore(join(fixture.runtime, "runtime.db"));
    const runtime = new RuntimeStore(join(fixture.runtime, "runtime.db"));
    const chat = new LocalChatStore(join(fixture.runtime, "runtime.db"));
    let invocations = 0;
    try {
      const policy = admissionPolicy(fixture, store, runtime);
      const source = postLocalChatMessage(
        fixture.repo,
        "@alice inspect this",
        fixture.options
      ).message;
      const chatExecution = runtime.claimDueExecutions(
        20,
        "2026-07-31T09:01:00.000Z"
      ).find(({ eventId }) => eventId === source.eventId);
      assert.ok(chatExecution);
      const dispatchIds = new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => localRuntimeSnapshot(fixture.repo, fixture.options).agents,
        admissionPolicy: policy
      }).handle(chatExecution, "2026-07-31T09:01:00.000Z");
      assert.equal(dispatchIds.length, 1);
      const dispatch = runtime.event(dispatchIds[0]!);
      assert.equal(dispatch?.type, "chat.dispatch");
      assert.deepEqual(
        dispatch?.type === "chat.dispatch" ? dispatch.admissionSnapshot : undefined,
        { revision: 1, participantRevision: 1 }
      );
      runtime.setChatPresence(alice.principalId, materialized.governance.topicId, {
        scope: "topic",
        mode: "snoozed",
        until: "2026-07-31T10:00:00.000Z",
        wakeKeywords: []
      }, "2026-07-31T09:01:10.000Z");
      assert.deepEqual(
        dispatch?.type === "chat.dispatch"
          ? policy.canInvoke(dispatch, "2026-07-31T09:01:10.000Z")
          : undefined,
        { outcome: "skip", reason: "chat-presence-changed" }
      );
      runtime.setChatPresence(alice.principalId, materialized.governance.topicId, {
        scope: "topic",
        mode: "available",
        wakeKeywords: []
      }, "2026-07-31T09:01:20.000Z");

      const revised = store.commitRevision(materialized.governance.topicId, {
        expectedRevision: 1,
        action: "conversation_policy_update",
        actor: { kind: "owner", principalId: "owner" },
        changedFields: ["conversationPolicy.themes"],
        next: {
          ...materialized.governance,
          conversationPolicy: {
            ...materialized.governance.conversationPolicy,
            themes: [{
              themeId: "release",
              title: "Release",
              brief: "Discuss release readiness",
              status: "active"
            }]
          }
        }
      }, "2026-07-31T09:01:30.000Z").governance;
      assert.deepEqual(
        dispatch?.type === "chat.dispatch"
          ? policy.canInvoke(dispatch, "2026-07-31T09:01:30.000Z")
          : undefined,
        { outcome: "skip", reason: "topic-governance-revision-changed" }
      );

      store.commitRevision(materialized.governance.topicId, {
        expectedRevision: 2,
        action: "participant_remove",
        actor: { kind: "owner", principalId: "owner" },
        changedFields: ["participants"],
        next: {
          ...revised,
          participants: [{
            ...revised.participants[0]!,
            status: "removed",
            removedAt: "2026-07-31T09:02:00.000Z",
            governanceRevision: 3
          }]
        }
      }, "2026-07-31T09:02:00.000Z");
      const duplicate = dispatchLocalChatMessage(
        fixture.repo,
        source.eventId,
        alice.principalId,
        fixture.options
      );
      assert.equal(duplicate.status, "duplicate");
      assert.equal(duplicate.event.eventId, dispatchIds[0]);

      const dispatchExecution = runtime.claimDueExecutions(
        20,
        "2026-07-31T09:03:00.000Z"
      ).find(({ eventId }) => eventId === dispatchIds[0]);
      assert.ok(dispatchExecution);
      const adapter: RuntimeAgentAdapter = {
        adapterId: "never-called",
        workspace: fixture.repo,
        async invoke() {
          invocations += 1;
          throw new Error("provider must not be invoked");
        }
      };
      assert.equal(await new AgentHandler({
        store: runtime,
        adapters: new Map([[alice.principalId, adapter]]),
        executionGuards: [policy]
      }).handle(dispatchExecution, "2026-07-31T09:03:00.000Z"), undefined);
      assert.equal(invocations, 0);
      assert.equal(runtime.execution(dispatchExecution.executionId)?.status, "cancelled");
      assert.equal(
        runtime.execution(dispatchExecution.executionId)?.lastError,
        "topic-participant-ineligible"
      );
      assert.deepEqual(chat.readProgressForMessages([source.eventId]).get(source.eventId), {
        schema: "ChatReadProgress@1",
        total: 1,
        read: 0,
        agents: [{
          agentId: alice.principalId,
          handleSnapshot: alice.handle,
          state: "unread",
          reason: "direct-mention",
          failureReason: "topic-participant-ineligible"
        }]
      });
    } finally {
      chat.close();
      runtime.close();
      store.close();
    }
  } finally {
    fixture.close();
  }
});

function admissionPolicy(
  fixture: ReturnType<typeof runtimeFixture>,
  store: TopicGovernanceStore,
  runtime: RuntimeStore
): TopicGovernanceAdmissionPolicy {
  return new TopicGovernanceAdmissionPolicy({
    getGovernance: (topicId) => store.get(topicId),
    listAgents: () => localRuntimeSnapshot(fixture.repo, fixture.options).agents,
    runtime
  });
}

function runtimeFixture(name: string): {
  readonly repo: string;
  readonly runtime: string;
  readonly options: {
    readonly runtimeDirectory: string;
    readonly now: () => Date;
  };
  readonly close: () => void;
} {
  const repo = mkdtempSync(join(tmpdir(), `rollerskate-governance-${name}-repo-`));
  const runtime = mkdtempSync(join(tmpdir(), `rollerskate-governance-${name}-runtime-`));
  return {
    repo,
    runtime,
    options: {
      runtimeDirectory: runtime,
      now: () => new Date("2026-07-31T07:00:00.000Z")
    },
    close() {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
    }
  };
}
