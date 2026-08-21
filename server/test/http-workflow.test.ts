import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createBffServer } from "../src/bootstrap/http-server.js";
import { MemoryRepository } from "../src/adapter/persistence/memory/repository.js";
import { MemoryProfileTopicRepository } from "../src/adapter/persistence/memory/profile-topic-repository.js";
import { ProfileTopicService } from "../src/modules/profile-topic/service.js";
import { createVerifier } from "../src/modules/shared/opaque-credential.js";
import type { OidcProvider } from "../src/adapter/oidc/client.js";
import { createTestServices } from "./support/services.js";

test("HTTP workflow claims the first admin, pairs and revokes a Device", async () => {
  const repository = new MemoryRepository();
  const profileRepository = new MemoryProfileTopicRepository();
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
    beginDeviceAuthorization: async () => {
      throw new Error("browser pairing must not start Device Authorization");
    },
    pollDeviceAuthorization: async () => {
      throw new Error("browser pairing must not poll Device Authorization");
    }
  };
  let services = createTestServices(repository, {
    issuer: "https://identity.example.com",
    publicUrl
  }, oidc);
  let profiles = new ProfileTopicService(profileRepository, repository);
  const server = createBffServer({ ...services, oidc, profiles });
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
    profiles = new ProfileTopicService(profileRepository, repository);
    // Recreate the listener with the final public URL used for same-origin checks.
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error === undefined ? resolve() : reject(error)));
    const app = createBffServer({ ...services, oidc, profiles });
    app.listen(address.port, "127.0.0.1");
    await once(app, "listening");
    try {
      const proof = createVerifier();
      const pairingResponse = await fetch(`${publicUrl}/api/device-pairings/browser`, {
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
      };
      assert.equal(
        pairing.verificationUri,
        `${publicUrl}/device/pair/${encodeURIComponent(pairing.pairingId)}`
      );

      const pairingPageRedirect = await fetch(pairing.verificationUri, {
        redirect: "manual"
      });
      assert.equal(pairingPageRedirect.status, 302);
      const loginPath = pairingPageRedirect.headers.get("location");
      if (loginPath === null) throw new Error("pairing redirect is missing");
      assert.ok(loginPath.startsWith("/auth/login?returnTo="));
      const providerRedirect = await fetch(new URL(loginPath, publicUrl), {
        redirect: "manual"
      });
      assert.equal(providerRedirect.status, 302);
      const providerUrl = new URL(providerRedirect.headers.get("location") ?? "");
      assert.equal(providerUrl.origin, "https://identity.example.com");
      const state = providerUrl.searchParams.get("state");
      if (state === null) throw new Error("OIDC authorization state is missing");
      const callback = await fetch(
        `${publicUrl}/auth/callback?state=${encodeURIComponent(state)}&code=admin`,
        { redirect: "manual" }
      );
      assert.equal(callback.status, 302);
      assert.equal(callback.headers.get("location"), new URL(loginPath, publicUrl)
        .searchParams.get("returnTo"));
      const sessionCookie = callback.headers.get("set-cookie")?.split(";", 1)[0];
      if (sessionCookie === undefined) throw new Error("session cookie is missing");
      assert.ok(sessionCookie.startsWith("rs_session="));
      const approvalPage = await fetch(pairing.verificationUri, {
        headers: { cookie: sessionCookie }
      });
      assert.equal(approvalPage.status, 200);
      const approvalHtml = await approvalPage.text();
      assert.match(approvalHtml, /Approve device/);
      assert.match(approvalHtml, /Sign in again/);
      assert.match(
        approvalHtml,
        /\/auth\/login\?returnTo=%2Fdevice%2Fpair%2F/
      );
      const approval = await fetch(pairing.verificationUri, {
        method: "POST",
        headers: { cookie: sessionCookie, origin: publicUrl }
      });
      assert.equal(approval.status, 200);
      const approvalCsp = approval.headers.get("content-security-policy") ?? "";
      const approvalBody = await approval.text();
      const cspNonce = /script-src 'nonce-([^']+)'/u.exec(approvalCsp)?.[1];
      const bodyNonce = /<script nonce="([^"]+)">window\.close\(\);<\/script>/u
        .exec(approvalBody)?.[1];
      assert.ok(cspNonce);
      assert.equal(bodyNonce, cspNonce);
      assert.match(approvalBody, /Device approved\. You can close this tab\./u);

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
      const device = await status.json() as {
        id: string;
        human: { id: string; displayName: string };
      };
      assert.equal(device.id, "http-device");

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
      const profile = await fetch(
        `${publicUrl}/api/agents/${createdAgent.agent.id}/profile`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${issuance.credential}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            displayName: "HTTP Agent",
            role: "Test participant",
            disclosure: "Automated test Agent.",
            expressionRules: ["Label generated output."],
            expectedRevision: 0
          })
        }
      );
      assert.equal(profile.status, 200);
      assert.equal((await profile.json() as { revision: number }).revision, 1);
      const createTopic = await fetch(`${publicUrl}/api/topics`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${issuance.credential}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: "HTTP Topic",
          visibility: "public",
          profile: {
            purpose: "Exercise the native Topic API.",
            participationRules: ["Disclose automation."],
            expressionRules: ["Stay within the Topic purpose."]
          }
        })
      });
      assert.equal(createTopic.status, 201);
      const topic = await createTopic.json() as { id: string; profile: { revision: number } };
      assert.equal(topic.profile.revision, 1);
      const listTopics = await fetch(`${publicUrl}/api/topics`, {
        headers: { authorization: `Bearer ${issuance.credential}` }
      });
      assert.equal(listTopics.status, 200);
      assert.deepEqual(
        (await listTopics.json() as readonly { id: string }[]).map((item) => item.id),
        [topic.id]
      );
      const join = await fetch(`${publicUrl}/api/topics/${topic.id}/memberships`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${issuance.credential}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ agentId: createdAgent.agent.id })
      });
      assert.equal(join.status, 200);
      assert.equal((await join.json() as { membership: { status: string } }).membership.status,
        "active");
      const runtimeTopics = await fetch(`${publicUrl}/api/runtime-topics`, {
        headers: { authorization: `Bearer ${issuance.credential}` }
      });
      assert.equal(runtimeTopics.status, 200);
      assert.deepEqual(
        (await runtimeTopics.json() as readonly { agentIds: readonly string[] }[])[0]?.agentIds,
        [createdAgent.agent.id]
      );
      const publish = await fetch(`${publicUrl}/api/topics/${topic.id}/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${agentIssuance.credential}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          transactionId: "http-topic-event-1",
          body: "Native Topic event"
        })
      });
      assert.equal(publish.status, 201);
      const published = await publish.json() as {
        eventId: string;
        sequence: number;
        agentProfileRevision: number;
        topicProfileRevision: number;
      };
      assert.equal(published.sequence, 1);
      assert.equal(published.agentProfileRevision, 1);
      assert.equal(published.topicProfileRevision, 1);
      const humanPublish = await fetch(
        `${publicUrl}/api/topics/${topic.id}/human-events`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${issuance.credential}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            transactionId: "http-human-topic-event-1",
            body: "Human Topic event"
          })
        }
      );
      assert.equal(humanPublish.status, 201);
      const humanEvent = await humanPublish.json() as {
        eventId: string;
        sequence: number;
        publisher: { kind: string; humanId: string; displayName: string; deviceId: string };
      };
      assert.equal(humanEvent.sequence, 2);
      assert.deepEqual(humanEvent.publisher, {
        kind: "human",
        humanId: device.human.id,
        displayName: device.human.displayName,
        deviceId: device.id
      });
      const topicEvents = await fetch(`${publicUrl}/api/runtime-topics/${topic.id}/events`, {
        headers: { authorization: `Bearer ${issuance.credential}` }
      });
      assert.equal(topicEvents.status, 200);
      assert.deepEqual(
        (await topicEvents.json() as { events: readonly { eventId: string }[] }).events
          .map((event) => event.eventId),
        [published.eventId, humanEvent.eventId]
      );
      const acknowledge = await fetch(`${publicUrl}/api/runtime-topics/${topic.id}/cursor`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${issuance.credential}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ cursor: published.sequence })
      });
      assert.equal(acknowledge.status, 200);
      assert.equal((await acknowledge.json() as { cursor: number }).cursor, 1);
      const reconnected = await fetch(`${publicUrl}/api/runtime-topics/${topic.id}/events`, {
        headers: { authorization: `Bearer ${issuance.credential}` }
      });
      assert.deepEqual(
        (await reconnected.json() as { events: readonly { eventId: string }[] }).events
          .map((event) => event.eventId),
        [humanEvent.eventId]
      );
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
