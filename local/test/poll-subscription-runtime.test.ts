import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
  const sessionId = seedSession(database);
  const subscriptions = new PollSubscriptionStore(database);
  subscriptions.create(subscription(sessionId, plugin), "2026-07-22T10:00:00.000Z");
  subscriptions.close();
  const polling = new PollSubscriptionRuntime({
    databasePath: database,
    probeExecutor: new PollProbeExecutor({
      fetch: async () => Response.json({ status: "success" })
    })
  });

  const polled = await polling.runCycle(new AbortController().signal,
    "2026-07-22T10:00:00.000Z");
  assert.equal(polled.polled.length, 1);
  assert.equal(polled.fired.length, 1);
  assert.equal(polled.failed.length, 0);

  const runtime = new RuntimeStore(database);
  try {
    const fire = runtime.events().find((event) => event.type === "subscription.fire")!;
    assert.equal(fire.type, "subscription.fire");
    assert.equal(fire.sessionId, sessionId);
    assert.equal(fire.prompt, "Report completion.");
    assert.equal(fire.destinationIds.length, 0);
    const resumed: Array<string | undefined> = [];
    const adapter: RuntimeAgentAdapter = {
      adapterId: "fake-agent-v1",
      workspace: "/workspace",
      async invoke(input) {
        resumed.push(input.providerSessionId);
        return { providerSessionId: input.providerSessionId!, output: "subscription handled" };
      }
    };
    const cycle = new RuntimeCycle({
      store: runtime,
      handlers: new Map<RuntimeHandlerKind, RuntimeEventHandler>([
        ["agent", new AgentHandler({ store: runtime, adapters: new Map([["agent-1", adapter]]) })],
        ["result", new ResultHandler(runtime)]
      ]),
      deliveryHandler: new DeliveryHandler({ store: runtime, adapters: new Map() })
    });
    await cycle.run("2026-07-22T10:00:01.000Z");
    assert.deepEqual(resumed, ["provider-session-1"]);
    const resultEvent = runtime.events().find((event) =>
      event.type === "agent.result" && event.causality.parentEventId === fire.eventId);
    assert.equal(resultEvent?.type, "agent.result");
    assert.equal(resultEvent?.output, "subscription handled");
  } finally {
    runtime.close();
  }
});

function seedSession(database: string): string {
  const runtime = new RuntimeStore(database);
  try {
    runtime.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "session-seed" },
      agentId: "agent-1",
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
    const resultExecution = runtime.claimDueExecutions(1, "2026-07-22T09:59:01.000Z")[0]!;
    runtime.completeResultExecution(resultExecution.executionId, "2026-07-22T09:59:01.000Z");
    return resultEvent.sessionId!;
  } finally {
    runtime.close();
  }
}

function subscription(sessionId: string, pluginPath: string): CreatePollSubscription {
  return {
    subscriptionId: "sub-runtime-1",
    pluginPath,
    pluginId: "fixture-plugin",
    pluginSchemaVersion: 1,
    pluginConfig: {},
    policy: {
      workspaceRoot: "/workspace",
      allowedHttpOrigins: ["http://localhost:3000"],
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
