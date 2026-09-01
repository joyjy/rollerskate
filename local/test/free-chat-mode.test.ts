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
import { ChatHandler } from "../src/application/chat/handler.js";
import {
  continueLocalFreeChatNow,
  exitLocalFreeChat,
  startLocalFreeChat
} from "../src/application/topic/free-chat-control.js";
import { inspectLocalFreeChat } from
  "../src/application/topic/free-chat-query.js";
import { FreeChatRuntime } from
  "../src/application/topic/free-chat-runtime.js";
import {
  materializeLocalTopicGovernance,
  pauseLocalTopic
} from "../src/application/topic/governance-control.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { chatPromptResourceId } from "../src/core/chat/model.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import {
  sampleFreeChatCycle
} from "../src/modules/topic/free-chat.js";

test("Free Chat sampling is deterministic for delay, count, order and theme", () => {
  const input = {
    modeId: "mode-deterministic",
    cycleIndex: 7,
    sampledAt: "2026-08-03T00:00:00.000Z",
    governanceRevision: 4,
    intentPolicy: { kind: "choose_from_themes" as const },
    candidates: [
      { agentId: "alice", lastSpokeAt: "2026-08-02T23:50:00.000Z" },
      { agentId: "bob" },
      { agentId: "charlie", lastSpokeAt: "2026-08-02T23:59:00.000Z" }
    ],
    themes: [
      { themeId: "release", brief: "Release readiness" },
      { themeId: "design", brief: "Design direction" }
    ]
  };
  const first = sampleFreeChatCycle(input);
  const replay = sampleFreeChatCycle(input);
  assert.deepEqual(replay, first);
  assert.ok(first.idleDelayMinutes >= 5 && first.idleDelayMinutes <= 30);
  assert.equal(first.candidateAgentIds.length, first.participantCount);
  assert.equal(first.conversationIntent.mode, "selected_theme");
  assert.ok(first.conversationIntent.themeId === "release" ||
    first.conversationIntent.themeId === "design");
});

test("sequential activation offers sampled Agents one turn at a time with one root intent", () => {
  const fixture = runtimeFixture("sequential-agents");
  try {
    const alice = addLocalAgent(fixture.repo, "alice", "codex", fixture.options);
    const bob = addLocalAgent(fixture.repo, "bob", "kimi-code", fixture.options);
    const snapshot = localRuntimeSnapshot(fixture.repo, fixture.options);
    const runtime = new RuntimeStore(join(fixture.runtime, "runtime.db"));
    const chat = new LocalChatStore(join(fixture.runtime, "runtime.db"));
    const handler = new ChatHandler({
      store: runtime,
      chat,
      listAgents: () => snapshot.agents,
      prompt: {
        resourceId: chatPromptResourceId,
        render: (context) => JSON.stringify(context)
      }
    });
    try {
      const intent = {
        schema: "ConversationIntentSnapshot@1" as const,
        mode: "selected_theme" as const,
        themeId: "design",
        brief: "Discuss design direction.",
        governanceRevision: 1
      };
      const activation = runtime.createChatActivation({
        topicId: snapshot.foundation.topicId,
        reason: "manual",
        strategyId: "manual",
        conversationIntent: intent,
        candidateAgentIds: [bob.principalId, alice.principalId],
        sequentialDispatch: true,
        idempotencyKey: "sequential-two-agents",
        turnBudget: 2
      }, "2026-08-03T00:00:00.000Z").event;
      const activationExecution = runtime.claimDueExecutions(
        1, "2026-08-03T00:00:00.000Z"
      )[0]!;
      const firstDispatchIds = handler.handle(
        activationExecution, "2026-08-03T00:00:00.000Z"
      );
      assert.equal(firstDispatchIds.length, 1);
      assert.equal(
        runtime.event(firstDispatchIds[0]!)?.type === "chat.dispatch"
          ? (runtime.event(firstDispatchIds[0]!) as { agentId: string }).agentId
          : undefined,
        bob.principalId
      );
      const aliceExecution = runtime.claimDueExecutions(
        1, "2026-08-03T00:00:01.000Z"
      )[0]!;
      const aliceMessage = runtime.completeExecution(aliceExecution.executionId, {
        adapterId: "fixture",
        workspace: fixture.repo,
        providerSessionId: "alice-sequential",
        chatDecision: {
          schema: "ChatDecision@1",
          speech: { action: "reply", body: "Alice contribution." },
          presence: { scope: "topic", mode: "available", wakeKeywords: [] }
        }
      }, "2026-08-03T00:00:01.000Z");
      assert.equal(aliceMessage?.type, "chat.message");
      const continuation = runtime.claimDueExecutions(
        1, "2026-08-03T00:00:01.000Z"
      )[0]!;
      const secondDispatchIds = handler.handle(
        continuation, "2026-08-03T00:00:01.000Z"
      );
      assert.equal(secondDispatchIds.length, 1);
      const second = runtime.event(secondDispatchIds[0]!);
      assert.equal(second?.type === "chat.dispatch" ? second.agentId : undefined,
        alice.principalId);
      if (second?.type !== "chat.dispatch") assert.fail("second dispatch missing");
      assert.deepEqual(
        (JSON.parse(second.prompt) as { conversationIntent: unknown }).conversationIntent,
        intent
      );
      assert.equal(second.causality.rootEventId, activation.eventId);
    } finally {
      chat.close();
      runtime.close();
    }
  } finally {
    fixture.close();
  }
});

