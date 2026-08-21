import assert from "node:assert/strict";
import test from "node:test";

import { MemoryProfileTopicRepository } from "../src/adapter/persistence/memory/profile-topic-repository.js";
import { MemoryRepository } from "../src/adapter/persistence/memory/repository.js";
import type { DeviceAuthenticationRecord } from "../src/modules/device/model.js";
import type { AgentAuthenticationRecord } from "../src/modules/agent/model.js";
import { ProfileTopicService } from "../src/modules/profile-topic/service.js";
import { ServerError } from "../src/modules/shared/error.js";
import { createVerifier } from "../src/modules/shared/opaque-credential.js";
import { createTestServices } from "./support/services.js";

const NOW = "2026-07-27T12:00:00.000Z";
const ISSUER = "https://identity.example.com";

test("Agent and Topic profiles enforce owner authority, CAS and public reads", async () => {
  const repository = new MemoryRepository();
  const profileRepository = new MemoryProfileTopicRepository();
  const services = createTestServices(repository, {
    issuer: ISSUER,
    publicUrl: "https://rollerskate.example.com",
    now: () => new Date(NOW)
  });
  const alice = await humanDeviceAgent(repository, services, "alice");
  await services.trust.allowSubject(alice.device.human, "bob");
  const bob = await humanDeviceAgent(repository, services, "bob");
  const profiles = new ProfileTopicService(profileRepository, repository, {
    now: () => new Date(NOW)
  });

  const aliceProfile = await profiles.updateAgentProfile(alice.device, alice.agentId, {
    displayName: "Alice Researcher",
    role: "Independent research agent",
    disclosure: "AI agent operated by Alice.",
    expressionRules: ["Separate evidence from inference.", "Do not speak for the owner."],
    expectedRevision: 0
  });
  assert.equal(aliceProfile.revision, 1);
  assert.deepEqual(await profiles.getAgentProfile(bob.device, alice.agentId), aliceProfile);
  await expectError(() => profiles.updateAgentProfile(bob.device, alice.agentId, {
    displayName: "Hijacked",
    role: "Other",
    disclosure: "Other",
    expressionRules: [],
    expectedRevision: 1
  }), "forbidden");
  await expectError(() => profiles.updateAgentProfile(alice.device, alice.agentId, {
    displayName: "Stale",
    role: "Stale",
    disclosure: "Stale",
    expressionRules: [],
    expectedRevision: 0
  }), "profile_revision_conflict");

  const topic = await profiles.createTopic(alice.device, {
    name: "Experimental agents",
    visibility: "public",
    profile: {
      purpose: "Run bounded public experiments.",
      participationRules: ["Disclose automated participation."],
      expressionRules: ["No unverifiable claims."]
    }
  });
  assert.deepEqual(await profiles.listTopics(alice.device), [topic]);
  assert.deepEqual(await profiles.listTopics(bob.device), []);
  assert.equal((await profiles.getTopic(bob.device, topic.id)).profile.revision, 1);
  const revised = await profiles.updateTopicProfile(alice.device, topic.id, {
    purpose: "Run bounded public experiments and publish evidence.",
    participationRules: ["Disclose automated participation."],
    expressionRules: ["No unverifiable claims.", "Label uncertainty."],
    expectedRevision: 1
  });
  assert.equal(revised.revision, 2);
  await expectError(() => profiles.updateTopicProfile(bob.device, topic.id, {
    purpose: "Changed",
    participationRules: [],
    expressionRules: [],
    expectedRevision: 2
  }), "forbidden");

  const membership = await profiles.joinTopic(alice.device, topic.id, alice.agentId);
  const replay = await profiles.joinTopic(alice.device, topic.id, alice.agentId);
  assert.deepEqual(replay, membership);
  await expectError(
    () => profiles.joinTopic(alice.device, topic.id, bob.agentId),
    "forbidden"
  );
});

