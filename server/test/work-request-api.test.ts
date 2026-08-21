import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import type { OidcProvider } from "../src/adapter/oidc/client.js";
import { MemoryRepository } from "../src/adapter/persistence/memory/repository.js";
import { MemoryWorkRequestRepository } from
  "../src/adapter/persistence/memory/work-request-repository.js";
import { createBffServer } from "../src/bootstrap/http-server.js";
import { createVerifier } from "../src/modules/shared/opaque-credential.js";
import { WorkRequestService } from "../src/modules/work-request/service.js";
import { createTestServices } from "./support/services.js";

const ISSUER = "https://identity.example.com";
const NOW = "2026-08-13T09:00:00.000Z";
const oidc: OidcProvider = {
  authorizationUrl: async () => "https://identity.example.com/authorize",
  exchangeAuthorizationCode: async () => ({
    issuer: ISSUER, subject: "unused", displayName: "Unused", metadata: {}
  }),
  beginDeviceAuthorization: async () => { throw new Error("not used"); },
  pollDeviceAuthorization: async () => { throw new Error("not used"); }
};

test("Work request HTTP routes separate requester and target credentials", async () => {
  const repository = new MemoryRepository();
  const services = createTestServices(repository, {
    issuer: ISSUER,
    publicUrl: "http://127.0.0.1",
    now: () => new Date(NOW)
  }, oidc);
  const identity = await issueIdentity(services);
  const workRequests = new WorkRequestService(
    new MemoryWorkRequestRepository(),
    repository,
    undefined,
    { now: () => new Date(NOW) }
  );
  const server = createBffServer({ ...services, oidc, workRequests });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    const base = `http://127.0.0.1:${address.port}`;
    const targetBase = `${base}/api/agent-principals/${identity.agentId}`;
    const targetHeaders = headers(identity.agentCredential);
    assert.equal((await fetch(`${targetBase}/work-request-route`, {
      method: "PUT",
      headers: targetHeaders,
      body: JSON.stringify({
        schemaVersion: "WorkRequestRouteLease@1",
        routeId: "route_http_target",
        leaseMilliseconds: 60_000
      })
    })).status, 200);

    const createResponse = await fetch(`${base}/api/work-requests`, {
      method: "POST",
      headers: headers(identity.deviceCredential),
      body: JSON.stringify({
        schemaVersion: "AgentWorkRequestCreate@1",
        requestId: "http-request-1",
        targetAgentId: identity.agentId,
        objective: "Perform bounded work",
        contextRefs: [],
        workflowRef: "forum@1",
        requestedBudget: { maxSteps: 3, maxDepth: 1 },
        requestedGrantRefs: [],
        resultRoute: "requester-bounded@1",
        expiresAt: "2026-08-13T10:00:00.000Z"
      })
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json() as {
      request: { workRequestId: string; revision: number; status: string };
    };
    assert.equal(created.request.status, "received");

    const routed = await fetch(
      `${targetBase}/work-requests?routeId=route_http_target`,
      { headers: targetHeaders }
    );
    assert.equal(routed.status, 200);
    assert.equal((await routed.json() as unknown[]).length, 1);

    const decision = await fetch(
      `${targetBase}/work-requests/${created.request.workRequestId}/decision`,
      {
        method: "PUT",
        headers: targetHeaders,
        body: JSON.stringify({
          schemaVersion: "AgentWorkRequestDecision@1",
          expectedRevision: 1,
          receipt: {
            schemaVersion: "AgentWorkRequestDecisionReceipt@1",
            decision: "rejected",
            policyRevision: 1,
            statusReason: "owner-policy-denied",
            decidedAt: NOW
          }
        })
      }
    );
    assert.equal(decision.status, 200);
    assert.equal((await decision.json() as { status: string }).status, "rejected");

    const requesterView = await fetch(
      `${base}/api/work-requests/${created.request.workRequestId}`,
      { headers: headers(identity.deviceCredential) }
    );
    assert.equal(requesterView.status, 200);
    assert.equal((await requesterView.json() as { status: string }).status, "rejected");
    assert.equal((await fetch(
      `${targetBase}/work-requests?routeId=route_http_target`,
      { headers: headers(identity.deviceCredential) }
    )).status, 401);
  } finally {
    server.close();
    await once(server, "close");
  }
});

async function issueIdentity(services: ReturnType<typeof createTestServices>): Promise<{
  readonly deviceCredential: string;
  readonly agentId: string;
  readonly agentCredential: string;
}> {
  const authorization = await services.trust.beginAuthorization("/");
  const human = await services.trust.completeAuthorization(
    await services.trust.takeAuthorization(authorization.state),
    { issuer: ISSUER, subject: "work-api", displayName: "Work API", metadata: {} }
  );
  const deviceProof = createVerifier();
  const pairing = await services.devices.createPairing({
    deviceId: "work-api-device",
    deviceName: "Work API Device",
    verifierChallenge: deviceProof.challenge
  });
  await services.devices.approvePairing(pairing.pairingId, human.human);
  const device = await services.devices.redeemPairing(
    pairing.pairingId,
    "work-api-device",
    deviceProof.verifier
  );
  const authentication = await services.devices.authenticateDevice(device.credential);
  const agentProof = createVerifier();
  const created = await services.agents.createAgent(authentication, {
    name: "work-api-agent",
    verifierChallenge: agentProof.challenge
  });
  const agent = await services.agents.redeemAgentEnrollment(
    authentication,
    created.enrollment.id,
    agentProof.verifier
  );
  return {
    deviceCredential: device.credential,
    agentId: created.agent.id,
    agentCredential: agent.credential
  };
}

function headers(credential: string): Record<string, string> {
  return {
    authorization: `Bearer ${credential}`,
    "content-type": "application/json"
  };
}
