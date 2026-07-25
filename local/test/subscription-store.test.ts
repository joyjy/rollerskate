import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";
import type { CreatePollSubscription } from "../src/capabilities/subscription/model.js";
import { PollSubscriptionStore } from "../src/capabilities/subscription/store.js";
import { RuntimeStore } from "../src/core/runtime/store.js";

test("terminal observation atomically creates one subscription.fire Event", () => {
  const database = testDatabase();
  const ownerAgentId = seedAgent(database);
  const sessionId = seedSession(database, ownerAgentId);
  const store = new PollSubscriptionStore(database);
  let subscriptionId = "";
  try {
    subscriptionId = store.create(
      subscription(ownerAgentId, sessionId),
      "2026-07-22T10:00:00.000Z"
    ).subscriptionId;
    assert.match(subscriptionId, /^sub_[0-9a-f-]+$/);
    assert.deepEqual(store.due("2026-07-22T10:00:00.000Z"), []);
    store.beginAttempt(subscriptionId, "2026-07-22T10:00:00.100Z");
    const first = store.recordObservation(subscriptionId, {
      version: "plugin-internal-version",
      facts: { status: "success" },
      terminal: "success",
      summary: "Pipeline passed"
    }, "2026-07-22T10:00:01.000Z");
    const duplicate = store.recordObservation(subscriptionId, {
      version: "different-version-is-not-an-event-field",
      facts: { status: "success" },
      terminal: "success"
    }, "2026-07-22T10:00:02.000Z");

    assert.equal(first.subscription.status, "completed");
    assert.match(first.fireEventId ?? "", /^evt_/);
    assert.equal(duplicate.fireEventId, first.fireEventId);
  } finally {
    store.close();
  }
  const runtime = new RuntimeStore(database);
  try {
    const destination = runtime.destinations()[0]!;
    assert.equal(destination.kind, "macos-notification");
    assert.deepEqual(destination.address, {
      title: "Fixture pipeline",
      subscriptionId,
      callbackAdapterId: "fake-agent-v1",
      providerSessionId: "provider-session-1"
    });
    assert.equal(runtime.destinations().length, 1);
    assert.deepEqual(runtime.events().flatMap((event) => event.type === "subscription.fire"
      ? [{
        type: event.type,
        source: event.source,
        sessionId: event.sessionId,
        prompt: event.prompt,
        observation: event.observation,
        destinationIds: event.destinationIds
      }]
      : []), [{
      type: "subscription.fire",
      source: { kind: "subscription", externalId: subscriptionId },
      sessionId,
      prompt: "Report completion.",
      observation: {
        version: "plugin-internal-version",
        facts: { status: "success" },
        terminal: "success",
        summary: "Pipeline passed"
      },
      destinationIds: [destination.destinationId]
    }]);
  } finally {
    runtime.close();
  }
});

test("non-terminal polls update durable schedule without creating Events", () => {
  const database = testDatabase();
  const ownerAgentId = seedAgent(database);
  const sessionId = seedSession(database, ownerAgentId);
  const store = new PollSubscriptionStore(database);
  const subscriptionId = store.create(
    subscription(ownerAgentId, sessionId),
    "2026-07-22T10:00:00.000Z"
  ).subscriptionId;
  store.beginAttempt(subscriptionId, "2026-07-22T10:00:00.100Z");
  store.recordObservation(subscriptionId, {
    version: "poll-debug-only",
    facts: { status: "running" },
    terminal: null
  }, "2026-07-22T10:00:01.000Z");
  store.close();

  const restored = new PollSubscriptionStore(database);
  try {
    assert.equal(restored.require(subscriptionId).status, "active");
    assert.equal(
      restored.require(subscriptionId).nextPollAt,
      "2026-07-22T10:00:01.100Z"
    );
    assert.equal(restored.require(subscriptionId).fireEventId, undefined);
  } finally {
    restored.close();
  }
  const runtime = new RuntimeStore(database);
  try {
    assert.equal(runtime.events().filter((event) => event.type === "subscription.fire").length, 0);
  } finally {
    runtime.close();
  }
});

test("cancelled Subscription never admits a fire Event", () => {
  const database = testDatabase();
  const ownerAgentId = seedAgent(database);
  const sessionId = seedSession(database, ownerAgentId);
  const store = new PollSubscriptionStore(database);
  try {
    const subscriptionId = store.create(
      subscription(ownerAgentId, sessionId),
      "2026-07-22T10:00:00.000Z"
    ).subscriptionId;
    store.setStatus(subscriptionId, "cancel", "2026-07-22T10:00:01.000Z");
    const recorded = store.recordObservation(subscriptionId, {
      version: "late-terminal",
      facts: {},
      terminal: "success"
    }, "2026-07-22T10:00:02.000Z");
    assert.equal(recorded.subscription.status, "cancelled");
    assert.equal(recorded.fireEventId, undefined);
  } finally {
    store.close();
  }
});

test("terminal observation must fit the bounded Event snapshot", () => {
  const database = testDatabase();
  const ownerAgentId = seedAgent(database);
  const sessionId = seedSession(database, ownerAgentId);
  const store = new PollSubscriptionStore(database);
  try {
    const subscriptionId = store.create(
      subscription(ownerAgentId, sessionId),
      "2026-07-22T10:00:00.000Z"
    ).subscriptionId;
    store.beginAttempt(subscriptionId, "2026-07-22T10:00:00.100Z");
    assert.throws(
      () => store.recordObservation(subscriptionId, {
        version: "oversized",
        facts: { output: "x".repeat(17_000) },
        terminal: "success"
      }, "2026-07-22T10:00:01.000Z"),
      /terminal observation exceeds 16384 bytes/
    );
    assert.equal(store.require(subscriptionId).status, "active");
    assert.equal(store.require(subscriptionId).fireEventId, undefined);
  } finally {
    store.close();
  }
});

