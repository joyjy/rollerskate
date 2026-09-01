import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ContinuousSubscriptionStore } from
  "../src/capabilities/subscription/continuous-store.js";
import { SubscriptionStore } from "../src/capabilities/subscription/store.js";
import { localId } from "../src/core/id.js";
import { runSubscriptionCommand } from "../src/entrypoints/cli/subscription.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";

test("Subscription CLI closes legacy add before reading input", () => {
  for (const arguments_ of [
    ["add", "--help"],
    ["add", "/missing/subscription.json"]
  ]) {
    assert.throws(
      () => runSubscriptionCommand(
        "/missing",
        arguments_,
        { write() {} },
        "/missing/runtime"
      ),
      /legacy_trigger_write_closed.*RunIntent@1/
    );
  }
});

test("legacy one-shot and continuous Subscriptions cannot resume through public control", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-subscription-cutover-repo-"));
  const runtimeDirectory = mkdtempSync(
    join(tmpdir(), "rollerskate-subscription-cutover-runtime-")
  );
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    bootstrapLocalFoundation(paths, "2026-08-26T10:00:00.000Z");
    const foundation = new LocalFoundationStore(paths.database);
    const owner = foundation.addAgent("legacy-owner", "codex", "2026-08-26T10:00:00.000Z");
    foundation.close();
    const policy = {
      workspaceRoot: repo,
      allowedHttpOrigins: [] as string[],
      allowedExecutables: [] as string[],
      allowedEnvironment: [] as string[],
      timeoutMilliseconds: 1_000,
      maxOutputBytes: 4_096
    };
    const oneShotStore = new SubscriptionStore(paths.database);
    const oneShot = oneShotStore.create({
      schemaVersion: 3,
      revision: "legacy-v1",
      title: "Legacy one-shot",
      ownerAgentId: owner.principalId,
      probe: {
        plugin: {
          path: join(repo, "legacy-plugin.ts"),
          id: "legacy-poll",
          schemaVersion: 1,
          config: {}
        },
        artifactRevision: "legacy-v1",
        artifactDigest: `sha256:${"0".repeat(64)}`,
        policy
      },
      intervalMilliseconds: 1_000,
      maxWaitMilliseconds: 60_000,
      maxAttempts: 60,
      callbacks: [],
      approvedGrantDigest: createHash("sha256").update("[]").digest("base64url")
    }, "2026-08-26T10:00:00.000Z");
    oneShotStore.close();

    const continuousStore = new ContinuousSubscriptionStore(paths.database);
    const callbackId = localId("scb");
    const continuous = continuousStore.create({
      schemaVersion: "ContinuousSubscriptionDefinition@1",
      revision: 1,
      title: "Legacy continuous",
      ownerAgentId: owner.principalId,
      probe: {
        plugin: { path: join(repo, "legacy-plugin.ts"), id: "legacy-poll", config: {} },
        policy
      },
      intervalMilliseconds: 1_000,
      callbacks: [{
        callbackId,
        kind: "destination.deliver",
        definition: {
          schemaVersion: "ProactiveCallbackDefinition@1",
          callbackId,
          kind: "destination.deliver",
          destinationId: "dst_019fa649-637b-7bf2-ad2b-a9b7be044fcd",
          destinationKind: "macos-notification",
          address: { channel: "owner" },
          payload: { title: "Legacy", body: "readback" }
        },
        grant: {
          schemaVersion: "ProactiveCallbackGrant@1",
          kind: "destination.deliver",
          destinationId: "dst_019fa649-637b-7bf2-ad2b-a9b7be044fcd",
          destinationKind: "macos-notification",
          address: { channel: "owner" }
        }
      }]
    }, "2026-08-26T10:00:00.000Z");
    continuousStore.close();

    for (const subscriptionId of [oneShot.subscriptionId, continuous.subscriptionId]) {
      assert.equal(runSubscriptionCommand(
        repo,
        ["pause", subscriptionId],
        { write() {} },
        runtimeDirectory
      ), 0);
      assert.throws(() => runSubscriptionCommand(
        repo,
        ["resume", subscriptionId],
        { write() {} },
        runtimeDirectory
      ), /legacy_trigger_execution_closed/);
      assert.equal(runSubscriptionCommand(
        repo,
        ["cancel", subscriptionId],
        { write() {} },
        runtimeDirectory
      ), 0);
    }

    let output = "";
    assert.equal(runSubscriptionCommand(
      repo,
      ["list"],
      { write(value) { output += value; } },
      runtimeDirectory
    ), 0);
    assert.equal((JSON.parse(output) as unknown[]).length, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});
