import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository } from "../src/adapter/persistence/memory/repository.js";
import { MemoryWorkRequestRepository } from
  "../src/adapter/persistence/memory/work-request-repository.js";
import type { AgentWorkRequestRecord } from "../src/modules/work-request/model.js";
import { WorkRequestRouteRegistry } from "../src/modules/work-request/route-registry.js";
import type { AgentAuthenticationRecord } from "../src/modules/agent/model.js";
import type { DeviceAuthenticationRecord } from "../src/modules/device/model.js";
import { ServerError } from "../src/modules/shared/error.js";
import { createVerifier } from "../src/modules/shared/opaque-credential.js";
import { WorkRequestService } from "../src/modules/work-request/service.js";
import { createTestServices } from "./support/services.js";

const ISSUER = "https://identity.example.com";

test("Agent work requests route only online and preserve target admission authority", async () => {
  const repository = new MemoryRepository();
  let current = new Date("2026-08-13T08:00:00.000Z");
  const services = createTestServices(repository, {
    issuer: ISSUER,
    publicUrl: "https://rollerskate.example.com",
    now: () => current
  });
  const alice = await identity(repository, services, "request-alice");
  await services.trust.allowSubject(alice.device.human, "request-bob");
  const bob = await identity(repository, services, "request-bob");
  const requests = new WorkRequestService(
    new MemoryWorkRequestRepository(),
    repository,
    undefined,
    { now: () => current }
  );

  const unavailable = await requests.create(
    { kind: "human", id: alice.device.human.id },
    createInput("unavailable", bob.agentId, "2026-08-13T08:10:00.000Z")
  );
  assert.equal(unavailable.request.status, "target-unavailable");

  requests.registerRoute(bob.agentId, {
    schemaVersion: "WorkRequestRouteLease@1",
    routeId: "route_bob_runtime_1",
    leaseMilliseconds: 60_000
  });
  const created = await requests.create(
    { kind: "human", id: alice.device.human.id },
    createInput("accepted", bob.agentId, "2026-08-13T08:10:00.000Z")
  );
  assert.equal(created.request.status, "received");
  assert.equal((await requests.create(
    { kind: "human", id: alice.device.human.id },
    createInput("accepted", bob.agentId, "2026-08-13T08:10:00.000Z")
  )).created, false);
  await expectError(() => requests.create(
    { kind: "human", id: alice.device.human.id },
    { ...createInput("accepted", bob.agentId, "2026-08-13T08:10:00.000Z"), objective: "changed" }
  ), "work_request_idempotency_conflict");
  assert.deepEqual(
    (await requests.routed(bob.agentId, "route_bob_runtime_1")).map(({ workRequestId }) =>
      workRequestId),
    [created.request.workRequestId]
  );

  await expectError(() => requests.decide(bob.agentId, created.request.workRequestId, {
    schemaVersion: "AgentWorkRequestDecision@1",
    expectedRevision: 1,
    receipt: acceptedReceipt({ admittedGrantRefs: ["grant_not_requested"] })
  }), "work_request_grant_expansion");
  const accepted = await requests.decide(bob.agentId, created.request.workRequestId, {
    schemaVersion: "AgentWorkRequestDecision@1",
    expectedRevision: 1,
    receipt: acceptedReceipt()
  });
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(
    (await requests.acceptedWithoutRun(bob.agentId)).map(({ workRequestId }) => workRequestId),
    [accepted.workRequestId]
  );
  const attached = await requests.attachRun(bob.agentId, accepted.workRequestId, {
    schemaVersion: "AgentWorkRequestRunAttach@1",
    expectedRevision: 2,
    receipt: {
      schemaVersion: "AgentWorkRequestRunReceipt@1",
      runId: "run_work_request_1",
      admittedAt: current.toISOString()
    }
  });
  assert.equal(attached.runReceipt?.runId, "run_work_request_1");
  assert.deepEqual(await requests.acceptedWithoutRun(bob.agentId), []);
  const completed = await requests.complete(bob.agentId, accepted.workRequestId, {
    schemaVersion: "AgentWorkRequestResultSubmit@1",
    expectedRevision: 3,
    result: {
      schemaVersion: "AgentWorkRequestResult@1",
      outcome: "succeeded",
      summary: "Bounded public result",
      resultRefs: [],
      completedAt: current.toISOString()
    }
  });
  assert.equal(completed.status, "completed");
  assert.equal((await requests.get(
    { kind: "human", id: alice.device.human.id },
    completed.workRequestId
  )).result?.summary, "Bounded public result");
  await expectError(() => requests.get(
    { kind: "human", id: "another-human" },
    completed.workRequestId
  ), "work_request_not_found");

  const withdrawable = await requests.create(
    { kind: "agent", id: alice.agentId },
    createInput("withdraw", bob.agentId, "2026-08-13T08:10:00.000Z")
  );
  assert.equal((await requests.withdraw(
    { kind: "agent", id: alice.agentId },
    withdrawable.request.workRequestId,
    { schemaVersion: "AgentWorkRequestWithdraw@1", expectedRevision: 1 }
  )).status, "withdrawn");

  const oldRoute = await requests.create(
    { kind: "human", id: alice.device.human.id },
    createInput("old-route", bob.agentId, "2026-08-13T08:10:00.000Z")
  );
  requests.registerRoute(bob.agentId, {
    schemaVersion: "WorkRequestRouteLease@1",
    routeId: "route_bob_runtime_2",
    leaseMilliseconds: 60_000
  });
  assert.deepEqual(await requests.routed(bob.agentId, "route_bob_runtime_2"), []);
  assert.equal((await requests.get(
    { kind: "human", id: alice.device.human.id },
    oldRoute.request.workRequestId
  )).status, "received");

  const expiring = await requests.create(
    { kind: "human", id: alice.device.human.id },
    createInput("expire", bob.agentId, "2026-08-13T08:00:30.000Z")
  );
  current = new Date("2026-08-13T08:00:31.000Z");
  assert.deepEqual(await requests.routed(bob.agentId, "route_bob_runtime_2"), []);
  assert.equal((await requests.get(
    { kind: "human", id: alice.device.human.id },
    expiring.request.workRequestId
  )).status, "expired");
});

