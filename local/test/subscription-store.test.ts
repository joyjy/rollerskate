import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { FreeSubscriptionDefinition } from "../src/capabilities/subscription/model.js";
import { SubscriptionStore } from "../src/capabilities/subscription/store.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";

test("terminal observation becomes durable callback input without admitting an Event", () => {
  const database = testDatabase();
  const ownerAgentId = seedAgent(database);
  const store = new SubscriptionStore(database);
  try {
    const subscriptionId = store.create(
      definition(ownerAgentId),
      "2026-07-22T10:00:00.000Z"
    ).subscriptionId;
    store.beginAttempt(subscriptionId, "2026-07-22T10:00:00.100Z");
    const completed = store.recordObservation(subscriptionId, {
      version: "plugin-v1",
      facts: { status: "success" },
      terminal: "success",
      summary: "Pipeline passed"
    }, "2026-07-22T10:00:01.000Z");

    assert.equal(completed.status, "completed");
    assert.equal(completed.terminalKey, `subscription:${subscriptionId}:terminal`);
    assert.deepEqual(completed.terminalObservation, {
      version: "plugin-v1",
      terminalKey: `subscription:${subscriptionId}:terminal`,
      facts: { status: "success" },
      terminal: "success",
      summary: "Pipeline passed"
    });
  } finally {
    store.close();
  }
  const runtime = new RuntimeStore(database);
  try {
    assert.equal(runtime.events().filter(({ type }) => type === "subscription.fire").length, 0);
  } finally {
    runtime.close();
  }
});

test("non-terminal observations advance the durable poll schedule", () => {
  const database = testDatabase();
  const store = new SubscriptionStore(database);
  const subscriptionId = store.create(
    definition(seedAgent(database)),
    "2026-07-22T10:00:00.000Z"
  ).subscriptionId;
  store.beginAttempt(subscriptionId, "2026-07-22T10:00:00.100Z");
  store.recordObservation(subscriptionId, {
    version: "poll-v1",
    facts: { status: "running" },
    terminal: null
  }, "2026-07-22T10:00:01.000Z");
  store.close();

  const restored = new SubscriptionStore(database);
  try {
    assert.equal(restored.require(subscriptionId).status, "active");
    assert.equal(restored.require(subscriptionId).nextPollAt, "2026-07-22T10:00:01.100Z");
  } finally {
    restored.close();
  }
});

test("cancelled Subscription ignores a late terminal observation", () => {
  const database = testDatabase();
  const store = new SubscriptionStore(database);
  try {
    const subscriptionId = store.create(
      definition(seedAgent(database)),
      "2026-07-22T10:00:00.000Z"
    ).subscriptionId;
    store.setStatus(subscriptionId, "cancel", "2026-07-22T10:00:01.000Z");
    const recorded = store.recordObservation(subscriptionId, {
      version: "late-terminal",
      facts: {},
      terminal: "success"
    }, "2026-07-22T10:00:02.000Z");
    assert.equal(recorded.status, "cancelled");
    assert.equal(recorded.terminalObservation, undefined);
  } finally {
    store.close();
  }
});

test("Subscription archive visibility is reversible and limited to terminal state", () => {
  const database = testDatabase();
  const store = new SubscriptionStore(database);
  try {
    const subscriptionId = store.create(
      definition(seedAgent(database)),
      "2026-07-22T10:00:00.000Z"
    ).subscriptionId;
    assert.throws(
      () => store.setArchived(subscriptionId, true),
      /Only terminal Subscriptions can be archived/
    );
    store.setStatus(subscriptionId, "cancel", "2026-07-22T10:00:01.000Z");
    const archived = store.setArchived(
      subscriptionId,
      true,
      "2026-07-22T10:00:02.000Z"
    );
    assert.equal(archived.changed, true);
    assert.equal(archived.subscription.archivedAt, "2026-07-22T10:00:02.000Z");
    const unarchived = store.setArchived(subscriptionId, false);
    assert.equal(unarchived.subscription.archivedAt, undefined);
    assert.equal(unarchived.subscription.status, "cancelled");
  } finally {
    store.close();
  }
});

test("terminal observations remain bounded", () => {
  const database = testDatabase();
  const store = new SubscriptionStore(database);
  try {
    const subscriptionId = store.create(
      definition(seedAgent(database)),
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
  } finally {
    store.close();
  }
});

test("Subscription expires at its deadline without running callbacks", () => {
  const database = testDatabase();
  const store = new SubscriptionStore(database);
  try {
    const subscriptionId = store.create({
      ...definition(seedAgent(database)),
      maxWaitMilliseconds: 1_000
    }, "2026-07-22T10:00:00.000Z").subscriptionId;
    assert.deepEqual(store.due("2026-07-22T10:00:01.000Z"), []);
    assert.equal(store.require(subscriptionId).status, "expired");
  } finally {
    store.close();
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

function definition(ownerAgentId: string): FreeSubscriptionDefinition {
  return {
    schemaVersion: 3,
    revision: "fixture-v1",
    title: "Fixture pipeline",
    ownerAgentId,
    probe: {
      plugin: {
        path: "/workspace/plugin.ts",
        id: "fixture-plugin",
        schemaVersion: 1,
        config: {}
      },
      artifactRevision: "fixture-source-v1",
      artifactDigest: `sha256:${"0".repeat(64)}`,
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
    callbacks: [],
    approvedGrantDigest: createHash("sha256").update("[]").digest("base64url")
  };
}
