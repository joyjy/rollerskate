import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CreatePollSubscription } from "../src/capabilities/subscription/model.js";
import { PollSubscriptionStore } from "../src/capabilities/subscription/store.js";
import { RuntimeStore } from "../src/core/runtime/store.js";

test("terminal observation atomically creates one subscription.fire Event", () => {
  const database = testDatabase();
  const sessionId = seedSession(database);
  const store = new PollSubscriptionStore(database);
  try {
    store.create(subscription(sessionId), "2026-07-22T10:00:00.000Z");
    store.beginAttempt("sub-1", "2026-07-22T10:00:00.000Z");
    const first = store.recordObservation("sub-1", {
      version: "plugin-internal-version",
      facts: { status: "success" },
      terminal: "success"
    }, "2026-07-22T10:00:01.000Z");
    const duplicate = store.recordObservation("sub-1", {
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
    assert.deepEqual(runtime.events().flatMap((event) => event.type === "subscription.fire"
      ? [{
        type: event.type,
        source: event.source,
        sessionId: event.sessionId,
        prompt: event.prompt,
        destinationIds: event.destinationIds
      }]
      : []), [{
      type: "subscription.fire",
      source: { kind: "subscription", externalId: "sub-1" },
      sessionId,
      prompt: "Report completion.",
      destinationIds: []
    }]);
  } finally {
    runtime.close();
  }
});

test("non-terminal polls update durable schedule without creating Events", () => {
  const database = testDatabase();
  const sessionId = seedSession(database);
  const store = new PollSubscriptionStore(database);
  store.create(subscription(sessionId), "2026-07-22T10:00:00.000Z");
  store.beginAttempt("sub-1", "2026-07-22T10:00:00.000Z");
  store.recordObservation("sub-1", {
    version: "poll-debug-only",
    facts: { status: "running" },
    terminal: null
  }, "2026-07-22T10:00:01.000Z");
  store.close();

  const restored = new PollSubscriptionStore(database);
  try {
    assert.equal(restored.require("sub-1").status, "active");
    assert.equal(restored.require("sub-1").nextPollAt, "2026-07-22T10:00:01.100Z");
    assert.equal(restored.require("sub-1").fireEventId, undefined);
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
  const sessionId = seedSession(database);
  const store = new PollSubscriptionStore(database);
  try {
    store.create(subscription(sessionId), "2026-07-22T10:00:00.000Z");
    store.setStatus("sub-1", "cancel", "2026-07-22T10:00:01.000Z");
    const recorded = store.recordObservation("sub-1", {
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

test("Subscription becomes expired after maxWaitMilliseconds without firing", () => {
  const database = testDatabase();
  const sessionId = seedSession(database);
  const store = new PollSubscriptionStore(database);
  try {
    store.create({
      ...subscription(sessionId),
      maxWaitMilliseconds: 1_000
    }, "2026-07-22T10:00:00.000Z");

    assert.deepEqual(store.due("2026-07-22T10:00:01.000Z"), []);
    assert.equal(store.require("sub-1").status, "expired");
    assert.equal(store.require("sub-1").fireEventId, undefined);
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

function testDatabase(): string {
  return join(mkdtempSync(join(tmpdir(), "rollerskate-subscription-store-")), "runtime.db");
}

function seedSession(database: string): string {
  const runtime = new RuntimeStore(database);
  try {
    const appended = runtime.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "session-seed" },
      agentId: "agent-1",
      prompt: "seed",
      createdAt: "2026-07-22T09:59:00.000Z"
    });
    const execution = runtime.claimDueExecutions(1, "2026-07-22T09:59:00.000Z")[0]!;
    return runtime.completeExecution(execution.executionId, {
      adapterId: "fake-agent-v1",
      workspace: "/workspace",
      providerSessionId: "provider-session-1",
      output: "seeded"
    }, "2026-07-22T09:59:01.000Z").sessionId!;
  } finally {
    runtime.close();
  }
}

function subscription(sessionId: string): CreatePollSubscription {
  return {
    subscriptionId: "sub-1",
    pluginPath: "/workspace/plugin.ts",
    pluginId: "fixture-plugin",
    pluginSchemaVersion: 1,
    pluginConfig: {},
    policy: {
      workspaceRoot: "/workspace",
      allowedHttpOrigins: [],
      allowedExecutables: [],
      allowedEnvironment: [],
      timeoutMilliseconds: 1_000,
      maxOutputBytes: 4_096
    },
    intervalMilliseconds: 100,
    maxWaitMilliseconds: 60_000,
    maxAttempts: 10,
    callback: { sessionId, prompt: "Report completion." }
  };
}