test("expired pending rows release quota and a route change during create fails closed", async () => {
  const repository = new MemoryRepository();
  let current = new Date("2026-08-13T08:00:00.000Z");
  const services = createTestServices(repository, {
    issuer: ISSUER,
    publicUrl: "https://rollerskate.example.com",
    now: () => current
  });
  const alice = await identity(repository, services, "quota-alice");
  await services.trust.allowSubject(alice.device.human, "quota-bob");
  const bob = await identity(repository, services, "quota-bob");
  const requests = new WorkRequestService(
    new MemoryWorkRequestRepository(),
    repository,
    undefined,
    { now: () => current }
  );
  requests.registerRoute(bob.agentId, {
    schemaVersion: "WorkRequestRouteLease@1",
    routeId: "route_quota",
    leaseMilliseconds: 60_000
  });
  for (let index = 0; index < 32; index += 1) {
    assert.equal((await requests.create(
      { kind: "human", id: alice.device.human.id },
      createInput(`quota-${index}`, bob.agentId, "2026-08-13T08:00:30.000Z")
    )).request.status, "received");
  }
  await expectError(() => requests.create(
    { kind: "human", id: alice.device.human.id },
    createInput("quota-blocked", bob.agentId, "2026-08-13T08:10:00.000Z")
  ), "work_request_pending_limit");
  current = new Date("2026-08-13T08:00:31.000Z");
  assert.equal((await requests.create(
    { kind: "human", id: alice.device.human.id },
    createInput("quota-released", bob.agentId, "2026-08-13T08:10:00.000Z")
  )).request.status, "received");
  await expectError(() => requests.create(
    { kind: "human", id: alice.device.human.id },
    {
      ...createInput("past-deadline", bob.agentId, "2026-08-13T08:10:00.000Z"),
      deadlineAt: "2026-08-13T08:00:30.000Z"
    }
  ), "work_request_deadline_invalid");

  const routes = new WorkRequestRouteRegistry();
  routes.register(bob.agentId, "route_before_create", 60_000, current);
  const racing = new WorkRequestService(
    new RouteReplacingRepository(() => {
      routes.register(bob.agentId, "route_after_create", 60_000, current);
    }),
    repository,
    routes,
    { now: () => current }
  );
  const raced = await racing.create(
    { kind: "human", id: alice.device.human.id },
    createInput("route-race", bob.agentId, "2026-08-13T08:10:00.000Z")
  );
  assert.equal(raced.request.status, "target-unavailable");
  assert.equal(raced.request.statusReason, "target-runtime-route-changed");
  assert.deepEqual(await racing.routed(bob.agentId, "route_after_create"), []);
});

