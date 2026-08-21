import assert from "node:assert/strict";
import test from "node:test";

import type { RowDataPacket } from "mysql2/promise";

import { connectMysql, connectMysqlPool } from "../src/adapter/persistence/mysql/connection.js";
import { MysqlConnectorRepository } from
  "../src/adapter/persistence/mysql/connector-repository.js";
import { migrateServerDatabase, readMigrations } from "../src/adapter/persistence/mysql/migrations.js";
import { MysqlRepository } from "../src/adapter/persistence/mysql/repository.js";
import { MysqlWorkRequestRepository } from
  "../src/adapter/persistence/mysql/work-request-repository.js";
import { ConnectorService } from "../src/modules/connector/service.js";
import { WorkRequestService } from "../src/modules/work-request/service.js";
import { createVerifier } from "../src/modules/shared/opaque-credential.js";
import { createTestServices } from "./support/services.js";

test("migration SQL avoids PostgreSQL-only constructs", async () => {
  const migrations = await readMigrations();
  assert.deepEqual(migrations.map((migration) => migration.version), [
    "0001_control_plane",
    "0002_human_device_login",
    "0003_agent_enrollment",
    "0004_room_control_plane",
    "0005_first_login_bootstrap",
    "0006_oidc_device_authorization",
    "0007_profiled_topics",
    "0008_native_topic_fanout",
    "0009_owner_scoped_agent_names",
    "0010_human_topic_publishers",
    "0011_project_connector_runtime",
    "0012_agent_work_requests"
  ]);
  const sql = migrations.map((migration) => migration.sql).join("\n");
  for (const unsupported of [
    /\bJSONB\b/i,
    /\bSERIAL\b/i,
    /\bRETURNING\b/i,
    /::[a-z]/i,
    /\bGENERATED\s+ALWAYS\b/i
  ]) {
    assert.doesNotMatch(sql, unsupported);
  }
});

