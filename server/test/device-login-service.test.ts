import assert from "node:assert/strict";
import test from "node:test";

import { DeviceLoginService } from "../src/application/device/login-service.js";
import { MemoryRepository } from "../src/adapter/persistence/memory/repository.js";
import type {
  DeviceAuthorizationPoll,
  DeviceOidcProvider
} from "../src/modules/trust/oidc.js";
import { TrustService } from "../src/modules/trust/service.js";
import { createVerifier } from "../src/modules/shared/opaque-credential.js";

test("Device login respects provider polling and atomically admits the Human", async () => {
  const repository = new MemoryRepository();
  let current = new Date("2026-07-22T10:00:00.000Z");
  const polls: DeviceAuthorizationPoll[] = [
    { status: "pending" },
    { status: "slow_down" },
    {
      status: "complete",
      identity: {
        issuer: "https://identity.example.com",
        subject: "first-device-human",
        displayName: "First Device Human",
        metadata: {}
      }
    }
  ];
  const oidc: DeviceOidcProvider = {
    beginDeviceAuthorization: async () => ({
      deviceCode: "provider-device-code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://identity.example.com/activate?user_code=ABCD-EFGH",
      expiresInSeconds: 600,
      pollIntervalSeconds: 1
    }),
    pollDeviceAuthorization: async () => polls.shift() ?? { status: "expired" }
  };
  const trust = new TrustService(repository, {
    issuer: "https://identity.example.com",
    publicUrl: "http://localhost:4100",
    now: () => current
  });
  const login = new DeviceLoginService(repository, trust, oidc, {
    now: () => current
  });
  const verifier = createVerifier();

  const started = await login.begin({
    deviceId: "device-id",
    deviceName: "Test Device",
    verifierChallenge: verifier.challenge
  });
  assert.equal(started.userCode, "ABCD-EFGH");
  assert.equal((await login.status(started.pairingId)).status, "pending");

  current = new Date(current.getTime() + 1_000);
  const slowed = await login.status(started.pairingId);
  assert.equal(slowed.status, "pending");
  assert.equal(slowed.pollIntervalMilliseconds, 6_000);

  current = new Date(current.getTime() + 5_000);
  assert.equal((await login.status(started.pairingId)).status, "pending");
  current = new Date(current.getTime() + 1_000);
  assert.equal((await login.status(started.pairingId)).status, "approved");

  const pairing = await repository.getPairing(started.pairingId, current.toISOString());
  assert.ok(pairing?.approvedHumanId !== undefined);
  const human = await repository.getHuman(pairing.approvedHumanId);
  assert.equal(human?.subject, "first-device-human");
  assert.equal(human?.isAdmin, true);
});
