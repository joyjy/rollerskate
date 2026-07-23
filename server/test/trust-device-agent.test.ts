import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository } from "../src/adapter/persistence/memory/repository.js";
import type { OidcIdentity } from "../src/application/model.js";
import { ServerError } from "../src/modules/shared/error.js";
import { createVerifier } from "../src/modules/shared/opaque-credential.js";
import { createTestServices, type TestServices } from "./support/services.js";

const ISSUER = "https://identity.example.com";
const NOW = "2026-07-19T08:00:00.000Z";

function identity(subject: string): OidcIdentity {
  return {
    issuer: ISSUER,
    subject,
    displayName: `Human ${subject}`,
    metadata: { email: `${subject}@example.com` }
  };
}

function service(repository = new MemoryRepository()): {
  readonly repository: MemoryRepository;
  readonly services: TestServices;
} {
  return {
    repository,
    services: createTestServices(repository, {
      issuer: ISSUER,
      publicUrl: "https://rollerskate.example.com",
      now: () => new Date(NOW)
    })
  };
}

async function expectServerError(
  operation: () => Promise<unknown>,
  code: string
): Promise<void> {
  await assert.rejects(operation, (error: unknown) =>
    error instanceof ServerError && error.code === code
  );
}

test("OIDC state is single-use and unadmitted identities are denied after bootstrap", async () => {
  const { services } = service();
  const bootstrapAuthorization = await services.trust.beginAuthorization("/");
  await services.trust.completeAuthorization(
    await services.trust.takeAuthorization(bootstrapAuthorization.state),
    identity("admin")
  );
  const authorization = await services.trust.beginAuthorization("/device/pair/example");
  const transaction = await services.trust.takeAuthorization(authorization.state);

  assert.equal(transaction.nonce, authorization.nonce);
  await expectServerError(
    () => services.trust.takeAuthorization(authorization.state),
    "invalid_authorization_state"
  );
  await expectServerError(
    () => services.trust.completeAuthorization(transaction, identity("outsider")),
    "admission_denied"
  );
  await expectServerError(
    () => services.trust.beginAuthorization("https://attacker.example.com"),
    "invalid_return_to"
  );
});

test("first OIDC login claims admin and pairing resists replay and substitution", async () => {
  const { services } = service();
  const adminAuthorization = await services.trust.beginAuthorization("/");
  const admin = await services.trust.completeAuthorization(
    await services.trust.takeAuthorization(adminAuthorization.state),
    identity("admin")
  );
  assert.equal(admin.human.isAdmin, true);
  assert.equal(
    (await services.trust.authenticateSession(admin.sessionToken)).id,
    admin.human.id
  );

  await services.trust.allowSubject(admin.human, "member");
  const memberAuthorization = await services.trust.beginAuthorization("/");
  const member = await services.trust.completeAuthorization(
    await services.trust.takeAuthorization(memberAuthorization.state),
    identity("member")
  );
  assert.equal(member.human.isAdmin, false);

  const proof = createVerifier();
  const pairing = await services.devices.createPairing({
    deviceId: "device-a",
    deviceName: "Developer Laptop",
    verifierChallenge: proof.challenge
  });
  await services.devices.approvePairing(pairing.pairingId, member.human);

  await expectServerError(
    () => services.devices.redeemPairing(pairing.pairingId, "device-b", proof.verifier),
    "pairing_device_mismatch"
  );
  await expectServerError(
    () => services.devices.redeemPairing(pairing.pairingId, "device-a", `${proof.verifier}x`),
    "pairing_verifier_mismatch"
  );

  const issuance = await services.devices.redeemPairing(
    pairing.pairingId,
    "device-a",
    proof.verifier
  );
  assert.equal(issuance.device.id, "device-a");
  assert.equal(issuance.device.human.id, member.human.id);
  await expectServerError(
    () => services.devices.redeemPairing(pairing.pairingId, "device-a", proof.verifier),
    "pairing_already_redeemed"
  );

  const replacementProof = createVerifier();
  const replacement = await services.devices.createPairing({
    deviceId: "device-a",
    deviceName: "Replacement Name",
    verifierChallenge: replacementProof.challenge
  });
  await services.devices.approvePairing(replacement.pairingId, member.human);
  await expectServerError(
    () => services.devices.redeemPairing(
      replacement.pairingId,
      "device-a",
      replacementProof.verifier
    ),
    "pairing_device_exists"
  );

  const authentication = await services.devices.authenticateDevice(issuance.credential);
  assert.equal(services.devices.deviceSummary(authentication).name, "Developer Laptop");
  await services.devices.revokeDevice(authentication);
  await expectServerError(
    () => services.devices.authenticateDevice(issuance.credential),
    "unauthorized"
  );
});

