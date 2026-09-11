import { temporaryDirectory } from "./support/temp-directory.js";
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { RuntimeCycle } from "../src/core/runtime/cycle.js";
import {
  AgentHandler,
  ResultHandler,
  DeliveryHandler,
  type RuntimeAgentAdapter,
  type RuntimeDestinationAdapter,
  type RuntimeEventHandler
} from "../src/core/runtime/handlers.js";
import {
  runtimeRoute,
  type RuntimeDestination,
  type RuntimeHandlerKind
} from "../src/core/runtime/model.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { MacOsNotificationAdapter } from "../src/integrations/notification/macos.js";

test("each fixed Event type routes to exactly one local Handler", () => {
  assert.deepEqual(runtimeRoute("agent.request"), {
    eventType: "agent.request",
    handler: "agent"
  });
  assert.deepEqual(runtimeRoute("subscription.fire"), {
    eventType: "subscription.fire",
    handler: "agent"
  });
  assert.deepEqual(runtimeRoute("agent.result"), {
    eventType: "agent.result",
    handler: "result"
  });
});

test("a canonical Server Event preserves its globally assigned Event ID", () => {
  const store = runtimeStore();
  try {
    const eventId = "evt_019b0000-0000-7000-8000-000000000001";
    const receipt = store.appendEvent({
      eventId,
      type: "agent.request",
      source: { kind: "server" },
      agentId: "agent-1",
      prompt: "handle the server Event"
    });
    assert.equal(receipt.event.eventId, eventId);
    assert.equal(receipt.event.causality.rootEventId, eventId);
    assert.equal(receipt.event.source.kind, "server");
  } finally {
    store.close();
  }
});

test("unified core persists an offline Event through result Event and Matrix Delivery", async () => {
  const store = runtimeStore();
  try {
    const destination = store.putDestination({
      kind: "matrix",
      address: { roomId: "!room:example", agentId: "agent-1" },
      at: "2026-07-23T01:00:00.000Z"
    });
    const invoked: Array<{ providerSessionId?: string; prompt: string }> = [];
    const delivered: string[] = [];
    const cycle = runtimeCycle(store, {
      async invoke(input) {
        invoked.push({
          ...(input.providerSessionId === undefined ? {} : { providerSessionId: input.providerSessionId }),
          prompt: input.event.prompt
        });
        return {
          providerSessionId: "provider-session-1",
          outcome: { kind: "message", body: "finished" }
        };
      }
    }, {
      async deliver(input) {
        delivered.push(input.delivery.deliveryId);
        assert.equal(input.destination.address.roomId, "!room:example");
        assert.equal(input.resultEvent?.output, "finished");
        return { receipt: "$matrix-result" };
      }
    });
    const appended = store.appendEvent({
      type: "agent.request",
      source: { kind: "matrix", externalId: "$matrix-input" },
      agentId: "agent-1",
      prompt: "inspect the event",
      destinationIds: [destination.destinationId],
      createdAt: "2026-07-23T01:00:01.000Z"
    });
    const duplicate = store.appendEvent({
      type: "agent.request",
      source: { kind: "matrix", externalId: "$matrix-input" },
      agentId: "agent-1",
      prompt: "must deduplicate",
      destinationIds: [destination.destinationId]
    });

    assert.match(appended.event.eventId, /^evt_.*-7/);
    assert.equal(appended.event.causality.rootEventId, appended.event.eventId);
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.event.eventId, appended.event.eventId);

    const result = await cycle.run("2026-07-23T01:00:02.000Z");
    assert.equal(result.failures.length, 0);
    assert.equal(invoked.length, 1);
    assert.equal(delivered.length, 1);
    const storedResult = store.events().find((event) => event.type === "agent.result");
    assert.equal(storedResult?.outcome, "succeeded");
    assert.equal(storedResult?.source.kind, "handler");
    assert.equal(storedResult?.source.externalId, appended.execution.executionId);
    assert.equal(storedResult?.causality.parentEventId, appended.event.eventId);
    assert.equal(storedResult?.causality.rootEventId, appended.event.eventId);
    assert.equal(storedResult?.sessionId, store.sessions()[0]?.sessionId);
    assert.equal(store.executionForEvent(storedResult!.eventId)?.handler, "result");
    assert.equal(store.executionForEvent(storedResult!.eventId)?.status, "succeeded");
    const session = store.sessions()[0];
    assert.match(session?.sessionId ?? "", /^ses_.*-7/);
    assert.equal(session?.providerSessionId, "provider-session-1");
    assert.equal(store.deliveriesForResultEvent(storedResult!.eventId)[0]?.status, "delivered");
  } finally {
    store.close();
  }
});