test("Free Chat intent is prompt-safe, sequential and stops after bounded silence", () => {
  const fixture = runtimeFixture("sequential-silence");
  try {
    const alice = addLocalAgent(fixture.repo, "alice", "codex", fixture.options);
    materializeLocalTopicGovernance(
      fixture.repo, fixture.runtime, "2026-08-03T01:00:00.000Z"
    );
    const started = startLocalFreeChat(fixture.repo, {
      idempotencyKey: "free-chat-smoke-name-must-not-leak",
      intentPolicy: { kind: "fixed_directed", brief: "Discuss the product direction." },
      limits: { consecutiveSilenceLimit: 1 }
    }, fixture.optionsAt("2026-08-03T01:00:00.000Z"));
    assert.equal(started.outcome, "applied");
    assert.equal(startLocalFreeChat(fixture.repo, {
      idempotencyKey: "free-chat-smoke-name-must-not-leak"
    }, fixture.optionsAt("2026-08-03T01:00:00.000Z")).outcome, "unchanged");
    const continued = continueLocalFreeChatNow(
      fixture.repo, 1, fixture.optionsAt("2026-08-03T01:01:00.000Z")
    );
    assert.equal(continued.outcome, "applied");

    const freeChat = new FreeChatRuntime(fixture.repo, fixture.options);
    const runtime = new RuntimeStore(join(fixture.runtime, "runtime.db"));
    const chat = new LocalChatStore(join(fixture.runtime, "runtime.db"));
    try {
      const admitted = freeChat.runCycle("2026-08-03T01:01:00.000Z");
      assert.equal(admitted.admittedActivationEventIds.length, 1);
      assert.equal(freeChat.runCycle(
        "2026-08-03T01:01:00.000Z"
      ).admittedActivationEventIds.length, 0);
      const activation = runtime.event(admitted.admittedActivationEventIds[0]!);
      assert.equal(activation?.type, "chat.activation");
      if (activation?.type !== "chat.activation") assert.fail("activation missing");
      assert.equal(activation.sequentialDispatch, true);
      assert.equal(activation.conversationIntent.mode, "directed");
      assert.deepEqual(activation.candidateAgentIds, [alice.principalId]);

      const chatExecution = runtime.claimDueExecutions(
        1, "2026-08-03T01:01:00.000Z"
      )[0]!;
      const dispatchIds = new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => localRuntimeSnapshot(fixture.repo, fixture.options).agents,
        prompt: {
          resourceId: chatPromptResourceId,
          render: (context) => JSON.stringify(context)
        }
      }).handle(chatExecution, "2026-08-03T01:01:00.000Z");
      assert.equal(dispatchIds.length, 1);
      const dispatch = runtime.event(dispatchIds[0]!);
      assert.equal(dispatch?.type, "chat.dispatch");
      if (dispatch?.type !== "chat.dispatch") assert.fail("dispatch missing");
      const prompt = JSON.parse(dispatch.prompt) as {
        conversationIntent: { mode: string; brief: string };
        activation?: unknown;
      };
      assert.deepEqual(prompt.conversationIntent, {
        schema: "ConversationIntentSnapshot@1",
        mode: "directed",
        brief: "Discuss the product direction.",
        governanceRevision: 1
      });
      assert.equal(prompt.activation, undefined);
      assert.ok(!dispatch.prompt.includes("free-chat-smoke-name-must-not-leak"));
      assert.ok(!dispatch.prompt.includes(activation.eventId));

      const agentExecution = runtime.claimDueExecutions(
        1, "2026-08-03T01:01:01.000Z"
      )[0]!;
      runtime.completeExecution(agentExecution.executionId, {
        adapterId: "fixture",
        workspace: fixture.repo,
        providerSessionId: "silent-session",
        chatDecision: {
          schema: "ChatDecision@1",
          speech: { action: "silent", reason: "Nothing useful to add." },
          presence: { scope: "topic", mode: "available", wakeKeywords: [] }
        }
      }, "2026-08-03T01:01:01.000Z");
    } finally {
      chat.close();
      runtime.close();
      freeChat.close();
    }

    const recovered = new FreeChatRuntime(fixture.repo, fixture.options);
    try {
      assert.deepEqual(
        recovered.runCycle("2026-08-03T01:02:00.000Z").stoppedModeIds,
        [started.mode.modeId]
      );
    } finally {
      recovered.close();
    }
    const view = inspectLocalFreeChat(fixture.repo, fixture.runtime);
    assert.equal(view.mode?.status, "stopped");
    assert.equal(view.mode?.stopReason, "consecutive_silence");
    assert.deepEqual(
      view.recentReceipts.map(({ action }) => action),
      ["stopped", "activation_admitted", "continued_now", "started"]
    );
  } finally {
    fixture.close();
  }
});