test("only one concurrent first OIDC login can claim admin", async () => {
  const { services } = service();
  const firstAuthorization = await services.trust.beginAuthorization("/");
  const secondAuthorization = await services.trust.beginAuthorization("/");
  const outcomes = await Promise.allSettled([
    services.trust.completeAuthorization(
      await services.trust.takeAuthorization(firstAuthorization.state),
      identity("first")
    ),
    services.trust.completeAuthorization(
      await services.trust.takeAuthorization(secondAuthorization.state),
      identity("second")
    )
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  const completion = outcomes.find((outcome) => outcome.status === "fulfilled");
  assert.equal(completion?.value.human.isAdmin, true);
});

test("non-admin Humans cannot change admission", async () => {
  const { services } = service();
  const adminAuthorization = await services.trust.beginAuthorization("/");
  const admin = await services.trust.completeAuthorization(
    await services.trust.takeAuthorization(adminAuthorization.state),
    identity("admin")
  );
  await services.trust.allowSubject(admin.human, "member");
  const authorization = await services.trust.beginAuthorization("/");
  const member = await services.trust.completeAuthorization(
    await services.trust.takeAuthorization(authorization.state),
    identity("member")
  );

  await expectServerError(
    () => services.trust.allowSubject(member.human, "another"),
    "forbidden"
  );
});

test("one Device enrolls isolated Agents with replay-safe credentials", async () => {
  const { services } = service();
  const authorization = await services.trust.beginAuthorization("/");
  const human = await services.trust.completeAuthorization(
    await services.trust.takeAuthorization(authorization.state),
    identity("admin")
  );
  const deviceProof = createVerifier();
  const pairing = await services.devices.createPairing({
    deviceId: "agent-device",
    deviceName: "Agent Device",
    verifierChallenge: deviceProof.challenge
  });
  await services.devices.approvePairing(pairing.pairingId, human.human);
  const deviceIssuance = await services.devices.redeemPairing(
    pairing.pairingId,
    "agent-device",
    deviceProof.verifier
  );
  const device = await services.devices.authenticateDevice(deviceIssuance.credential);

  const aliceProof = createVerifier();
  const alice = await services.agents.createAgent(device, {
    name: "alice",
    verifierChallenge: aliceProof.challenge
  });
  const otherDeviceProof = createVerifier();
  const otherPairing = await services.devices.createPairing({
    deviceId: "other-agent-device",
    deviceName: "Other Agent Device",
    verifierChallenge: otherDeviceProof.challenge
  });
  await services.devices.approvePairing(otherPairing.pairingId, human.human);
  const otherDeviceIssuance = await services.devices.redeemPairing(
    otherPairing.pairingId,
    "other-agent-device",
    otherDeviceProof.verifier
  );
  const otherDevice = await services.devices.authenticateDevice(otherDeviceIssuance.credential);
  await expectServerError(
    () => services.agents.redeemAgentEnrollment(
      otherDevice,
      alice.enrollment.id,
      aliceProof.verifier
    ),
    "enrollment_device_mismatch"
  );
  await expectServerError(
    () => services.agents.redeemAgentEnrollment(
      device,
      alice.enrollment.id,
      `${aliceProof.verifier}x`
    ),
    "enrollment_verifier_mismatch"
  );
  const aliceCredential = await services.agents.redeemAgentEnrollment(
    device,
    alice.enrollment.id,
    aliceProof.verifier
  );
  const replay = await services.agents.redeemAgentEnrollment(
    device,
    alice.enrollment.id,
    aliceProof.verifier
  );
  assert.equal(replay.credential, aliceCredential.credential);

  const bobProof = createVerifier();
  const bob = await services.agents.createAgent(device, {
    name: "bob",
    verifierChallenge: bobProof.challenge
  });
  const bobCredential = await services.agents.redeemAgentEnrollment(
    device,
    bob.enrollment.id,
    bobProof.verifier
  );

  assert.notEqual(alice.agent.id, bob.agent.id);
  assert.notEqual(aliceCredential.credentialId, bobCredential.credentialId);
  assert.deepEqual((await services.agents.listAgents(device)).map((agent) => agent.name), [
    "alice",
    "bob"
  ]);
  await expectServerError(
    () => services.agents.authenticateAgent(aliceCredential.credential, bob.agent.id),
    "agent_credential_mismatch"
  );
  assert.equal(
    (await services.agents.authenticateAgent(
      bobCredential.credential,
      bob.agent.id
    )).agent.name,
    "bob"
  );
});
