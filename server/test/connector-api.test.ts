import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import type { OidcProvider } from "../src/adapter/oidc/client.js";
import { MemoryConnectorRepository } from
  "../src/adapter/persistence/memory/connector-repository.js";
import { MemoryRepository } from "../src/adapter/persistence/memory/repository.js";
import { createBffServer } from "../src/bootstrap/http-server.js";
import { ConnectorService } from "../src/modules/connector/service.js";
import { createVerifier } from "../src/modules/shared/opaque-credential.js";
import { createTestServices } from "./support/services.js";

const ISSUER = "https://identity.example.com";
const oidc: OidcProvider = {
  authorizationUrl: async () => "https://identity.example.com/authorize",
  exchangeAuthorizationCode: async () => ({
    issuer: ISSUER, subject: "unused", displayName: "Unused", metadata: {}
  }),
  beginDeviceAuthorization: async () => { throw new Error("not used"); },
  pollDeviceAuthorization: async () => { throw new Error("not used"); }
};

test("Integration binding HTTP API exposes only owner-scoped create, read, and CAS update", async () => {
  const repository = new MemoryRepository();
  const services = createTestServices(repository, {
    issuer: ISSUER,
    publicUrl: "http://127.0.0.1"
  }, oidc);
  const deviceCredential = await issueDevice(services);
  const connectors = new ConnectorService(new MemoryConnectorRepository());
  const server = createBffServer({ ...services, oidc, connectors });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    const base = `http://127.0.0.1:${address.port}`;
    const requestHeaders = headers(deviceCredential);
    const createdResponse = await fetch(`${base}/api/integration-bindings`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({
        connectorId: "vikunja",
        connectorVersion: "1",
        placement: "runtime",
        endpointRef: "http://127.0.0.1:3456",
        profileIds: ["playground@1"],
        externalScopeRef: "project:7",
        credentialRef: "credential:vikunja-local"
      })
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { bindingId: string; revision: number };

    const fetched = await fetch(`${base}/api/integration-bindings/${created.bindingId}`, {
      headers: requestHeaders
    });
    assert.equal(fetched.status, 200);
    assert.equal((await fetched.json() as { revision: number }).revision, 1);
    const stale = await fetch(`${base}/api/integration-bindings/${created.bindingId}`, {
      method: "PATCH",
      headers: requestHeaders,
      body: JSON.stringify({ expectedRevision: 2, status: "suspended" })
    });
    assert.equal(stale.status, 409);
    const updated = await fetch(`${base}/api/integration-bindings/${created.bindingId}`, {
      method: "PATCH",
      headers: requestHeaders,
      body: JSON.stringify({ expectedRevision: 1, cursor: "cursor-http" })
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json() as { cursor: string }).cursor, "cursor-http");
    assert.equal((await fetch(
      `${base}/api/integration-bindings/${created.bindingId}`
    )).status, 401);
  } finally {
    server.close();
    await once(server, "close");
  }
});

async function issueDevice(
  services: ReturnType<typeof createTestServices>
): Promise<string> {
  const authorization = await services.trust.beginAuthorization("/");
  const human = await services.trust.completeAuthorization(
    await services.trust.takeAuthorization(authorization.state),
    { issuer: ISSUER, subject: "connector-api", displayName: "Connector API", metadata: {} }
  );
  const proof = createVerifier();
  const pairing = await services.devices.createPairing({
    deviceId: "connector-api-device",
    deviceName: "Connector API Device",
    verifierChallenge: proof.challenge
  });
  await services.devices.approvePairing(pairing.pairingId, human.human);
  return (await services.devices.redeemPairing(
    pairing.pairingId,
    "connector-api-device",
    proof.verifier
  )).credential;
}

function headers(credential: string): Record<string, string> {
  return {
    authorization: `Bearer ${credential}`,
    "content-type": "application/json"
  };
}
