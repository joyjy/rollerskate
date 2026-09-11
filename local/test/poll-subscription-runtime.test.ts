import { temporaryDirectory } from "./support/temp-directory.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { SubscriptionRuntime } from "../src/capabilities/subscription/runtime.js";
import { SubscriptionStore } from "../src/capabilities/subscription/store.js";
import { PollProbeExecutor } from "../src/capabilities/subscription/plugin-runner.js";
import { LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";

test("Subscription runtime records terminal state and leaves callback admission to its phase", async () => {
  const directory = temporaryDirectory("rollerskate-subscription-runtime-");
  const database = join(directory, "runtime.db");
  const pluginPath = join(directory, "probe.mjs");
  writeFileSync(pluginPath, `export default {
    kind: "subscription.probe",
    id: "fixture",
    schemaVersion: 1,
    plan() { return { kind: "http", url: "https://probe.example/status" }; },
    evaluate() {
      return {
        version: "fixture-v1",
        facts: { status: "success" },
        terminal: "success"
      };
    }
  };`);

  const foundation = new LocalFoundationStore(database);
  const owner = foundation.addAgent("alice", "codex");
  foundation.close();
  const store = new SubscriptionStore(database);
  const created = store.create({
    schemaVersion: 3,
    revision: "fixture-v1",
    title: "Fixture pipeline",
    ownerAgentId: owner.principalId,
    probe: {
      plugin: { path: pluginPath, id: "fixture", schemaVersion: 1, config: {} },
      artifactRevision: "fixture-source-v1",
      artifactDigest: `sha256:${createHash("sha256")
        .update(readFileSync(pluginPath)).digest("hex")}`,
      policy: {
        workspaceRoot: directory,
        allowedHttpOrigins: ["https://probe.example"],
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
  }, "2026-07-22T10:00:00.000Z");
  store.close();

  const runtime = new SubscriptionRuntime({
    databasePath: database,
    probeExecutor: new PollProbeExecutor({
      fetch: async () => Response.json({ status: "success" })
    })
  });
  const result = await runtime.runCycle(
    new AbortController().signal,
    "2026-07-22T10:00:00.100Z"
  );
  assert.deepEqual(result, { polled: [created.subscriptionId], failed: [] });
  const restarted = new SubscriptionRuntime({
    databasePath: database,
    probeExecutor: new PollProbeExecutor({
      fetch: async () => Response.json({ status: "success" })
    })
  });
  assert.deepEqual(await restarted.runCycle(
    new AbortController().signal,
    "2026-07-22T10:00:01.000Z"
  ), { polled: [], failed: [] });

  const restored = new SubscriptionStore(database);
  try {
    const subscription = restored.require(created.subscriptionId);
    assert.equal(subscription.status, "completed");
    assert.equal(subscription.callbackPhaseStatus, "completed");
    assert.equal(subscription.terminalKey, `subscription:${created.subscriptionId}:terminal`);
  } finally {
    restored.close();
  }
});
