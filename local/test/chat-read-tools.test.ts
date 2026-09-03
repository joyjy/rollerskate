import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  callChatReadTool,
  chatReadToolDefinitions,
  createChatReadToolContext,
  parseChatReadToolRequest
} from "../src/application/chat/read-tool-policy.js";
import { startStewardRunFromIntent } from
  "../src/application/steward/intent-control.js";
import { SubscriptionStore } from
  "../src/capabilities/subscription/store.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { openRuntimeDatabase } from
  "../src/infrastructure/sqlite/database.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";

test("Chat read tool policy exposes bounded read-only evidence without raw authority", () => {
  const fixture = setup();
  try {
    const run = startStewardRunFromIntent(fixture.repo, {
      schemaVersion: "RunIntent@1",
      requestId: "chat-read-tools-run",
      objective: "Inspect one bounded local fact",
      acceptance: ["The fact is reported"],
      contextRefs: [],
      requestedParticipantRefs: ["agent:worker"],
      terminalEvidence: ["Run trace"]
    }, fixture.runtimeDirectory, "2026-09-03T00:00:01.000Z").run;
    const context = createChatReadToolContext({
      repoRoot: fixture.repo,
      runtimeDirectory: fixture.runtimeDirectory
    });

    const capabilities = callChatReadTool(context, "describe_capabilities", {}) as {
      mutationAllowed: boolean;
      tools: Array<{ name: string }>;
    };
    assert.equal(capabilities.mutationAllowed, false);
    assert.deepEqual(capabilities.tools.map(({ name }) => name), [
      "describe_capabilities", "subscription_history", "get_run", "event_trace"
    ]);
    assert.ok(chatReadToolDefinitions.every((definition) =>
      definition.annotations.readOnlyHint && !definition.annotations.destructiveHint
    ));

    const subscription = callChatReadTool(context, "subscription_history", {
      subscriptionId: fixture.subscriptionId
    }) as ChatSubscriptionHistory;
    assert.equal(subscription.schemaVersion, "ChatSubscriptionHistory@1");
    assert.equal(subscription.queryStatus, "success");
    assert.equal(subscription.reasonCode, null);
    assert.deepEqual(subscription.fires, []);
    assert.equal(subscription.truncated, false);
    const abbreviated = callChatReadTool(context, "subscription_history", {
      subscriptionId: fixture.subscriptionId.slice(0, 12)
    }) as ChatSubscriptionHistory;
    assert.equal(abbreviated.queryStatus, "success");
    assert.equal(abbreviated.subscriptionId, fixture.subscriptionId);
    const longerPrefix = callChatReadTool(context, "subscription_history", {
      subscriptionId: fixture.subscriptionId.replaceAll("-", "").slice(0, 20)
    }) as ChatSubscriptionHistory;
    assert.equal(longerPrefix.queryStatus, "success");
    assert.equal(longerPrefix.subscriptionId, fixture.subscriptionId);

    const runEvidence = callChatReadTool(context, "get_run", {
      runId: run.runId
    }) as { schemaVersion: string; summary: { runId: string }; steps: unknown[] };
    assert.equal(runEvidence.schemaVersion, "ChatRunEvidence@1");
    assert.equal(runEvidence.summary.runId, run.runId);
    assert.equal(runEvidence.steps.length, 1);
    assert.equal((runEvidence.steps[0] as { status: string }).status, "queued");
    assert.doesNotMatch(JSON.stringify(runEvidence), /rawOutput|effectivePrompt|workspace.*root/);

    const runtime = new RuntimeStore(fixture.database);
    const event = runtime.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "chat-read-event" },
      agentId: fixture.workerId,
      prompt: "Inspect api_key=super-secret-value without changing anything",
      maxAttempts: 1,
      createdAt: "2026-09-03T00:00:02.000Z"
    }).event;
    runtime.close();
    const trace = callChatReadTool(context, "event_trace", {
      eventId: event.eventId
    }) as { schemaVersion: string; event: { contentSummary: string } };
    assert.equal(trace.schemaVersion, "ChatEventTrace@1");
    assert.match(trace.event.contentSummary, /api_key=\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(trace), /super-secret-value/);
  } finally {
    fixture.close();
  }
});