test("native Topic fanout shares one Runtime subscription and preserves event snapshots", async () => {
  const repository = new MemoryRepository();
  const profileRepository = new MemoryProfileTopicRepository();
  const services = createTestServices(repository, {
    issuer: ISSUER,
    publicUrl: "https://rollerskate.example.com",
    now: () => new Date(NOW)
  });
  const alice = await humanDeviceAgent(repository, services, "fanout-alice");
  const secondAgent = await createAgent(services, alice.device, "fanout-alice-second");
  const profiles = new ProfileTopicService(profileRepository, repository, {
    now: () => new Date(NOW)
  });
  for (const agent of [alice.authentication, secondAgent]) {
    await profiles.updateAgentProfile(alice.device, agent.agent.id, {
      displayName: agent.agent.name,
      role: "Independent participant",
      disclosure: "Automated Agent",
      expressionRules: ["Separate evidence from inference."],
      expectedRevision: 0
    });
  }
  const topic = await profiles.createTopic(alice.device, {
    name: "Native fanout",
    visibility: "public",
    profile: {
      purpose: "Exercise native Topic delivery.",
      participationRules: ["Use a disclosed Agent profile."],
      expressionRules: ["Label uncertainty."]
    }
  });
  const firstJoin = await profiles.joinTopic(alice.device, topic.id, alice.agentId);
  const secondJoin = await profiles.joinTopic(alice.device, topic.id, secondAgent.agent.id);
  assert.deepEqual(secondJoin.subscription, firstJoin.subscription);
  assert.deepEqual(await profiles.runtimeTopics(alice.device), [{
    subscription: firstJoin.subscription,
    agentIds: [alice.agentId, secondAgent.agent.id].sort()
  }]);

  const first = await profiles.publish(alice.authentication, topic.id, {
    transactionId: "fanout-transaction-1",
    body: "First durable event"
  });
  const duplicate = await profiles.publish(alice.authentication, topic.id, {
    transactionId: "fanout-transaction-1",
    body: "This duplicate body must not replace history"
  });
  assert.deepEqual(duplicate, first);
  assert.equal(first.agentProfileRevision, 1);
  assert.equal(first.topicProfileRevision, 1);
  assert.deepEqual(first.publisher, {
    kind: "agent",
    agentId: alice.authentication.agent.id,
    agentName: alice.authentication.agent.name,
    ownerHumanId: alice.authentication.owner.id,
    ownerDisplayName: alice.authentication.owner.displayName,
    deviceId: alice.authentication.placement.deviceId
  });
  const human = await profiles.publishHuman(alice.device, topic.id, {
    transactionId: "fanout-transaction-1",
    body: "Human-authored durable event"
  });
  assert.equal(human.sequence, 2);
  assert.deepEqual(human.publisher, {
    kind: "human",
    humanId: alice.device.human.id,
    displayName: alice.device.human.displayName,
    deviceId: alice.device.device.id
  });
  assert.equal("agentProfileRevision" in human, false);

  await profiles.updateAgentProfile(alice.device, alice.agentId, {
    displayName: "Revised participant",
    role: "Independent participant",
    disclosure: "Automated Agent",
    expressionRules: ["Separate evidence from inference.", "Cite sources."],
    expectedRevision: 1
  });
  await profiles.updateTopicProfile(alice.device, topic.id, {
    purpose: "Exercise native Topic delivery after revision.",
    participationRules: ["Use a disclosed Agent profile."],
    expressionRules: ["Label uncertainty.", "Do not impersonate humans."],
    expectedRevision: 1
  });
  const second = await profiles.publish(alice.authentication, topic.id, {
    transactionId: "fanout-transaction-2",
    body: "Second durable event"
  });
  assert.equal(second.agentProfileRevision, 2);
  assert.equal(second.topicProfileRevision, 2);

  const delivered = await profiles.events(alice.device, topic.id, 0, 100);
  assert.deepEqual(delivered.events, [first, human, second]);
  assert.equal(delivered.events.filter((event) => event.eventId === first.eventId).length, 1);
  await assert.rejects(
    () => profiles.acknowledgeEvents(alice.device, topic.id, delivered.head + 1),
    (error: unknown) => error instanceof ServerError && error.code === "topic_cursor_ahead"
  );
  const cursor = await profiles.acknowledgeEvents(alice.device, topic.id, first.sequence);
  assert.equal(cursor.cursor, first.sequence);
  const reconnected = await profiles.events(alice.device, topic.id, 0, 100);
  assert.deepEqual(reconnected.events, [human, second]);

  const outsider = await createAgent(services, alice.device, "fanout-outsider");
  await profiles.updateAgentProfile(alice.device, outsider.agent.id, {
    displayName: "Outsider",
    role: "Observer",
    disclosure: "Automated Agent",
    expressionRules: [],
    expectedRevision: 0
  });
  await expectError(() => profiles.publish(outsider, topic.id, {
    transactionId: "unauthorized-transaction",
    body: "Must not publish"
  }), "topic_membership_required");
});

async function humanDeviceAgent(
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
  const deviceIssuance = await services.devices.redeemPairing(
    pairing.pairingId,
    `device-${subject}`,
    deviceProof.verifier
  );
  const device = await services.devices.authenticateDevice(deviceIssuance.credential);
  const authentication = await createAgent(services, device, `${subject}-agent`);
  assert.ok(await repository.getAgentAggregateById(authentication.agent.id));
  return { device, agentId: authentication.agent.id, authentication };
}

async function createAgent(
  services: ReturnType<typeof createTestServices>,
  device: DeviceAuthenticationRecord,
  name: string
): Promise<AgentAuthenticationRecord> {
  const proof = createVerifier();
  const created = await services.agents.createAgent(device, {
    name,
    verifierChallenge: proof.challenge
  });
  const issuance = await services.agents.redeemAgentEnrollment(
    device,
    created.enrollment.id,
    proof.verifier
  );
  return services.agents.authenticateAgent(issuance.credential, created.agent.id);
}

async function expectError(operation: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) =>
    error instanceof ServerError && error.code === code);
}
