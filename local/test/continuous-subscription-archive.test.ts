import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ContinuousSubscriptionStore } from
  "../src/capabilities/subscription/continuous-store.js";
import { LocalFoundationStore } from
  "../src/infrastructure/sqlite/foundation-store.js";

test("Continuous Subscription archive visibility requires cancellation", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-continuous-archive-"));
  const database = join(directory, "runtime.db");
  const foundation = new LocalFoundationStore(database);
  const owner = foundation.addAgent("continuous-owner", "codex");
  foundation.close();
  const store = new ContinuousSubscriptionStore(database);
  try {
    const subscription = store.create({
      schemaVersion: "ContinuousSubscriptionDefinition@1",
      revision: 1,
      title: "Archive continuous fixture",
      ownerAgentId: owner.principalId,
      probe: {
        plugin: { path: join(directory, "probe.mjs"), id: "fixture", config: {} },
        policy: {
          workspaceRoot: directory,
          allowedHttpOrigins: [],
          allowedExecutables: [],
          allowedEnvironment: [],
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096
        }
      },
      intervalMilliseconds: 1_000,
      callbacks: [{
        callbackId: "agent",
        kind: "agent.invoke",
        definition: {
          schemaVersion: "ProactiveCallbackDefinition@1",
          callbackId: "agent",
          kind: "agent.invoke",
          agentId: owner.principalId,
          workspace: directory,
          prompt: "Inspect fixture"
        },
        grant: {
          schemaVersion: "ProactiveCallbackGrant@1",
          kind: "agent.invoke",
          agentId: owner.principalId,
          workspace: directory,
          workspaceAccess: "read",
          networkAccess: false
        }
      }]
    }, "2026-08-24T00:00:00.000Z");
    assert.throws(
      () => store.setArchived(subscription.subscriptionId, true),
      /cannot archive from active/
    );
    store.setStatus(subscription.subscriptionId, "cancel", "2026-08-24T00:01:00.000Z");
    const archived = store.setArchived(
      subscription.subscriptionId,
      true,
      "2026-08-24T00:02:00.000Z"
    );
    assert.equal(archived.archivedAt, "2026-08-24T00:02:00.000Z");
    const unarchived = store.setArchived(subscription.subscriptionId, false);
    assert.equal(unarchived.archivedAt, undefined);
    assert.equal(unarchived.status, "cancelled");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
