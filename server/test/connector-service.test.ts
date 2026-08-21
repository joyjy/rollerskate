import assert from "node:assert/strict";
import test from "node:test";

import { MemoryConnectorRepository } from
  "../src/adapter/persistence/memory/connector-repository.js";
import { MemoryRepository } from "../src/adapter/persistence/memory/repository.js";
import type { DeviceAuthenticationRecord } from "../src/modules/device/model.js";
import { ConnectorService } from "../src/modules/connector/service.js";
import { ServerError } from "../src/modules/shared/error.js";
import { createVerifier } from "../src/modules/shared/opaque-credential.js";
import { createTestServices } from "./support/services.js";

const NOW = "2026-08-18T08:00:00.000Z";
const ISSUER = "https://identity.example.com";

test("Integration bindings enforce owner isolation, unique profiles, and revision CAS", async () => {
  const repository = new MemoryRepository();
  const services = createTestServices(repository, {
    issuer: ISSUER,
    publicUrl: "https://rollerskate.example.com",
    now: () => new Date(NOW)
  });
  const alice = await issueDevice(services, "connector-alice");
  await services.trust.allowSubject(alice.human, "connector-bob");
  const bob = await issueDevice(services, "connector-bob");
  const connectors = new ConnectorService(new MemoryConnectorRepository(), {
    now: () => new Date(NOW)
  });

  await expectError(() => connectors.createIntegrationBinding(alice, {
    ...integrationInput(),
    profileIds: ["playground@1", "playground@1"]
  }), "invalid_request");
  const integration = await connectors.createIntegrationBinding(alice, integrationInput());
  assert.equal(integration.revision, 1);
  assert.equal(
    (await connectors.getIntegrationBinding(alice, integration.bindingId)).bindingId,
    integration.bindingId
  );
  await expectError(
    () => connectors.getIntegrationBinding(bob, integration.bindingId),
    "integration_binding_not_found"
  );
  await expectError(() => connectors.updateIntegrationBinding(alice, integration.bindingId, {
    expectedRevision: 2,
    status: "suspended"
  }), "integration_revision_conflict");

  const suspended = await connectors.updateIntegrationBinding(alice, integration.bindingId, {
    expectedRevision: 1,
    cursor: "cursor-1",
    status: "suspended"
  });
  assert.equal(suspended.revision, 2);
  assert.equal(suspended.cursor, "cursor-1");
  assert.equal(suspended.status, "suspended");
  const cleared = await connectors.updateIntegrationBinding(alice, integration.bindingId, {
    expectedRevision: 2,
    cursor: null
  });
  assert.equal(cleared.revision, 3);
  assert.equal(cleared.cursor, undefined);
});

function integrationInput() {
  return {
    connectorId: "vikunja",
    connectorVersion: "1",
    placement: "runtime" as const,
    endpointRef: "http://127.0.0.1:3456",
    profileIds: ["playground@1"],
    externalScopeRef: "project:7",
    credentialRef: "credential:vikunja-local"
  };
}

async function issueDevice(
  services: ReturnType<typeof createTestServices>,
  subject: string
): Promise<DeviceAuthenticationRecord> {
  const authorization = await services.trust.beginAuthorization("/");
  const human = await services.trust.completeAuthorization(
    await services.trust.takeAuthorization(authorization.state),
    { issuer: ISSUER, subject, displayName: subject, metadata: {} }
  );
  const proof = createVerifier();
  const pairing = await services.devices.createPairing({
    deviceId: `device-${subject}`,
    deviceName: `${subject} device`,
    verifierChallenge: proof.challenge
  });
  await services.devices.approvePairing(pairing.pairingId, human.human);
  const issuance = await services.devices.redeemPairing(
    pairing.pairingId,
    `device-${subject}`,
    proof.verifier
  );
  return services.devices.authenticateDevice(issuance.credential);
}

async function expectError(operation: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) =>
    error instanceof ServerError && error.code === code);
}
