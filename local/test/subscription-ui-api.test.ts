import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import { LocalFoundationStore } from "../src/application/local-foundation.js";
import type { CreatePollSubscription } from "../src/capabilities/subscription/model.js";
import { PollSubscriptionStore } from "../src/capabilities/subscription/store.js";
import { startUiServer } from "../src/entrypoints/console/launcher.js";
import { RuntimeStore } from "../src/core/runtime/store.js";

test("loopback UI API reads durable Subscriptions and applies explicit control actions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-subscription-ui-"));
  const database = join(directory, "runtime.db");
  const ownerAgentId = seedAgent(database);
  const sessionId = seedSession(database, directory, ownerAgentId);
  const store = new PollSubscriptionStore(database);
  let subscriptionId = "";
  try {
    subscriptionId = store.create(
      subscription(directory, ownerAgentId, sessionId),
      "2026-07-22T10:00:00.000Z"
    ).subscriptionId;
  } finally {
    store.close();
  }
  const controller = new AbortController();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const server = await startUiServer({
    repoRoot,
    runtimeDirectory: directory,
    port: 0,
    signal: controller.signal
  });
  try {
    const origin = new URL(server.url).origin;
    const runtimeStatus = await fetch(`${origin}/api/runtime`);
    assert.equal(runtimeStatus.status, 200);
    const runtimeView = await runtimeStatus.json() as {
      status: string;
      version: string;
      workload: { queuedExecutions: number };
      subscriptions: { active: number };
    };
    assert.equal(runtimeView.status, "degraded");
    assert.equal(runtimeView.version, "0.3.1");
    assert.equal(runtimeView.subscriptions.active, 1);
    assert.ok(runtimeView.workload.queuedExecutions >= 0);
    const rejectedRuntimeControl = await fetch(`${origin}/api/runtime/pause`, { method: "POST" });
    assert.equal(rejectedRuntimeControl.status, 403);
    const pausedRuntime = await fetch(`${origin}/api/runtime/pause`, {
      method: "POST",
      headers: { "X-Rollerskate-Request": "console" }
    });
    assert.equal(pausedRuntime.status, 200);
    assert.equal((await pausedRuntime.json() as {
      status: string;
      controlResult: { kind: string };
    }).controlResult.kind, "pause");
    const resumedRuntime = await fetch(`${origin}/api/runtime/resume`, {
      method: "POST",
      headers: { "X-Rollerskate-Request": "console" }
    });
    assert.equal(resumedRuntime.status, 200);
    assert.equal((await resumedRuntime.json() as {
      controlResult: { kind: string };
    }).controlResult.kind, "resume");
    const recoveredRuntime = await fetch(`${origin}/api/runtime/recover`, {
      method: "POST",
      headers: { "X-Rollerskate-Request": "console" }
    });
    assert.equal(recoveredRuntime.status, 200);
    assert.equal((await recoveredRuntime.json() as {
      controlResult: { kind: string; status: string };
    }).controlResult.kind, "recover");

    const runtimeList = await fetch(`${origin}/api/runtime/events`);
    assert.equal(runtimeList.status, 200);
    const audits = await runtimeList.json() as Array<{
      event: { eventId: string; type: string; destinationIds: string[] };
      execution: { handler: string };
      deliveries: unknown[];
      lifecycleChangedAt: string;
      directChildren: unknown[];
    }>;
    assert.deepEqual(audits.map(({ event }) => event.type).sort(), ["agent.request", "agent.result"]);
    const requestAudit = audits.find(({ event }) => event.type === "agent.request")!;
    assert.equal(requestAudit.execution.handler, "agent");
    assert.deepEqual(requestAudit.event.destinationIds, []);
    assert.deepEqual(requestAudit.deliveries, []);
    assert.equal(typeof requestAudit.lifecycleChangedAt, "string");
    assert.ok(requestAudit.directChildren.length >= 1);
    const runtimeDetail = await fetch(`${origin}/api/runtime/events/${requestAudit.event.eventId}`);
    assert.equal(runtimeDetail.status, 200);
    assert.equal((await runtimeDetail.json() as { event: { eventId: string } }).event.eventId,
      requestAudit.event.eventId);
    const rejectedRuntimeWrite = await fetch(`${origin}/api/runtime/events`, { method: "POST" });
    assert.equal(rejectedRuntimeWrite.status, 405);

    const list = await fetch(`${origin}/api/subscriptions`);
    assert.equal(list.status, 200);
    const items = await list.json() as Array<{
      id: string;
      status: string;
      owner: { agentId: string; handle: string; client: string };
      callback: {
        providerSessionId: string;
        adapterId: string;
        workspace: string;
        localSessionId: string | null;
        prompt: string;
      };
      plugin: { id: string };
    }>;
    assert.deepEqual(items.map((item) => ({
      id: item.id,
      status: item.status,
      owner: item.owner,
      callback: item.callback,
      plugin: item.plugin.id
    })), [{
      id: subscriptionId,
      status: "active",
      owner: { agentId: ownerAgentId, handle: "alice", client: "codex" },
      callback: {
        providerSessionId: "provider-session-ui",
        adapterId: "fake-agent-v1",
        workspace: directory,
        localSessionId: sessionId,
        prompt: "Report the result."
      },
      plugin: "fixture"
    }
    ]);
    const rejected = await fetch(
      `${origin}/api/subscriptions/${subscriptionId}/pause`,
      { method: "POST" }
    );
    assert.equal(rejected.status, 403);
    const paused = await fetch(`${origin}/api/subscriptions/${subscriptionId}/pause`, {
      method: "POST",
      headers: { "X-Rollerskate-Request": "console" }
    });
    assert.equal(paused.status, 200);
    assert.equal((await paused.json() as { status: string }).status, "paused");
    const removedRevoke = await fetch(
      `${origin}/api/subscriptions/${subscriptionId}/revoke`,
      {
        method: "POST",
        headers: { "X-Rollerskate-Request": "console" }
      }
    );
    assert.equal(removedRevoke.status, 405);
  } finally {
    controller.abort();
    await server.close();
  }
});