test("explicit local Session resumes exactly and a follow-up Event advances causality", async () => {
  const store = runtimeStore();
  try {
    const seenProviderSessions: Array<string | undefined> = [];
    const cycle = runtimeCycle(store, {
      async invoke(input) {
        seenProviderSessions.push(input.providerSessionId);
        return {
          providerSessionId: input.providerSessionId ?? "provider-session-2",
          outcome: { kind: "message", body: "ok" }
        };
      }
    });
    const first = store.appendEvent({
      type: "agent.request",
      source: { kind: "cli" },
      agentId: "agent-1",
      prompt: "first",
      createdAt: "2026-07-23T02:00:00.000Z"
    });
    await cycle.run("2026-07-23T02:00:01.000Z");
    const session = store.sessions()[0]!;
    const second = store.appendEvent({
      type: "agent.request",
      source: { kind: "cli" },
      agentId: "agent-1",
      prompt: "second",
      sessionId: session.sessionId,
      parent: {
        eventId: first.event.eventId,
        rootEventId: first.event.eventId,
        hop: first.event.causality.hop
      },
      createdAt: "2026-07-23T02:00:02.000Z"
    });
    await cycle.run("2026-07-23T02:00:03.000Z");

    assert.deepEqual(seenProviderSessions, [undefined, "provider-session-2"]);
    assert.equal(second.event.causality.parentEventId, first.event.eventId);
    assert.equal(second.event.causality.rootEventId, first.event.eventId);
    assert.equal(second.event.causality.hop, 1);
    assert.equal(store.sessions().length, 1);
  } finally {
    store.close();
  }
});

test("AgentHandler applies finite annealed retries and emits one terminal failed result Event", async () => {
  const store = runtimeStore();
  try {
    const cycle = runtimeCycle(store, {
      async invoke() {
        throw new Error("provider unavailable");
      }
    }, undefined, 1_000);
    const appended = store.appendEvent({
      type: "agent.request",
      source: { kind: "cli" },
      agentId: "agent-1",
      prompt: "retry me",
      maxAttempts: 3,
      createdAt: "2026-07-23T03:00:00.000Z"
    });

    await cycle.run("2026-07-23T03:00:00.000Z");
    assert.equal(store.execution(appended.execution.executionId)?.nextAttemptAt,
      "2026-07-23T03:00:01.000Z");
    await cycle.run("2026-07-23T03:00:01.000Z");
    assert.equal(store.execution(appended.execution.executionId)?.nextAttemptAt,
      "2026-07-23T03:00:03.000Z");
    await cycle.run("2026-07-23T03:00:03.000Z");

    assert.equal(store.execution(appended.execution.executionId)?.status, "failed");
    assert.equal(store.execution(appended.execution.executionId)?.attemptCount, 3);
    assert.deepEqual(store.events().filter((event) => event.type === "agent.result")
      .map((event) => [event.outcome, event.error]), [
      ["failed", "provider unavailable"]
    ]);
  } finally {
    store.close();
  }
});

test("RuntimeCycle isolates one handler exception and continues later Executions", async () => {
  const store = runtimeStore();
  try {
    const first = store.appendEvent({
      type: "agent.request", source: { kind: "cli" }, agentId: "agent-1", prompt: "first"
    });
    const second = store.appendEvent({
      type: "agent.request", source: { kind: "cli" }, agentId: "agent-1", prompt: "second"
    });
    const handled: string[] = [];
    const cycle = new RuntimeCycle({
      store,
      handlers: new Map<RuntimeHandlerKind, RuntimeEventHandler>([
        ["agent", {
          kind: "agent" as const,
          async handle(execution) {
            handled.push(execution.executionId);
            if (execution.executionId === first.execution.executionId) throw new Error("isolated");
            store.failExecution(execution.executionId, "terminal", new Date().toISOString(), 1);
            return undefined;
          }
        }],
        ["result", new ResultHandler(store)]
      ]),
      deliveryHandler: new DeliveryHandler({ store, adapters: new Map() })
    });
    const result = await cycle.run(new Date(Date.now() + 1_000).toISOString());

    assert.deepEqual(new Set(handled), new Set([
      first.execution.executionId,
      second.execution.executionId
    ]));
    assert.deepEqual(result.failures.map((failure) => failure.id), [first.execution.executionId]);
  } finally {
    store.close();
  }
});