class RouteReplacingRepository extends MemoryWorkRequestRepository {
  readonly #replace: () => void;

  public constructor(replace: () => void) {
    super();
    this.#replace = replace;
  }

  public override async createWorkRequest(
    record: AgentWorkRequestRecord,
    maximumPendingForRequester: number
  ) {
    const outcome = await super.createWorkRequest(record, maximumPendingForRequester);
    this.#replace();
    return outcome;
  }
}

function createInput(requestId: string, targetAgentId: string, expiresAt: string) {
  return {
    schemaVersion: "AgentWorkRequestCreate@1" as const,
    requestId,
    targetAgentId,
    objective: "Review the bounded request",
    contextRefs: [],
    workflowRef: "forum@1" as const,
    requestedBudget: { maxSteps: 4, maxDepth: 1 },
    requestedGrantRefs: ["grant_read_context"],
    resultRoute: "requester-bounded@1" as const,
    expiresAt
  };
}

function acceptedReceipt(
  options: { readonly admittedGrantRefs?: readonly string[] } = {}
) {
  return {
    schemaVersion: "AgentWorkRequestDecisionReceipt@1" as const,
    decision: "accepted" as const,
    policyRevision: 1,
    statusReason: "standing-policy-match",
    admittedWorkflowRef: "forum@1" as const,
    admittedBudget: { maxSteps: 4, maxDepth: 1 },
    admittedGrantRefs: [...(options.admittedGrantRefs ?? ["grant_read_context"])],
    decidedAt: "2026-08-13T08:00:00.000Z"
  };
}

async function identity(
  repository: MemoryRepository,
  services: ReturnType<typeof createTestServices>,
  subject: string
): Promise<{
  readonly device: DeviceAuthenticationRecord;
  readonly agentId: string;
  readonly authentication: AgentAuthenticationRecord;
}> {
  const authorization = await services.trust.beginAuthorization("/");
  const human = await services.trust.completeAuthorization(
    await services.trust.takeAuthorization(authorization.state),
    { issuer: ISSUER, subject, displayName: subject, metadata: {} }
  );
  const deviceProof = createVerifier();
  const pairing = await services.devices.createPairing({
    deviceId: `device-${subject}`,
    deviceName: `${subject} device`,
    verifierChallenge: deviceProof.challenge
  });
  await services.devices.approvePairing(pairing.pairingId, human.human);
  const issuance = await services.devices.redeemPairing(
    pairing.pairingId,
    `device-${subject}`,
    deviceProof.verifier
  );
  const device = await services.devices.authenticateDevice(issuance.credential);
  const proof = createVerifier();
  const created = await services.agents.createAgent(device, {
    name: `${subject}-agent`,
    verifierChallenge: proof.challenge
  });
  const agentIssuance = await services.agents.redeemAgentEnrollment(
    device,
    created.enrollment.id,
    proof.verifier
  );
  const authentication = await services.agents.authenticateAgent(
    agentIssuance.credential,
    created.agent.id
  );
  assert.ok(await repository.getAgentAggregateById(authentication.agent.id));
  return { device, agentId: authentication.agent.id, authentication };
}

async function expectError(operation: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) =>
    error instanceof ServerError && error.code === code);
}
