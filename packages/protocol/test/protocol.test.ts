import assert from "node:assert/strict";
import test from "node:test";

import {
  agentCreateRequestSchema,
  credentialMetadataSchema,
  eventEnvelopeSchema,
  matrixApplicationServiceTransactionSchema,
  roomMessageSendRequestSchema,
  roomCursorSchema,
  placementSchema
} from "../src/index.js";

const occurredAt = "2026-07-19T01:00:00.000Z";

test("event envelope keeps transport facts inside adapter metadata", () => {
  const event = eventEnvelopeSchema.parse({
    protocolVersion: 1,
    eventId: "event-1",
    type: "room.message.received",
    occurredAt,
    source: { kind: "human", id: "human-1" },
    payload: { body: "hello" },
    adapter: {
      transport: "matrix",
      metadata: { eventId: "$matrix-event", relationType: "m.thread" }
    }
  });

  assert.equal(event.type, "room.message.received");
  assert.equal(event.adapter?.transport, "matrix");
});

test("credential metadata rejects secret material", () => {
  assert.throws(() => credentialMetadataSchema.parse({
    id: "credential-1",
    principal: { kind: "agent", id: "agent-1" },
    status: "active",
    createdAt: occurredAt,
    secret: "must-not-cross-the-protocol"
  }));
});

test("placement generation is positive", () => {
  assert.throws(() => placementSchema.parse({
    id: "placement-1",
    agentId: "agent-1",
    deviceId: "device-1",
    state: "pending",
    generation: 0,
    createdAt: occurredAt
  }));
});

test("Agent names are stable filesystem-safe identifiers", () => {
  assert.equal(agentCreateRequestSchema.parse({
    name: "alice-2",
    verifierChallenge: "a".repeat(43)
  }).name, "alice-2");
  for (const name of ["Alice", "alice_b", "../alice", "alice/bob", "-alice"]) {
    assert.throws(() => agentCreateRequestSchema.parse({
      name,
      verifierChallenge: "a".repeat(43)
    }));
  }
});

test("Room cursors and Matrix transactions have strict bounded contracts", () => {
  assert.equal(roomCursorSchema.parse("r1.WyJyb29tLTEiLDFd"), "r1.WyJyb29tLTEiLDFd");
  assert.throws(() => roomCursorSchema.parse("s123_opaque"));

  const transaction = matrixApplicationServiceTransactionSchema.parse({
    events: [{
      event_id: "$event-1",
      room_id: "!room:example.com",
      sender: "@human:example.com",
      type: "m.room.message",
      origin_server_ts: 1,
      content: { msgtype: "m.text", body: "hello" }
    }]
  });
  assert.equal(transaction.events.length, 1);
  assert.throws(() => matrixApplicationServiceTransactionSchema.parse({
    events: [],
    access_token: "must-not-be-accepted"
  }));
});

test("Room replies carry bounded causal-chain metadata", () => {
  const request = roomMessageSendRequestSchema.parse({
    transactionId: "reply-1",
    body: "hello",
    causalChainId: "chain-1",
    causalHop: 8
  });
  assert.equal(request.causalHop, 8);
  assert.throws(() => roomMessageSendRequestSchema.parse({
    transactionId: "reply-2",
    body: "hello",
    causalChainId: "chain-1",
    causalHop: 0
  }));
});
