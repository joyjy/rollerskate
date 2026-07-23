import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createBffServer } from "../src/bootstrap/http-server.js";
import { MemoryRepository } from "../src/adapter/persistence/memory/repository.js";
import { createVerifier } from "../src/modules/shared/opaque-credential.js";
import type { OidcProvider } from "../src/adapter/oidc/client.js";
import { createTestServices } from "./support/services.js";

test("HTTP workflow claims the first admin, pairs and revokes a Device", async () => {
  const repository = new MemoryRepository();
  let publicUrl = "http://127.0.0.1";
  const oidc: OidcProvider = {
    authorizationUrl: async (input) =>
      `https://identity.example.com/authorize?state=${encodeURIComponent(input.state)}`,
    exchangeAuthorizationCode: async (input) => ({
      issuer: "https://identity.example.com",
      subject: input.code,
      displayName: `Human ${input.code}`,
      metadata: {}
    }),
    beginDeviceAuthorization: async () => ({
      deviceCode: "device-code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://identity.example.com/device",
      expiresInSeconds: 600,
      pollIntervalSeconds: 1
    }),
    pollDeviceAuthorization: async () => ({
      status: "complete",
      identity: {
        issuer: "https://identity.example.com",
        subject: "admin",
        displayName: "Human admin",
        metadata: {}
      }
    })
  };
  let services = createTestServices(repository, {
    issuer: "https://identity.example.com",
    publicUrl
  }, oidc);
  const server = createBffServer({ ...services, oidc });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    publicUrl = `http://127.0.0.1:${address.port}`;
    services = createTestServices(repository, {
      issuer: "https://identity.example.com",
      publicUrl
    }, oidc);
    // Recreate the listener with the final public URL used for same-origin checks.
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error === undefined ? resolve() : reject(error)));
    const app = createBffServer({ ...services, oidc });
    app.listen(address.port, "127.0.0.1");
    await once(app, "listening");
    try {
      const proof = createVerifier();
      const pairingResponse = await fetch(`${publicUrl}/api/device-pairings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: "http-device",
          deviceName: "HTTP Test Device",
          verifierChallenge: proof.challenge
        })
      });
      assert.equal(pairingResponse.status, 201);
      const pairing = await pairingResponse.json() as {
        pairingId: string;
        verificationUri: string;
        userCode: string;
      };
      assert.equal(pairing.verificationUri, "https://identity.example.com/device");
      assert.equal(pairing.userCode, "ABCD-EFGH");
      const pairingStatus = await fetch(
        `${publicUrl}/api/device-pairings/${pairing.pairingId}`
      );
      assert.equal(pairingStatus.status, 200);
      assert.equal(
        (await pairingStatus.json() as { status: string }).status,
        "approved"
      );
      const redeem = await fetch(
        `${publicUrl}/api/device-pairings/${pairing.pairingId}/redeem`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceId: "http-device", verifier: proof.verifier })
        }
      );
      assert.equal(redeem.status, 200);
      const issuance = await redeem.json() as { credential: string };
      assert.ok(issuance.credential.length > 32);

      const status = await fetch(`${publicUrl}/api/device`, {
        headers: { authorization: `Bearer ${issuance.credential}` }
      });
      assert.equal(status.status, 200);
      assert.equal((await status.json() as { id: string }).id, "http-device");

      const allow = await fetch(`${publicUrl}/api/admin/allowlist`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${issuance.credential}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ subject: "admitted-by-device" })
      });
      assert.equal(allow.status, 201);

      const agentProof = createVerifier();
      const createAgent = await fetch(`${publicUrl}/api/agents`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${issuance.credential}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: "http-agent",
          verifierChallenge: agentProof.challenge
        })
      });
      assert.equal(createAgent.status, 201);
      const createdAgent = await createAgent.json() as {
        agent: { id: string };
        enrollment: { id: string };
      };
      const redeemAgent = await fetch(
        `${publicUrl}/api/agent-enrollments/${createdAgent.enrollment.id}/redeem`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${issuance.credential}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({ verifier: agentProof.verifier })
        }
      );
      assert.equal(redeemAgent.status, 200);
      const agentIssuance = await redeemAgent.json() as { credential: string };
      const agentStatus = await fetch(
        `${publicUrl}/api/agent-principals/${createdAgent.agent.id}`,
        { headers: { authorization: `Bearer ${agentIssuance.credential}` } }
      );
      assert.equal(agentStatus.status, 200);
      const agents = await fetch(`${publicUrl}/api/agents`, {
        headers: { authorization: `Bearer ${issuance.credential}` }
      });
      assert.deepEqual(
        (await agents.json() as readonly { name: string }[]).map((agent) => agent.name),
        ["http-agent"]
      );
      const revoke = await fetch(`${publicUrl}/api/device`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${issuance.credential}` }
      });
      assert.equal(revoke.status, 204);
      const stale = await fetch(`${publicUrl}/api/device`, {
        headers: { authorization: `Bearer ${issuance.credential}` }
      });
      assert.equal(stale.status, 401);
    } finally {
      app.close();
      await once(app, "close");
    }
  } finally {
    if (server.listening) {
      server.close();
      await once(server, "close");
    }
  }
});
