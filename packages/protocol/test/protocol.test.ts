import assert from "node:assert/strict";
import test from "node:test";

import {
  agentCreateRequestSchema,
  agentWorkRequestCreateSchema,
  agentWorkRequestDecisionReceiptSchema,
  agentWorkRequestResultSchema,
  agentWorkRequestSchema,
  connectorDescriptionSchema,
  connectorObserveRequestSchema,
  credentialMetadataSchema,
  eventEnvelopeSchema,
  integrationBindingCreateRequestSchema,
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

test("Connector contracts are strict, bounded, and secret-opaque", () => {
  const integration = integrationBindingCreateRequestSchema.parse({
    connectorId: "vikunja",
    connectorVersion: "1",
    placement: "runtime",
    endpointRef: "http://127.0.0.1:3456",
    profileIds: ["playground@1"],
    externalScopeRef: "project:7",
    credentialRef: "credential:vikunja-local"
  });
  assert.equal(integration.credentialRef, "credential:vikunja-local");
  assert.throws(() => integrationBindingCreateRequestSchema.parse({
    ...integration,
    credential: "secret-must-not-cross"
  }));

  const description = connectorDescriptionSchema.parse({
    schemaVersion: "ConnectorDescription@1",
    connectorId: "vikunja",
    connectorVersion: "1",
    profiles: [{
      profileId: "playground@1",
      readSchemaRefs: ["work-item.read@1"]
    }]
  });
  assert.equal(description.profiles[0]?.profileId, "playground@1");
  assert.equal(connectorObserveRequestSchema.parse({
    schemaVersion: "ConnectorObserveRequest@1",
    integrationBindingId: "integration-1",
    limit: 100
  }).limit, 100);
});

test("Agent work requests require exact bounded admission and public results", () => {
  const create = agentWorkRequestCreateSchema.parse({
    schemaVersion: "AgentWorkRequestCreate@1",
    requestId: "request-1",
    targetAgentId: "agent-1",
    objective: "Perform bounded work",
    contextRefs: [],
    workflowRef: "forum@1",
    requestedBudget: { maxSteps: 4, maxDepth: 1 },
    requestedGrantRefs: ["context-read"],
    resultRoute: "requester-bounded@1",
    expiresAt: occurredAt
  });
  assert.equal(create.workflowRef, "forum@1");
  assert.throws(() => agentWorkRequestCreateSchema.parse({
    ...create,
    credential: "must-not-cross-the-protocol"
  }));
  assert.throws(() => agentWorkRequestCreateSchema.parse({
    ...create,
    objective: "x".repeat(16_385)
  }));

  const accepted = agentWorkRequestDecisionReceiptSchema.parse({
    schemaVersion: "AgentWorkRequestDecisionReceipt@1",
    decision: "accepted",
    policyRevision: 1,
    statusReason: "owner-explicit-acceptance",
    admittedWorkflowRef: "forum@1",
    admittedBudget: { maxSteps: 4, maxDepth: 1 },
    admittedGrantRefs: [],
    decidedAt: occurredAt
  });
  assert.equal(accepted.decision, "accepted");
  assert.throws(() => agentWorkRequestDecisionReceiptSchema.parse({
    ...accepted,
    admittedBudget: undefined
  }));
  assert.throws(() => agentWorkRequestDecisionReceiptSchema.parse({
    ...accepted,
    decision: "rejected"
  }));

  assert.equal(agentWorkRequestResultSchema.parse({
    schemaVersion: "AgentWorkRequestResult@1",
    outcome: "succeeded",
    summary: "Public bounded summary",
    resultRefs: [],
    completedAt: occurredAt
  }).outcome, "succeeded");
  assert.throws(() => agentWorkRequestResultSchema.parse({
    schemaVersion: "AgentWorkRequestResult@1",
    outcome: "succeeded",
    summary: "x".repeat(4_097),
    resultRefs: [],
    completedAt: occurredAt
  }));
  assert.throws(() => agentWorkRequestSchema.parse({
    schemaVersion: "AgentWorkRequest@1",
    workRequestId: "work-request-1",
    requestId: create.requestId,
    requesterRef: { kind: "human", id: "human-1" },
    targetAgentRef: { kind: "agent", id: create.targetAgentId },
    objective: create.objective,
    contextRefs: [],
    workflowRef: create.workflowRef,
    requestedBudget: create.requestedBudget,
    requestedGrantRefs: create.requestedGrantRefs,
    resultRoute: create.resultRoute,
    expiresAt: create.expiresAt,
    status: "accepted",
    revision: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt
  }));
});
