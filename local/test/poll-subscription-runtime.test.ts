import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";
import { RuntimeCycle } from "../src/core/runtime/cycle.js";
import {
  AgentHandler,
  ResultHandler,
  DeliveryHandler,
  type RuntimeAgentAdapter,
  type RuntimeEventHandler
} from "../src/core/runtime/handlers.js";
import type { RuntimeHandlerKind } from "../src/core/runtime/model.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import type { CreatePollSubscription } from "../src/capabilities/subscription/model.js";
import { PollProbeExecutor } from "../src/capabilities/subscription/plugin-runner.js";
import { PollSubscriptionRuntime } from "../src/capabilities/subscription/runtime.js";
import { PollSubscriptionStore } from "../src/capabilities/subscription/store.js";
import {
  MacOsNotificationAdapter,
  type MacOsNotification
} from "../src/integrations/notification/macos.js";

test("terminal poll only emits subscription.fire; unified loop resumes the exact Session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-subscription-runtime-"));
  const database = join(directory, "runtime.db");
  const plugin = join(directory, "plugin.ts");
  writeFileSync(plugin, `
export default {
  kind: "subscription.probe",
  id: "fixture-plugin",
  schemaVersion: 1,
  plan() { return { kind: "http", url: "http://localhost:3000/status" }; },
  evaluate() {
    return { version: "internal-only", facts: { status: "success" }, terminal: "success" };
  }
};
`);
  const ownerAgentId = seedAgent(database);
  const sessionId = seedSession(database, ownerAgentId);
  const subscriptions = new PollSubscriptionStore(database);
  subscriptions.create(
    subscription(ownerAgentId, sessionId, plugin),
    "2026-07-22T10:00:00.000Z"
  );
  subscriptions.close();
  const polling = new PollSubscriptionRuntime({
    databasePath: database,
    probeExecutor: new PollProbeExecutor({
      fetch: async () => Response.json({ status: "success" })
    })
  });

  const polled = await polling.runCycle(new AbortController().signal,
    "2026-07-22T10:00:00.100Z");
  assert.equal(polled.polled.length, 1);
  assert.equal(polled.fired.length, 1);
  assert.equal(polled.failed.length, 0);

  const runtime = new RuntimeStore(database);
  try {
    const fire = runtime.events().find((event) => event.type === "subscription.fire")!;
    assert.equal(fire.type, "subscription.fire");
    assert.equal(fire.sessionId, sessionId);
    assert.equal(fire.prompt, "Report completion.");
    assert.equal(fire.destinationIds.length, 1);
    const notificationDestination = runtime.destination(fire.destinationIds[0]!);
    assert.equal(notificationDestination?.kind, "macos-notification");
    assert.deepEqual(notificationDestination?.address, {
      title: "Fixture pipeline",
      subscriptionId: polled.fired[0]!.subscriptionId,
      callbackAdapterId: "fake-agent-v1",
      providerSessionId: "provider-session-1"
    });
    const resumed: Array<string | undefined> = [];
    const notifications: MacOsNotification[] = [];
    const adapter: RuntimeAgentAdapter = {
      adapterId: "fake-agent-v1",
      workspace: "/workspace",
      async invoke(input) {
        resumed.push(input.providerSessionId);
        return {
          providerSessionId: input.providerSessionId!,
          outcome: { kind: "message", body: "subscription handled" }
        };
      }
    };
    const cycle = new RuntimeCycle({
      store: runtime,
      handlers: new Map<RuntimeHandlerKind, RuntimeEventHandler>([
        ["agent", new AgentHandler({
          store: runtime,
          adapters: new Map([[ownerAgentId, adapter]])
        })],
        ["result", new ResultHandler(runtime)]
      ]),
      deliveryHandler: new DeliveryHandler({
        store: runtime,
        adapters: new Map([[
          "macos-notification",
          new MacOsNotificationAdapter(async (notification) => {
            notifications.push(notification);
          })
        ]])
      })
    });
    await cycle.run("2026-07-22T10:00:01.000Z");
    assert.deepEqual(resumed, ["provider-session-1"]);
    assert.deepEqual(notifications, [{
      title: "Fixture pipeline",
      subtitle: "Rollerskate",
      body: "Result saved to the original task. Reopen it; restart the client if the open view has not refreshed."
    }]);
    const resultEvent = runtime.events().find((event) =>
      event.type === "agent.result" && event.causality.parentEventId === fire.eventId);
    assert.equal(resultEvent?.type, "agent.result");
    assert.equal(resultEvent?.output, "subscription handled");
    const delivery = runtime.deliveriesForResultEvent(resultEvent!.eventId)[0];
    assert.equal(delivery?.status, "delivered");
    assert.equal(delivery?.maxAttempts, 1);
  } finally {
    runtime.close();
  }
});

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
    runtime.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "session-seed" },
      agentId: ownerAgentId,
      prompt: "seed",
      createdAt: "2026-07-22T09:59:00.000Z"
    });
    const execution = runtime.claimDueExecutions(1, "2026-07-22T09:59:00.000Z")[0]!;
    const resultEvent = runtime.completeExecution(execution.executionId, {
      adapterId: "fake-agent-v1",
      workspace: "/workspace",
      providerSessionId: "provider-session-1",
      output: "seeded"
    }, "2026-07-22T09:59:01.000Z");
    assert.equal(resultEvent?.type, "agent.result");
    const resultExecution = runtime.claimDueExecutions(1, "2026-07-22T09:59:01.000Z")[0]!;
    runtime.completeResultExecution(resultExecution.executionId, "2026-07-22T09:59:01.000Z");
    return resultEvent.sessionId!;
  } finally {
    runtime.close();
  }
}

function subscription(
  ownerAgentId: string,
  sessionId: string,
  pluginPath: string
): CreatePollSubscription {
  return {
    title: "Fixture pipeline",
    ownerAgentId,
    probe: {
      plugin: {
        path: pluginPath,
        id: "fixture-plugin",
        schemaVersion: 1,
        config: {}
      },
      policy: {
        workspaceRoot: "/workspace",
        allowedHttpOrigins: ["http://localhost:3000"],
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