test("RuntimeCycle starts a claimed batch concurrently instead of downgrading to serial", {
  timeout: 3_000
}, async () => {
  const store = runtimeStore();
  try {
    const first = store.appendEvent({
      type: "agent.request", source: { kind: "cli" }, agentId: "agent-1", prompt: "first",
      maxAttempts: 1
    });
    const second = store.appendEvent({
      type: "agent.request", source: { kind: "cli" }, agentId: "agent-2", prompt: "second",
      maxAttempts: 1
    });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted!: () => void;
    const observedSecond = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const cycle = new RuntimeCycle({
      store,
      handlers: new Map<RuntimeHandlerKind, RuntimeEventHandler>([
        ["agent", {
          kind: "agent",
          async handle(execution) {
            if (execution.executionId === first.execution.executionId) {
              await firstBlocked;
            } else if (execution.executionId === second.execution.executionId) {
              secondStarted();
            }
            store.failExecution(execution.executionId, "terminal", new Date().toISOString(), 1);
          }
        }],
        ["result", new ResultHandler(store)]
      ]),
      deliveryHandler: new DeliveryHandler({ store, adapters: new Map() })
    });

    const running = cycle.run(new Date(Date.now() + 1_000).toISOString());
    await observedSecond;
    assert.equal(store.execution(second.execution.executionId)?.status, "failed");
    releaseFirst();
    await running;
  } finally {
    store.close();
  }
});

test("RuntimeCycle poll claims later independent work while an invocation is running", {
  timeout: 3_000
}, async () => {
  const store = runtimeStore();
  try {
    const first = store.appendEvent({
      type: "agent.request", source: { kind: "cli" }, agentId: "agent-1", prompt: "first",
      maxAttempts: 1
    });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const observedFirst = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let secondStarted!: () => void;
    const observedSecond = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const cycle = new RuntimeCycle({
      store,
      handlers: new Map<RuntimeHandlerKind, RuntimeEventHandler>([
        ["agent", {
          kind: "agent",
          async handle(execution) {
            if (execution.executionId === first.execution.executionId) {
              firstStarted();
              await firstBlocked;
            } else {
              secondStarted();
            }
            store.failExecution(execution.executionId, "terminal", new Date().toISOString(), 1);
          }
        }],
        ["result", new ResultHandler(store)]
      ]),
      deliveryHandler: new DeliveryHandler({ store, adapters: new Map() })
    });

    cycle.poll(new Date(Date.now() + 1_000).toISOString());
    await observedFirst;
    const second = store.appendEvent({
      type: "agent.request", source: { kind: "cli" }, agentId: "agent-2", prompt: "second",
      maxAttempts: 1
    });
    cycle.poll(new Date(Date.now() + 2_000).toISOString());
    await observedSecond;

    assert.equal(store.execution(first.execution.executionId)?.status, "running");
    assert.equal(store.execution(second.execution.executionId)?.status, "failed");
    releaseFirst();
    const settled = await cycle.settle();
    assert.deepEqual(new Set(settled.executions), new Set([
      first.execution.executionId,
      second.execution.executionId
    ]));
  } finally {
    store.close();
  }
});

test("RuntimeCycle shortens the fallback wait to the next durable due time", () => {
  const store = runtimeStore();
  try {
    const at = "2026-09-07T00:00:00.000Z";
    store.appendEvent({
      type: "agent.request",
      source: { kind: "cli" },
      agentId: "agent-1",
      prompt: "run when due",
      createdAt: "2026-09-07T00:00:00.250Z"
    });
    const cycle = runtimeCycle(store, {
      async invoke() {
        return { providerSessionId: "unused", outcome: { kind: "silent" } };
      }
    });
    assert.equal(cycle.nextWaitMilliseconds(1_000, at), 250);
    assert.equal(cycle.nextWaitMilliseconds(100, at), 100);
  } finally {
    store.close();
  }
});