test("Subscription becomes expired after maxWaitMilliseconds without firing", () => {
  const database = testDatabase();
  const ownerAgentId = seedAgent(database);
  const sessionId = seedSession(database, ownerAgentId);
  const store = new PollSubscriptionStore(database);
  try {
    const subscriptionId = store.create({
      ...subscription(ownerAgentId, sessionId),
      maxWaitMilliseconds: 1_000
    }, "2026-07-22T10:00:00.000Z").subscriptionId;

    assert.deepEqual(store.due("2026-07-22T10:00:01.000Z"), []);
    assert.equal(store.require(subscriptionId).status, "expired");
    assert.equal(store.require(subscriptionId).fireEventId, undefined);
  } finally {
    store.close();
  }
  const runtime = new RuntimeStore(database);
  try {
    assert.equal(runtime.events().filter((event) => event.type === "subscription.fire").length, 0);
  } finally {
    runtime.close();
  }
});

test.skip("superseded v36 direct migration fixture", () => {
  const database = testDatabase();
  const ownerAgentId = seedAgent(database);
  const sessionId = seedSession(database, ownerAgentId);
  const current = new PollSubscriptionStore(database);
  const subscriptionId = current.create(
    subscription(ownerAgentId, sessionId),
    "2026-07-22T10:00:00.000Z"
  ).subscriptionId;
  current.close();

  const legacy = new DatabaseSync(database);
  legacy.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    ALTER TABLE poll_subscriptions RENAME TO poll_subscriptions_v36;
    CREATE TABLE poll_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      owner_agent_id TEXT NOT NULL REFERENCES local_principals(principal_id),
      plugin_path TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      plugin_schema_version INTEGER NOT NULL CHECK(plugin_schema_version = 1),
      plugin_config_json TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      interval_ms INTEGER NOT NULL,
      max_wait_ms INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      callback_provider_session_id TEXT NOT NULL,
      callback_adapter_id TEXT NOT NULL,
      callback_workspace TEXT NOT NULL,
      callback_session_id TEXT REFERENCES sessions(session_id),
      callback_prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'active','paused','completed','cancelled','expired'
      )),
      started_at TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      next_poll_at TEXT NOT NULL,
      latest_error TEXT,
      fire_event_id TEXT UNIQUE REFERENCES events(event_id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO poll_subscriptions (
      subscription_id, owner_agent_id, plugin_path, plugin_id,
      plugin_schema_version, plugin_config_json, policy_json, interval_ms,
      max_wait_ms, max_attempts, attempt_count,
      callback_provider_session_id, callback_adapter_id, callback_workspace,
      callback_session_id, callback_prompt, status, started_at, deadline_at,
      next_poll_at, latest_error, fire_event_id, created_at, updated_at
    )
    SELECT
      subscription_id, owner_agent_id, plugin_path, plugin_id,
      plugin_schema_version, plugin_config_json, policy_json, interval_ms,
      max_wait_ms, max_attempts, attempt_count,
      callback_provider_session_id, callback_adapter_id, callback_workspace,
      callback_session_id, callback_prompt, status, started_at, deadline_at,
      next_poll_at, latest_error, fire_event_id, created_at, updated_at
    FROM poll_subscriptions_v36;
    DROP TABLE poll_subscriptions_v36;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
  legacy.close();

  const migrated = new PollSubscriptionStore(database);
  try {
    assert.equal(migrated.require(subscriptionId).title, "fixture-plugin");
  } finally {
    migrated.close();
  }
});

function testDatabase(): string {
  return join(mkdtempSync(join(tmpdir(), "rollerskate-subscription-store-")), "runtime.db");
}

function seedAgent(database: string): string {
  const foundation = new LocalFoundationStore(database);
  try {
    return foundation.addAgent("alice", "codex").principalId;
  } finally {
    foundation.close();
  }
}

function seedSession(database: string, ownerAgentId: string): string {
  const runtime = new RuntimeStore(database);
  try {
    const appended = runtime.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "session-seed" },
      agentId: ownerAgentId,
      prompt: "seed",
      createdAt: "2026-07-22T09:59:00.000Z"
    });
    const execution = runtime.claimDueExecutions(1, "2026-07-22T09:59:00.000Z")[0]!;
    const result = runtime.completeExecution(execution.executionId, {
      adapterId: "fake-agent-v1",
      workspace: "/workspace",
      providerSessionId: "provider-session-1",
      output: "seeded"
    }, "2026-07-22T09:59:01.000Z");
    assert.equal(result?.type, "agent.result");
    return result.sessionId!;
  } finally {
    runtime.close();
  }
}

function subscription(ownerAgentId: string, sessionId: string): CreatePollSubscription {
  return {
    title: "Fixture pipeline",
    ownerAgentId,
    probe: {
      plugin: {
        path: "/workspace/plugin.ts",
        id: "fixture-plugin",
        schemaVersion: 1,
        config: {}
      },
      policy: {
        workspaceRoot: "/workspace",
        allowedHttpOrigins: [],
        allowedExecutables: [],
        allowedEnvironment: [],
        timeoutMilliseconds: 1_000,
        maxOutputBytes: 4_096
      }
    },
    intervalMilliseconds: 100,
    maxWaitMilliseconds: 60_000,
    maxAttempts: 10,
    callback: {
      providerSessionId: "provider-session-1",
      adapterId: "fake-agent-v1",
      workspace: "/workspace",
      localSessionId: sessionId,
      prompt: "Report completion."
    }
  };
}