test("meaningful contribution resamples once and Topic pause durably stops the mode", () => {
  const fixture = runtimeFixture("contribution-pause");
  try {
    addLocalAgent(fixture.repo, "alice", "codex", fixture.options);
    materializeLocalTopicGovernance(
      fixture.repo, fixture.runtime, "2026-08-03T02:00:00.000Z"
    );
    const started = startLocalFreeChat(fixture.repo, {
      idempotencyKey: "contribution-mode"
    }, fixture.optionsAt("2026-08-03T02:00:00.000Z"));
    continueLocalFreeChatNow(
      fixture.repo, 1, fixture.optionsAt("2026-08-03T02:01:00.000Z")
    );
    const runtime = new FreeChatRuntime(fixture.repo, fixture.options);
    try {
      runtime.runCycle("2026-08-03T02:01:00.000Z");
      const chat = new LocalChatStore(join(fixture.runtime, "runtime.db"));
      try {
        chat.postOwnerMessage({
          topicId: started.mode.topicId,
          ownerPrincipalId: localRuntimeSnapshot(fixture.repo, fixture.options)
            .foundation.owner.principalId,
          body: "A meaningful Human contribution.",
          at: "2026-08-03T02:02:00.000Z"
        });
      } finally {
        chat.close();
      }
      assert.deepEqual(runtime.runCycle(
        "2026-08-03T02:02:00.000Z"
      ).advancedModeIds, [started.mode.modeId]);
      const advanced = inspectLocalFreeChat(fixture.repo, fixture.runtime).mode!;
      assert.equal(advanced.cycleIndex, 2);
      assert.equal(advanced.lastMeaningfulActivityAt, "2026-08-03T02:02:00.000Z");
      assert.equal(advanced.pendingActivationEventId, undefined);

      pauseLocalTopic(
        fixture.repo, 1, fixture.optionsAt("2026-08-03T02:03:00.000Z")
      );
      assert.deepEqual(
        runtime.runCycle("2026-08-03T02:03:00.000Z").stoppedModeIds,
        [started.mode.modeId]
      );
    } finally {
      runtime.close();
    }
    const stopped = inspectLocalFreeChat(fixture.repo, fixture.runtime);
    assert.equal(stopped.mode?.stopReason, "topic_paused");
  } finally {
    fixture.close();
  }
});