test("Subscription history read tool returns stable structured errors", () => {
  const fixture = setup();
  try {
    const context = createChatReadToolContext({
      repoRoot: fixture.repo,
      runtimeDirectory: fixture.runtimeDirectory
    });
    const invalid = callChatReadTool(context, "subscription_history", {
      subscriptionId: "sub_invalid"
    }) as ChatSubscriptionHistory;
    assert.equal(invalid.queryStatus, "error");
    assert.equal(invalid.reasonCode, "invalid_subscription_id");
    assert.deepEqual(invalid.fires, []);

    const unknown = callChatReadTool(context, "subscription_history", {
      subscriptionId: "sub_019f0000-0000-7000-8000-000000000099"
    }) as ChatSubscriptionHistory;
    assert.equal(unknown.queryStatus, "error");
    assert.equal(unknown.reasonCode, "subscription_not_found");
    assert.deepEqual(unknown.fires, []);

    const legacyDatabase = openRuntimeDatabase(fixture.database);
    legacyDatabase.prepare(`
      UPDATE subscriptions
      SET terminal_key = 'legacy-terminal',
        callback_phase_status = 'completed_with_unknown', status = 'completed'
      WHERE subscription_id = ?
    `).run(fixture.subscriptionId);
    legacyDatabase.close();
    const legacy = callChatReadTool(context, "subscription_history", {
      subscriptionId: fixture.subscriptionId.slice(0, 12)
    }) as ChatSubscriptionHistory;
    assert.equal(legacy.queryStatus, "error");
    assert.equal(legacy.reasonCode, "legacy_link_not_recorded");

    const secondId = createSubscription(
      fixture.database,
      fixture.repo,
      fixture.stewardId,
      "ambiguous"
    );
    const database = openRuntimeDatabase(fixture.database);
    database.prepare(
      "UPDATE subscriptions SET subscription_id = ? WHERE subscription_id = ?"
    ).run("sub_019f0000-0000-7000-8000-000000000001", fixture.subscriptionId);
    database.prepare(
      "UPDATE subscriptions SET subscription_id = ? WHERE subscription_id = ?"
    ).run("sub_019f0000-0000-7000-8000-000000000002", secondId);
    database.close();
    const ambiguous = callChatReadTool(context, "subscription_history", {
      subscriptionId: "sub_019f0000"
    }) as ChatSubscriptionHistory;
    assert.equal(ambiguous.queryStatus, "error");
    assert.equal(ambiguous.reasonCode, "ambiguous_subscription_id");
    assert.deepEqual(ambiguous.fires, []);

    const staleSchema = openRuntimeDatabase(fixture.database);
    staleSchema.prepare(
      "UPDATE schema_meta SET value = '69' WHERE key = 'schema_version'"
    ).run();
    staleSchema.close();
    const queryFailure = callChatReadTool(context, "subscription_history", {
      subscriptionId: "sub_019f0000-0000-7000-8000-000000000001"
    }) as ChatSubscriptionHistory;
    assert.equal(queryFailure.queryStatus, "error");
    assert.equal(queryFailure.reasonCode, "query_failed");
    assert.deepEqual(queryFailure.fires, []);
  } finally {
    fixture.close();
  }
});

test("Chat read tool policy validates requests and enforces the invocation budget", () => {
  assert.deepEqual(parseChatReadToolRequest(JSON.stringify({
    schema: "ChatReadToolRequest@1",
    tool: "event_trace",
    arguments: { eventId: "evt_exact" }
  })), {
    schema: "ChatReadToolRequest@1",
    tool: "event_trace",
    arguments: { eventId: "evt_exact" }
  });
  assert.equal(parseChatReadToolRequest("not json"), undefined);
  assert.throws(() => parseChatReadToolRequest(JSON.stringify({
    schema: "ChatReadToolRequest@1",
    tool: "run_cancel",
    arguments: {}
  })), /malformed/);
  assert.throws(() => parseChatReadToolRequest(JSON.stringify({
    schema: "ChatReadToolRequest@1",
    tool: "event_trace",
    arguments: { eventId: "evt_exact" },
    mutate: true
  })), /malformed/);

  const context = createChatReadToolContext({ repoRoot: "/repo" });
  for (let request = 0; request < 20; request += 1) {
    callChatReadTool(context, "describe_capabilities", {});
  }
  assert.throws(() => callChatReadTool(context, "describe_capabilities", {}),
    /exceed twenty requests/);
  assert.throws(() => callChatReadTool(
    createChatReadToolContext({ repoRoot: "/repo" }),
    "describe_capabilities",
    { unexpected: true }
  ), /arguments are malformed/);
  assert.throws(() => callChatReadTool(
    createChatReadToolContext({ repoRoot: "/repo" }),
    "get_run",
    { runId: "not-a-run" }
  ), /runId is malformed/);
});

function setup() {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-chat-read-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-chat-read-runtime-"));
  const paths = runtimePaths(repo, runtimeDirectory);
  bootstrapLocalFoundation(paths, "2026-09-03T00:00:00.000Z");
  const foundation = new LocalFoundationStore(paths.database);
  const stewardId = foundation.addAgent(
    "codex",
    "codex",
    "2026-09-03T00:00:00.000Z"
  ).principalId;
  const workerId = foundation.addAgent(
    "worker",
    "codex",
    "2026-09-03T00:00:00.000Z"
  ).principalId;
  foundation.close();
  const subscriptionId = createSubscription(
    paths.database,
    repo,
    stewardId,
    "primary"
  );
  return {
    repo,
    runtimeDirectory,
    database: paths.database,
    stewardId,
    workerId,
    subscriptionId,
    close() {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  };
}

function createSubscription(
  database: string,
  repo: string,
  stewardId: string,
  label: string
): string {
  const subscriptions = new SubscriptionStore(database);
  const subscriptionId = subscriptions.create({
    schemaVersion: 3,
    revision: `chat-read-${label}-v1`,
    title: `Chat read ${label}`,
    ownerAgentId: stewardId,
    probe: {
      plugin: {
        path: join(repo, "probe.mjs"),
        id: "chat-read-probe",
        schemaVersion: 1,
        config: {}
      },
      artifactRevision: "fixture-v1",
      artifactDigest: `sha256:${"0".repeat(64)}`,
      policy: {
        workspaceRoot: repo,
        allowedHttpOrigins: [],
        allowedExecutables: [],
        allowedEnvironment: [],
        timeoutMilliseconds: 1_000,
        maxOutputBytes: 4_096
      }
    },
    intervalMilliseconds: 1_000,
    maxWaitMilliseconds: 60_000,
    maxAttempts: 3,
    callbacks: [],
    approvedGrantDigest: createHash("sha256").update("[]").digest("base64url")
  }, "2026-09-03T00:00:00.000Z").subscriptionId;
  subscriptions.close();
  return subscriptionId;
}

interface ChatSubscriptionHistory {
  readonly schemaVersion: string;
  readonly queryStatus: "success" | "error";
  readonly subscriptionId: string;
  readonly reasonCode: string | null;
  readonly fires: readonly unknown[];
  readonly truncated: boolean;
}
