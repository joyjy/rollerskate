import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import { LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";
import type { FreeSubscriptionDefinition } from "../src/capabilities/subscription/model.js";
import { CallbackStore } from "../src/infrastructure/callback/store.js";
import { SubscriptionStore } from "../src/capabilities/subscription/store.js";
import { localId } from "../src/core/id.js";
import { startUiServer } from "../src/entrypoints/console/launcher.js";
import { RuntimeStore } from "../src/core/runtime/store.js";

test("loopback UI API reads durable Subscriptions and applies explicit control actions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-subscription-ui-"));
  const database = join(directory, "runtime.db");
  const ownerAgentId = seedAgent(database);
  seedSession(database, directory, ownerAgentId);
  const store = new SubscriptionStore(database);
  let subscriptionId = "";
  let freeSubscriptionId = "";
  let freeCallbackId = "";
  try {
    subscriptionId = store.create(
      freeSubscription(
        directory,
        ownerAgentId,
        localId("scb")
      ),
      "2026-07-22T10:00:00.000Z"
    ).subscriptionId;
    const callbackId = localId("scb");
    freeCallbackId = callbackId;
    freeSubscriptionId = store.create(
      freeSubscription(directory, ownerAgentId, callbackId),
      "2026-07-22T10:00:01.000Z"
    ).subscriptionId;
    store.recordObservation(freeSubscriptionId, {
      version: "observation-v1",
      facts: { result: "ok" },
      terminal: "success"
    }, "2026-07-22T10:00:02.000Z");
    const callbacks = new CallbackStore(database);
    try {
      const occurrence = callbacks.beginNext({
        ownerKind: "subscription",
        ownerId: freeSubscriptionId,
        triggerOccurrenceKey: `subscription:${freeSubscriptionId}:terminal`
      },
        "2026-07-22T10:00:03.000Z"
      );
      assert.equal(occurrence?.callbackId, callbackId);
      callbacks.succeed(
        occurrence!.occurrenceId,
        { channel: "native", delivered: true },
        "2026-07-22T10:00:04.000Z"
      );
    } finally {
      callbacks.close();
    }
    store.reconcileCallbacks("2026-07-22T10:00:04.000Z");
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
      controls: { pause: boolean; resume: boolean; recover: boolean };
      workload: { state: string; ready: number };
      failures: Array<{ owner: string }>;
    };
    assert.equal(runtimeView.status, "stopped");
    assert.equal(runtimeView.version, "0.5.4");
    assert.deepEqual(runtimeView.controls, { pause: false, resume: false, recover: false });
    assert.ok(runtimeView.workload.ready >= 0);
    assert.ok(runtimeView.failures.every((failure) => failure.owner !== "runtime"));
    const rejectedRuntimeControl = await fetch(`${origin}/api/runtime/pause`, { method: "POST" });
    assert.equal(rejectedRuntimeControl.status, 403);
    const pausedRuntime = await fetch(`${origin}/api/runtime/pause`, {
      method: "POST",
      headers: { "X-Rollerskate-Request": "console" }
    });
    assert.equal(pausedRuntime.status, 400);
    const resumedRuntime = await fetch(`${origin}/api/runtime/resume`, {
      method: "POST",
      headers: { "X-Rollerskate-Request": "console" }
    });
    assert.equal(resumedRuntime.status, 400);
    const recoveredRuntime = await fetch(`${origin}/api/runtime/recover`, {
      method: "POST",
      headers: { "X-Rollerskate-Request": "console" }
    });
    assert.equal(recoveredRuntime.status, 400);

    const runtimeList = await fetch(`${origin}/api/events`);
    assert.equal(runtimeList.status, 200);
    const audits = await runtimeList.json() as Array<{
      event: {
        eventId: string;
        type: string;
        destinationIds: string[];
        prompt?: string;
        boundedPromptSummary?: string;
      };
      execution: { handler: string };
      resultEvent?: { output?: string };
      invocation?: unknown;
      deliveries: unknown[];
      lifecycleChangedAt: string;
      directChildren: unknown[];
      conversationTimeline?: unknown[];
    }>;
    assert.ok(audits.every((audit) => audit.conversationTimeline === undefined));
    assert.deepEqual(audits.map(({ event }) => event.type).sort(), ["agent.request", "agent.result"]);
    const requestAudit = audits.find(({ event }) => event.type === "agent.request")!;
    assert.equal(requestAudit.execution.handler, "agent");
    assert.equal(requestAudit.event.prompt, undefined);
    assert.equal(typeof requestAudit.event.boundedPromptSummary, "string");
    assert.equal(requestAudit.resultEvent?.output, undefined);
    assert.equal(requestAudit.invocation, undefined);
    assert.deepEqual(requestAudit.event.destinationIds, []);
    assert.deepEqual(requestAudit.deliveries, []);
    assert.equal(typeof requestAudit.lifecycleChangedAt, "string");
    assert.ok(requestAudit.directChildren.length >= 1);
    const runtimeDetail = await fetch(`${origin}/api/events/${requestAudit.event.eventId}`);
    assert.equal(runtimeDetail.status, 200);
    const runtimeDetailView = await runtimeDetail.json() as {
      event: { eventId: string };
      conversationTimeline?: unknown[];
    };
    assert.equal(runtimeDetailView.event.eventId, requestAudit.event.eventId);
    assert.deepEqual(runtimeDetailView.conversationTimeline, []);
    const rejectedRuntimeWrite = await fetch(`${origin}/api/events`, { method: "POST" });
    assert.equal(rejectedRuntimeWrite.status, 405);
    const failures = await fetch(`${origin}/api/failures`);
    assert.equal(failures.status, 200);
    assert.ok(Array.isArray(await failures.json()));

    const list = await fetch(`${origin}/api/subscriptions`);
    assert.equal(list.status, 200);
    const items = await list.json() as Array<{
      kind?: string;
      id: string;
      title: string;
      status: string;
      owner: { agentId: string; handle: string; client: string };
      probe: { plugin: { id: string } };
      definition?: { schema: string; revision: string; callbackPhaseStatus: string };
      callbacks?: Array<{ status: string; grant: unknown; receipt?: unknown }>;
    }>;
    const active = items.find((item) => item.id === subscriptionId);
    assert.equal(active?.kind, "free");
    assert.equal(active?.status, "active");
    assert.equal(active?.owner.agentId, ownerAgentId);
    const free = items.find((item) => item.id === freeSubscriptionId);
    assert.equal(free?.kind, "free");
    assert.equal(free?.definition?.schema, "SubscriptionDefinition@3");
    assert.equal(free?.definition?.revision, "console-v1");
    assert.equal(free?.definition?.callbackPhaseStatus, "completed");
    const [freeCallback] = free?.callbacks ?? [];
    assert.equal(freeCallback?.status, "succeeded");
    assert.deepEqual(freeCallback?.grant, callbackGrant(freeCallbackId));
    assert.deepEqual(freeCallback?.receipt, { channel: "native", delivered: true });
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