test("a roster with no active Local Agent durably stops instead of retrying forever", () => {
  const fixture = runtimeFixture("suspended-roster");
  try {
    const alice = addLocalAgent(fixture.repo, "alice", "codex", fixture.options);
    materializeLocalTopicGovernance(
      fixture.repo, fixture.runtime, "2026-08-03T02:30:00.000Z"
    );
    const started = startLocalFreeChat(fixture.repo, {
      idempotencyKey: "suspended-roster-mode"
    }, fixture.optionsAt("2026-08-03T02:30:00.000Z"));
    suspendLocalAgent(fixture.repo, alice.principalId, fixture.options);
    const runtime = new FreeChatRuntime(fixture.repo, fixture.options);
    try {
      assert.deepEqual(
        runtime.runCycle("2026-08-03T02:31:00.000Z").stoppedModeIds,
        [started.mode.modeId]
      );
    } finally {
      runtime.close();
    }
    const stopped = inspectLocalFreeChat(fixture.repo, fixture.runtime);
    assert.equal(stopped.mode?.stopReason, "empty_roster");
    assert.equal(stopped.recentReceipts[0]?.action, "stopped");
  } finally {
    fixture.close();
  }
});

test("a sampled Agent suspension resamples without admitting a stale root", () => {
  const fixture = runtimeFixture("sampled-agent-suspended");
  try {
    addLocalAgent(fixture.repo, "alice", "codex", fixture.options);
    addLocalAgent(fixture.repo, "bob", "kimi-code", fixture.options);
    materializeLocalTopicGovernance(
      fixture.repo, fixture.runtime, "2026-08-03T02:35:00.000Z"
    );
    const started = startLocalFreeChat(fixture.repo, {
      idempotencyKey: "sampled-agent-suspended-mode"
    }, fixture.optionsAt("2026-08-03T02:35:00.000Z"));
    const sampledAgentId = started.mode.sample.candidateAgentIds[0]!;
    suspendLocalAgent(fixture.repo, sampledAgentId, fixture.options);
    const runtime = new FreeChatRuntime(fixture.repo, fixture.options);
    try {
      const cycle = runtime.runCycle("2026-08-03T02:36:00.000Z");
      assert.deepEqual(cycle.admittedActivationEventIds, []);
      assert.deepEqual(cycle.advancedModeIds, [started.mode.modeId]);
    } finally {
      runtime.close();
    }
    const advanced = inspectLocalFreeChat(fixture.repo, fixture.runtime);
    assert.equal(advanced.mode?.cycleIndex, 2);
    assert.ok(!advanced.mode?.sample.candidateAgentIds.includes(sampledAgentId));
    assert.equal(advanced.recentReceipts[0]?.action, "roster_changed");
  } finally {
    fixture.close();
  }
});

