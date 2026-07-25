import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RoomEventPage, RoomEventProjection, RoomHead } from "../src/protocol.js";
import {
  MatrixDeliveryAdapter,
  MatrixIngress,
  type MatrixHistory
} from "../src/integrations/matrix/runtime-adapter.js";
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

test.skip("v0.4 Matrix Room ingress binding persists cursor and Session", async () => {
  const database = join(mkdtempSync(join(tmpdir(), "rollerskate-matrix-destination-")), "runtime.db");
  const history = new MutableHistory();
  const ingress = new MatrixIngress({ databasePath: database, history });
  const destination = ingress.register({
    bindingId: "binding-1",
    agentId: "agent-1",
    agentName: "alice",
    roomId: "!room:example",
    ownerHumanId: "human-1",
    policy: { wakeMode: "mention_only", ownerMessageWake: "mention_only" }
  }, "2026-07-23T04:00:00.000Z");
  const sent: string[] = [];
  const matrixDelivery = new MatrixDeliveryAdapter({
    databasePath: database,
    publisher: {
      async send(input) {
        sent.push(input.transactionId);
        return { eventId: `$reply-${sent.length}` };
      }
    }
  });
  const store = new RuntimeStore(database);
  const providerSessions: Array<string | undefined> = [];
  const agent: RuntimeAgentAdapter = {
    adapterId: "fake-agent-v1",
    workspace: "/workspace",
    async invoke(input) {
      providerSessions.push(input.providerSessionId);
      return {
        providerSessionId: input.providerSessionId ?? "provider-session-1",
        outcome: { kind: "message", body: `reply ${providerSessions.length}` }
      };
    }
  };
  const cycle = new RuntimeCycle({
    store,
    handlers: new Map<RuntimeHandlerKind, RuntimeEventHandler>([
      ["agent", new AgentHandler({ store, adapters: new Map([["agent-1", agent]]) })],
      ["result", new ResultHandler(store)]
    ]),
    deliveryHandler: new DeliveryHandler({
      store,
      adapters: new Map([["matrix", matrixDelivery]])
    })
  });
  try {
    history.advance("h1", [projection("$one", "h1", "@alice first")]);
    const first = await ingress.runCycle("binding-1", "2026-07-23T04:00:01.000Z");
    assert.equal(first.destinationId, destination.destinationId);
    assert.equal(first.acceptedEventIds.length, 1);
    assert.equal(store.event(first.acceptedEventIds[0]!)?.sessionId, undefined);
    await cycle.run("2026-07-23T04:00:02.000Z");

    history.advance("h2", [projection("$two", "h2", "@alice second")]);
    const second = await ingress.runCycle("binding-1", "2026-07-23T04:00:03.000Z");
    const sessionId = store.sessions()[0]!.sessionId;
    assert.equal(store.event(second.acceptedEventIds[0]!)?.sessionId, sessionId);
    await cycle.run("2026-07-23T04:00:04.000Z");

    assert.deepEqual(providerSessions, [undefined, "provider-session-1"]);
    assert.equal(sent.length, 2);
    assert.equal(store.events().filter((event) => event.source.kind === "matrix").length, 2);
  } finally {
    matrixDelivery.close();
    ingress.close();
    store.close();
  }
});

class MutableHistory implements MatrixHistory {
  headValue = "h0";
  pageEvents: RoomEventProjection[] = [];

  advance(head: string, events: RoomEventProjection[]): void {
    this.headValue = head;
    this.pageEvents = events;
  }

  async head(roomId: string): Promise<RoomHead> {
    return { roomId, head: this.headValue };
  }

  async events(input: { roomId: string; through: string }): Promise<RoomEventPage> {
    return {
      roomId: input.roomId,
      through: input.through,
      events: this.pageEvents,
      complete: true
    };
  }
}

function projection(eventId: string, position: string, body: string): RoomEventProjection {
  return {
    roomId: "!room:example",
    position,
    event: {
      protocolVersion: 1,
      eventId,
      type: "m.room.message",
      occurredAt: "2026-07-23T04:00:00.000Z",
      source: { kind: "human", id: "human-1" },
      payload: { body }
    }
  };
}