function freeSubscription(
  workspaceRoot: string,
  ownerAgentId: string,
  callbackId: string
): FreeSubscriptionDefinition {
  const grant = callbackGrant(callbackId);
  return {
    schemaVersion: 3,
    revision: "console-v1",
    title: "Free fixture",
    ownerAgentId,
    probe: {
      plugin: { path: join(workspaceRoot, "free-probe.ts"), id: "free-fixture", schemaVersion: 1, config: {} },
      artifactRevision: "fixture-v1",
      artifactDigest: `sha256:${"0".repeat(64)}`,
      policy: {
        workspaceRoot,
        allowedHttpOrigins: [],
        allowedExecutables: [],
        allowedEnvironment: [],
        timeoutMilliseconds: 1_000,
        maxOutputBytes: 4_096
      }
    },
    intervalMilliseconds: 1_000,
    maxWaitMilliseconds: 60_000,
    maxAttempts: 10,
    callbacks: [{
      callbackId,
      kind: "destination.deliver",
      definition: {
        schemaVersion: "ProactiveCallbackDefinition@1",
        callbackId,
        kind: "destination.deliver",
        destinationId: "dst_019f0000-0000-7000-8000-000000000201",
        destinationKind: "macos-notification",
        address: { title: "Fixture complete" },
        payload: { body: "Inspect result" }
      },
      grant
    }],
    approvedGrantDigest: createHash("sha256")
      .update(stableJson([grant]))
      .digest("base64url")
  };
}

function callbackGrant(_callbackId: string): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: "ProactiveCallbackGrant@1",
    kind: "destination.deliver",
    destinationId: "dst_019f0000-0000-7000-8000-000000000201",
    destinationKind: "macos-notification",
    address: { title: "Fixture complete" }
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