test("activation admission rolls back when the mode receipt transition cannot commit", () => {
  const fixture = runtimeFixture("atomic-admission");
  try {
    addLocalAgent(fixture.repo, "alice", "codex", fixture.options);
    materializeLocalTopicGovernance(
      fixture.repo, fixture.runtime, "2026-08-03T02:40:00.000Z"
    );
    startLocalFreeChat(fixture.repo, {
      idempotencyKey: "atomic-admission-mode"
    }, fixture.optionsAt("2026-08-03T02:40:00.000Z"));
    continueLocalFreeChatNow(
      fixture.repo, 1, fixture.optionsAt("2026-08-03T02:41:00.000Z")
    );
    const databasePath = join(fixture.runtime, "runtime.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TRIGGER reject_free_chat_mode_update
      BEFORE UPDATE ON free_chat_modes
      BEGIN
        SELECT RAISE(ABORT, 'forced mode transition failure');
      END;
    `);
    database.close();

    const runtime = new FreeChatRuntime(fixture.repo, fixture.options);
    try {
      assert.throws(
        () => runtime.runCycle("2026-08-03T02:41:00.000Z"),
        /forced mode transition failure/
      );
    } finally {
      runtime.close();
    }

    const inspected = new DatabaseSync(databasePath);
    try {
      const activations = inspected.prepare(`
        SELECT COUNT(*) AS count FROM events
        WHERE source_external_id LIKE 'chat-activation:free-chat:%'
      `).get() as { count: number };
      assert.equal(activations.count, 0);
      inspected.exec("DROP TRIGGER reject_free_chat_mode_update");
    } finally {
      inspected.close();
    }
  } finally {
    fixture.close();
  }
});

test("Free Chat Exit is CAS-safe and schema v69 upgrades a v54 database", () => {
  const fixture = runtimeFixture("exit-migration");
  try {
    addLocalAgent(fixture.repo, "alice", "codex", fixture.options);
    const started = startLocalFreeChat(fixture.repo, {
      idempotencyKey: "exit-mode"
    }, fixture.optionsAt("2026-08-03T03:00:00.000Z"));
    assert.equal(exitLocalFreeChat(
      fixture.repo, 99, fixture.optionsAt("2026-08-03T03:01:00.000Z")
    ).outcome, "conflict");
    const exited = exitLocalFreeChat(
      fixture.repo, 1, fixture.optionsAt("2026-08-03T03:01:00.000Z")
    );
    assert.equal(exited.outcome, "applied");
    assert.equal(exitLocalFreeChat(
      fixture.repo, 1, fixture.optionsAt("2026-08-03T03:02:00.000Z")
    ).outcome, "unchanged");
    assert.equal(exited.mode.modeId, started.mode.modeId);
    const terminalRuntime = new FreeChatRuntime(fixture.repo, fixture.options);
    try {
      assert.deepEqual(
        terminalRuntime.runCycle("2026-08-04T03:00:00.000Z")
          .admittedActivationEventIds,
        []
      );
    } finally {
      terminalRuntime.close();
    }

    const databasePath = join(fixture.runtime, "runtime.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      DELETE FROM free_chat_mode_receipts;
      DELETE FROM free_chat_modes;
      DROP TABLE free_chat_mode_receipts;
      DROP TABLE free_chat_modes;
      DROP TABLE channel_follows;
      DROP TABLE channel_send_receipts;
      DROP TABLE interactive_channel_bindings;
      DROP TABLE topic_activation_schedule_receipts;
      DROP TABLE topic_activation_schedules;
      UPDATE schema_meta SET value = '54' WHERE key = 'schema_version';
    `);
    database.close();
    const diagnostics = initializeRuntimeSchema(databasePath);
    assert.equal(diagnostics.schemaVersion, 69);
    assert.equal(diagnostics.tables.length, 29);
  } finally {
    fixture.close();
  }
});

function runtimeFixture(name: string) {
  const repo = mkdtempSync(join(tmpdir(), `rollerskate-free-chat-${name}-repo-`));
  const runtime = mkdtempSync(join(tmpdir(), `rollerskate-free-chat-${name}-runtime-`));
  const options = { runtimeDirectory: runtime };
  return {
    repo,
    runtime,
    options,
    optionsAt(at: string) {
      return { runtimeDirectory: runtime, now: () => new Date(at) };
    },
    close() {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
    }
  };
}
