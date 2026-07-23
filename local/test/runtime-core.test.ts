import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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
        return { providerSessionId: "provider-session-1", output: "finished" };
      }
    }, {
      async deliver(input) {
        delivered.push(input.delivery.deliveryId);
        assert.equal(input.destination.address.roomId, "!room:example");
        assert.equal(input.resultEvent.output, "finished");
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
          output: "ok"
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

test("terminal ResultHandler failure does not recursively create result Events", async () => {
  const store = runtimeStore();
  try {
    const agent: RuntimeAgentAdapter = {
      adapterId: "fake-agent-v1",
      workspace: "/workspace",
      async invoke() {
        return { providerSessionId: "provider-session-result-failure", output: "done" };
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

function runtimeStore(): RuntimeStore {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-runtime-core-"));
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