test("RuntimeCycle admits two independent cold Sessions for the same Agent", async () => {
  const store = runtimeStore();
  try {
    let active = 0;
    let maximum = 0;
    const cycle = runtimeCycle(store, {
      async invoke(input) {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return {
          providerSessionId: `provider-${input.event.eventId}`,
          outcome: { kind: "message", body: "done" }
        };
      }
    });
    store.appendEvent({
      type: "agent.request", source: { kind: "cli" }, agentId: "agent-1", prompt: "first"
    });
    store.appendEvent({
      type: "agent.request", source: { kind: "cli" }, agentId: "agent-1", prompt: "second"
    });

    assert.deepEqual((await cycle.run()).failures, []);

    assert.equal(maximum, 2);
  } finally {
    store.close();
  }
});

test("RuntimeCycle leaves Handler completion time live unless a test pins it", async () => {
  const store = runtimeStore();
  try {
    let observedAt: string | undefined = "not-called";
    const cycle = new RuntimeCycle({
      store,
      handlers: new Map<RuntimeHandlerKind, RuntimeEventHandler>([
        ["agent", {
          kind: "agent" as const,
          handle(execution, at) {
            observedAt = at;
            store.failExecution(
              execution.executionId,
              "terminal fixture",
              new Date().toISOString(),
              1
            );
          }
        }],
        ["result", new ResultHandler(store)]
      ]),
      deliveryHandler: new DeliveryHandler({ store, adapters: new Map() })
    });
    store.appendEvent({
      type: "agent.request",
      source: { kind: "cli" },
      agentId: "agent-1",
      prompt: "live timestamp",
      maxAttempts: 1
    });

    await cycle.run();

    assert.equal(observedAt, undefined);
  } finally {
    store.close();
  }
});

test("terminal ResultHandler failure does not recursively create result Events", async () => {
  const store = runtimeStore();
  try {
    const agent: RuntimeAgentAdapter = {
      adapterId: "fake-agent-v1",
      workspace: "/workspace",
      async invoke() {
        return {
          providerSessionId: "provider-session-result-failure",
          outcome: { kind: "message", body: "done" }
        };
      }
    };
    const cycle = new RuntimeCycle({
      store,
      handlers: new Map<RuntimeHandlerKind, RuntimeEventHandler>([
        ["agent", new AgentHandler({ store, adapters: new Map([["agent-1", agent]]) })],
        ["result", {
          kind: "result",
          handle() {
            throw new Error("result handling unavailable");
          }
        }]
      ]),
      deliveryHandler: new DeliveryHandler({ store, adapters: new Map() })
    });
    store.appendEvent({
      type: "agent.request",
      source: { kind: "cli" },
      agentId: "agent-1",
      prompt: "produce one result",
      createdAt: "2026-07-23T05:00:00.000Z"
    });

    await cycle.run("2026-07-23T05:00:00.000Z");
    await cycle.run("2026-07-23T05:00:01.000Z");
    await cycle.run("2026-07-23T05:00:03.000Z");

    const resultEvents = store.events().filter((event) => event.type === "agent.result");
    assert.equal(resultEvents.length, 1);
    const resultExecution = store.executionForEvent(resultEvents[0]!.eventId);
    assert.equal(resultExecution?.handler, "result");
    assert.equal(resultExecution?.status, "failed");
    assert.equal(resultExecution?.attemptCount, 3);
  } finally {
    store.close();
  }
});

test("macOS notification is a one-attempt Delivery and cannot change callback outcome", async () => {
  const store = runtimeStore();
  try {
    const destination = store.putDestination({
      kind: "macos-notification",
      address: {
        title: "Pipeline complete",
        subscriptionId: "sub_fixture"
      }
    });
    const agent: RuntimeAgentAdapter = {
      adapterId: "fake-agent-v1",
      workspace: "/workspace",
      async invoke() {
        return {
          providerSessionId: "provider-notification-failure",
          outcome: { kind: "message", body: "callback persisted" }
        };
      }
    };
    const cycle = new RuntimeCycle({
      store,
      handlers: new Map<RuntimeHandlerKind, RuntimeEventHandler>([
        ["agent", new AgentHandler({
          store,
          adapters: new Map([["agent-1", agent]])
        })],
        ["result", new ResultHandler(store)]
      ]),
      deliveryHandler: new DeliveryHandler({
        store,
        adapters: new Map([[
          "macos-notification",
          new MacOsNotificationAdapter(async () => {
            throw new Error("notification permission denied");
          })
        ]])
      })
    });
    const request = store.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "notification-isolation" },
      agentId: "agent-1",
      prompt: "persist callback",
      destinationIds: [destination.destinationId]
    });

    const cycleResult = await cycle.run();
    assert.deepEqual(cycleResult.failures, []);
    assert.equal(store.execution(request.execution.executionId)?.status, "succeeded");
    const result = store.audit(request.event.eventId)?.resultEvent;
    assert.equal(result?.outcome, "succeeded");
    assert.equal(result?.output, "callback persisted");
    const delivery = store.deliveriesForResultEvent(result!.eventId)[0];
    assert.equal(delivery?.status, "failed");
    assert.equal(delivery?.attemptCount, 1);
    assert.equal(delivery?.maxAttempts, 1);
    assert.match(delivery?.lastError ?? "", /notification permission denied/);
  } finally {
    store.close();
  }
});