function subscription(
  workspaceRoot: string,
  ownerAgentId: string,
  sessionId: string
): CreatePollSubscription {
  return {
    ownerAgentId,
    pluginPath: join(workspaceRoot, "plugin.ts"),
    pluginId: "fixture",
    pluginSchemaVersion: 1,
    pluginConfig: {},
    policy: {
      workspaceRoot,
      allowedHttpOrigins: [],
      allowedExecutables: [],
      allowedEnvironment: [],
      timeoutMilliseconds: 1_000,
      maxOutputBytes: 4_096
    },
    intervalMilliseconds: 1_000,
    maxWaitMilliseconds: 60_000,
    maxAttempts: 10,
    callback: {
      providerSessionId: "provider-session-ui",
      adapterId: "fake-agent-v1",
      workspace: workspaceRoot,
      localSessionId: sessionId,
      prompt: "Report the result."
    }
  };
}

function seedAgent(database: string): string {
  const foundation = new LocalFoundationStore(database);
  try {
    return foundation.addAgent("alice", "codex").principalId;
  } finally {
    foundation.close();
  }
}

function seedSession(database: string, workspace: string, ownerAgentId: string): string {
  const runtime = new RuntimeStore(database);
  try {
    runtime.appendEvent({
      type: "agent.request", source: { kind: "cli" }, agentId: ownerAgentId, prompt: "seed"
    });
    const execution = runtime.claimDueExecutions()[0]!;
    const result = runtime.completeExecution(execution.executionId, {
      adapterId: "fake-agent-v1",
      workspace,
      providerSessionId: "provider-session-ui",
      output: "seeded"
    });
    assert.equal(result?.type, "agent.result");
    return result.sessionId!;
  } finally {
    runtime.close();
  }
}