test("migrations apply idempotently to MySQL 8", {
  skip: process.env.ROLLERSKATE_MYSQL_TEST_URL === undefined
}, async () => {
  const databaseUrl = process.env.ROLLERSKATE_MYSQL_TEST_URL;
  assert.ok(databaseUrl !== undefined);
  const connection = await connectMysql(databaseUrl);
  try {
    const first = await migrateServerDatabase(connection);
    const second = await migrateServerDatabase(connection);
    assert.deepEqual(first, [
      "0001_control_plane",
      "0002_human_device_login",
      "0003_agent_enrollment",
      "0004_room_control_plane",
      "0005_first_login_bootstrap",
      "0006_oidc_device_authorization",
      "0007_profiled_topics",
      "0008_native_topic_fanout",
      "0009_owner_scoped_agent_names",
      "0010_human_topic_publishers",
      "0011_project_connector_runtime",
      "0012_agent_work_requests"
    ]);
    assert.deepEqual(second, []);

    const [rows] = await connection.query<RowDataPacket[]>("SHOW TABLES");
    assert.equal(rows.length, 30);
    const [projectTombstone] = await connection.query<RowDataPacket[]>(
      "SHOW TABLES LIKE 'project_bindings'"
    );
    const [effectTombstone] = await connection.query<RowDataPacket[]>(
      "SHOW TABLES LIKE 'external_effects'"
    );
    assert.equal(projectTombstone.length, 1);
    assert.equal(effectTombstone.length, 1);
  } finally {
    await connection.end();
  }

  const pool = connectMysqlPool(databaseUrl);
  try {
    const repository = new MysqlRepository(pool);
    const connectorRepository = new MysqlConnectorRepository(pool);
    const services = createTestServices(
      repository,
      {
        issuer: "https://identity.example.com",
        publicUrl: "https://rollerskate.example.com"
      }
    );
    const authorization = await services.trust.beginAuthorization("/");
    const completion = await services.trust.completeAuthorization(
      await services.trust.takeAuthorization(authorization.state),
      {
        issuer: "https://identity.example.com",
        subject: "admin",
        displayName: "MySQL Admin",
        metadata: { email: "admin@example.com" }
      }
    );
    assert.equal(
      (await services.trust.authenticateSession(completion.sessionToken)).displayName,
      "MySQL Admin"
    );
    const proof = createVerifier();
    const pairing = await services.devices.createPairing({
      deviceId: "mysql-device",
      deviceName: "MySQL Device",
      verifierChallenge: proof.challenge
    });
    await services.devices.approvePairing(pairing.pairingId, completion.human);
    const issuance = await services.devices.redeemPairing(
      pairing.pairingId,
      "mysql-device",
      proof.verifier
    );
    const authentication = await services.devices.authenticateDevice(issuance.credential);
    assert.equal(services.devices.deviceSummary(authentication).human.id, completion.human.id);

    const agentProof = createVerifier();
    const created = await services.agents.createAgent(authentication, {
      name: "mysql-agent",
      verifierChallenge: agentProof.challenge
    });
    const agentIssuance = await services.agents.redeemAgentEnrollment(
      authentication,
      created.enrollment.id,
      agentProof.verifier
    );
    assert.equal(
      (await services.agents.authenticateAgent(
        agentIssuance.credential,
        created.agent.id
      )).placement.id,
      created.agent.placement.id
    );
    const workRequests = new WorkRequestService(
      new MysqlWorkRequestRepository(pool),
      repository,
      undefined,
      { now: () => new Date("2026-08-13T08:00:00.000Z") }
    );
    workRequests.registerRoute(created.agent.id, {
      schemaVersion: "WorkRequestRouteLease@1",
      routeId: "mysql-work-route",
      leaseMilliseconds: 60_000
    });
    const mysqlWorkRequest = await workRequests.create(
      { kind: "human", id: authentication.human.id },
      {
        schemaVersion: "AgentWorkRequestCreate@1",
        requestId: "mysql-work-request",
        targetAgentId: created.agent.id,
        objective: "Verify MySQL work request persistence",
        contextRefs: [],
        workflowRef: "forum@1",
        requestedBudget: { maxSteps: 4, maxDepth: 1 },
        requestedGrantRefs: [],
        resultRoute: "requester-bounded@1",
        expiresAt: "2026-08-13T09:00:00.000Z"
      }
    );
    assert.equal(mysqlWorkRequest.request.status, "received");
    assert.equal((await workRequests.create(
      { kind: "human", id: authentication.human.id },
      {
        schemaVersion: "AgentWorkRequestCreate@1",
        requestId: "mysql-work-request",
        targetAgentId: created.agent.id,
        objective: "Verify MySQL work request persistence",
        contextRefs: [],
        workflowRef: "forum@1",
        requestedBudget: { maxSteps: 4, maxDepth: 1 },
        requestedGrantRefs: [],
        resultRoute: "requester-bounded@1",
        expiresAt: "2026-08-13T09:00:00.000Z"
      }
    )).created, false);
    assert.deepEqual(
      (await workRequests.routed(created.agent.id, "mysql-work-route"))
        .map(({ workRequestId }) => workRequestId),
      [mysqlWorkRequest.request.workRequestId]
    );
    const connectors = new ConnectorService(connectorRepository, {
      now: () => new Date("2026-08-13T08:00:00.000Z")
    });
    const integration = await connectors.createIntegrationBinding(authentication, {
      connectorId: "vikunja",
      connectorVersion: "1",
      placement: "runtime",
      endpointRef: "http://127.0.0.1:3456",
      profileIds: ["playground@1"],
      externalScopeRef: "project:7",
      credentialRef: "credential:vikunja-local"
    });
    assert.equal(
      (await connectors.getIntegrationBinding(authentication, integration.bindingId)).bindingId,
      integration.bindingId
    );
    const suspended = await connectors.updateIntegrationBinding(
      authentication,
      integration.bindingId,
      { expectedRevision: 1, cursor: "mysql-cursor-1", status: "suspended" }
    );
    assert.equal(suspended.revision, 2);
    assert.equal(suspended.cursor, "mysql-cursor-1");
    assert.equal(suspended.status, "suspended");
    assert.equal(
      (await services.agents.redeemAgentEnrollment(
        authentication,
        created.enrollment.id,
        agentProof.verifier
      )).credential,
      agentIssuance.credential
    );

    await repository.createRoom({
      id: "mysql-room",
      name: "MySQL Room",
      matrixRoomId: "!mysql-room:example.com",
      visibility: "private",
      createdByHumanId: completion.human.id,
      headSequence: 0,
      createdAt: "2026-07-20T08:00:00.000Z"
    }, {
      roomId: "mysql-room",
      humanId: completion.human.id,
      role: "owner",
      canInvite: true,
      status: "active",
      createdAt: "2026-07-20T08:00:00.000Z"
    });
    await services.trust.allowSubject(completion.human, "mysql-member");
    const memberAuthorization = await services.trust.beginAuthorization("/");
    const member = await services.trust.completeAuthorization(
      await services.trust.takeAuthorization(memberAuthorization.state),
      {
        issuer: "https://identity.example.com",
        subject: "mysql-member",
        displayName: "MySQL Member",
        metadata: {}
      }
    );
    await repository.putRoomMembership({
      roomId: "mysql-room",
      humanId: member.human.id,
      role: "member",
      canInvite: false,
      status: "invited",
      invitedByHumanId: completion.human.id,
      createdAt: "2026-07-20T08:00:00.000Z"
    });
    assert.equal(
      (await repository.listRoomsForHuman(member.human.id))[0]?.membership?.status,
      "invited"
    );
    await repository.putAgentRoomBinding({
      id: "mysql-binding",
      agentId: created.agent.id,
      roomId: "mysql-room",
      wakeMode: "mention_only",
      createdByHumanId: completion.human.id,
      status: "active",
      createdAt: "2026-07-20T08:00:00.000Z",
      updatedAt: "2026-07-20T08:00:00.000Z"
    });
    const appended = await repository.appendRoomEvent({
      roomId: "mysql-room",
      matrixEventId: "$mysql-event",
      event: {
        protocolVersion: 1,
        eventId: "$mysql-event",
        type: "m.room.message",
        occurredAt: "2026-07-20T08:01:00.000Z",
        source: { kind: "server", id: "@human:example.com" },
        payload: { body: "hello" }
      }
    });
    assert.equal(appended.record.sequence, 1);
    assert.deepEqual(
      (await repository.listRoomEvents("mysql-room", 0, 1, 100))
        .map((event) => event.event.eventId),
      ["$mysql-event"]
    );
    assert.equal((await repository.getRoom("mysql-room"))?.headSequence, 1);

    await pool.execute(`
      UPDATE placements
      SET state = 'superseded', superseded_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [created.agent.placement.id]);
    await assert.rejects(
      () => services.agents.authenticateAgent(agentIssuance.credential),
      (error: unknown) => error instanceof Error && error.message.includes("invalid")
    );
    await services.devices.revokeDevice(authentication);
    await assert.rejects(() => services.devices.authenticateDevice(issuance.credential));
  } finally {
    await pool.end();
  }
});