test("runtime recovery never retries an interrupted one-attempt notification", () => {
  const store = runtimeStore();
  try {
    const destination = store.putDestination({
      kind: "macos-notification",
      address: { title: "Recovered", subscriptionId: "sub_recovered" }
    });
    store.appendEvent({
      type: "agent.request",
      source: { kind: "cli" },
      agentId: "agent-1",
      prompt: "create result",
      destinationIds: [destination.destinationId]
    });
    const agentExecution = store.claimDueExecutions()[0]!;
    const result = store.completeExecution(agentExecution.executionId, {
      adapterId: "fake-agent-v1",
      workspace: "/workspace",
      providerSessionId: "provider-recovery",
      output: "persisted"
    });
    assert.equal(result?.type, "agent.result");
    const resultExecution = store.claimDueExecutions().find(
      (execution) => execution.handler === "result"
    )!;
    store.completeResultExecution(resultExecution.executionId);
    const claimed = store.claimDueDeliveries()[0]!;
    assert.equal(claimed.status, "delivering");
    assert.equal(claimed.attemptCount, 1);

    assert.equal(store.reconcileInterrupted(), 1);
    assert.equal(store.delivery(claimed.deliveryId)?.status, "failed");
    assert.deepEqual(store.claimDueDeliveries(), []);
  } finally {
    store.close();
  }
});

test("runtime recovery terminalizes interrupted Agent invocation as unknown without replay", () => {
  const store = runtimeStore();
  try {
    const request = store.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "interrupted-agent-unknown" },
      agentId: "agent-1",
      prompt: "possibly wrote through a provider tool",
      maxAttempts: 3
    });
    const running = store.claimDueExecutions()[0]!;
    assert.equal(running.attemptCount, 1);
    assert.equal(running.maxAttempts, 3);

    assert.equal(store.reconcileInterrupted("2026-08-13T04:10:00.000Z"), 1);

    const recovered = store.execution(running.executionId)!;
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.lastError, "runtime_interrupted_unknown");
    const result = store.audit(request.event.eventId)?.resultEvent;
    assert.equal(result?.outcome, "failed");
    assert.equal(result?.error, "runtime_interrupted_unknown");
    assert.deepEqual(store.claimDueExecutions().map(({ handler }) => handler), ["result"]);
  } finally {
    store.close();
  }
});

function runtimeStore(): RuntimeStore {
  const directory = temporaryDirectory("rollerskate-runtime-core-");
  return new RuntimeStore(join(directory, "runtime.db"));
}

function runtimeCycle(
  store: RuntimeStore,
  agentOverride: Pick<RuntimeAgentAdapter, "invoke">,
  destinationOverride?: Pick<RuntimeDestinationAdapter, "deliver">,
  retryBaseMilliseconds?: number
): RuntimeCycle {
  const agent: RuntimeAgentAdapter = {
    adapterId: "fake-agent-v1",
    workspace: "/workspace",
    ...agentOverride
  };
  const destinations = new Map<RuntimeDestination["kind"], RuntimeDestinationAdapter>();
  if (destinationOverride !== undefined) {
    destinations.set("matrix", { kind: "matrix", ...destinationOverride });
  }
  return new RuntimeCycle({
    store,
    handlers: new Map<RuntimeHandlerKind, RuntimeEventHandler>([
      ["agent", new AgentHandler({
        store,
        adapters: new Map([["agent-1", agent]]),
        ...(retryBaseMilliseconds === undefined ? {} : { retryBaseMilliseconds })
      })],
      ["result", new ResultHandler(store)]
    ]),
    deliveryHandler: new DeliveryHandler({ store, adapters: destinations })
  });
}
