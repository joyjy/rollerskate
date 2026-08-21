import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import type {
  AgentAggregate,
  AgentAuthenticationRecord,
  AgentCredentialRecord,
  AgentRoomBindingRecord,
  EnrollmentGrantRecord,
  PlacementRecord
} from "../../../../application/model.js";
import type {
  AgentRepository,
  CreateAgentInput,
  CreateAgentOutcome,
  RedeemEnrollmentInput,
  RedeemEnrollmentOutcome
} from "../../../../modules/agent/repository.js";
import type {
  AgentAggregateRow,
  AgentAuthenticationRow,
  AgentRoomBindingRow,
  AgentRow,
  EnrollmentRow,
  PlacementRow
} from "./support.js";
import {
  AGENT_AGGREGATE_SELECT,
  AGENT_AUTHENTICATION_SELECT,
  AGENT_ROOM_BINDING_SELECT,
  agentAggregate,
  agentRoomBindingRecord,
  bindingValues,
  enrollmentRecord,
  loadAgentAggregate,
  placementRecord,
  sqlDate,
  updateBinding,
  withTransaction
} from "./support.js";

export class MysqlAgentRepository implements AgentRepository {
  readonly #pool: Pool;

  public constructor(pool: Pool) {
    this.#pool = pool;
  }

  public async createOrResumeAgent(
    input: CreateAgentInput
  ): Promise<CreateAgentOutcome> {
    return withTransaction(this.#pool, async (connection) => {
      const [agentRows] = await connection.execute<AgentRow[]>(`
        SELECT id, name, owner_human_id, operator_human_id, status,
               created_at, suspended_at
        FROM agents
        WHERE owner_human_id = ? AND name = ?
        FOR UPDATE
      `, [input.agent.ownerHumanId, input.agent.name]);
      let agent = agentRows[0];
      let placement: PlacementRecord;
      let enrollment: EnrollmentGrantRecord;
      if (agent === undefined) {
        await connection.execute(`
          INSERT INTO agents (
            id, owner_human_id, operator_human_id, name, status, created_at
          ) VALUES (?, ?, ?, ?, 'provisioning', ?)
        `, [
          input.agent.id,
          input.agent.ownerHumanId,
          input.agent.operatorHumanId,
          input.agent.name,
          sqlDate(input.agent.createdAt)
        ]);
        await connection.execute(`
          INSERT INTO placements (
            id, agent_id, device_id, state, generation, created_at
          ) VALUES (?, ?, ?, 'pending', ?, ?)
        `, [
          input.placement.id,
          input.placement.agentId,
          input.placement.deviceId,
          input.placement.generation,
          sqlDate(input.placement.createdAt)
        ]);
        await connection.execute(`
          INSERT INTO enrollment_grants (
            id, agent_id, device_id, placement_id, credential_id,
            verifier_hash, status, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, ?)
        `, [
          input.enrollment.id,
          input.enrollment.agentId,
          input.enrollment.deviceId,
          input.enrollment.placementId,
          input.enrollment.credentialId,
          input.enrollment.verifierChallenge,
          sqlDate(input.enrollment.expiresAt),
          sqlDate(input.enrollment.createdAt)
        ]);
        placement = input.placement;
        enrollment = input.enrollment;
        agent = {
          id: input.agent.id,
          name: input.agent.name,
          owner_human_id: input.agent.ownerHumanId,
          operator_human_id: input.agent.operatorHumanId,
          status: input.agent.status,
          created_at: sqlDate(input.agent.createdAt),
          suspended_at: null
        } as AgentRow;
      } else {
        if (agent.status !== "provisioning" && agent.status !== "active") {
          return { ok: false, reason: "agent_not_active" };
        }
        const [placementRows] = await connection.execute<PlacementRow[]>(`
          SELECT id, agent_id, device_id, state, generation, created_at,
                 activated_at, superseded_at
          FROM placements
          WHERE agent_id = ? AND state IN ('pending', 'active')
          ORDER BY generation DESC
          LIMIT 1
          FOR UPDATE
        `, [agent.id]);
        const placementRow = placementRows[0];
        if (placementRow === undefined || placementRow.device_id !== input.device.device.id) {
          if (placementRow !== undefined) {
            await connection.execute(`
              UPDATE placements
              SET state = 'superseded', superseded_at = ?
              WHERE id = ? AND state IN ('pending', 'active')
            `, [sqlDate(input.now), placementRow.id]);
            await connection.execute(`
              UPDATE enrollment_grants
              SET status = 'revoked'
              WHERE placement_id = ? AND status IN ('issued', 'redeemed')
            `, [placementRow.id]);
            await connection.execute(`
              UPDATE credential_metadata
              SET status = 'revoked', revoked_at = ?
              WHERE principal_kind = 'agent' AND principal_id = ?
                AND placement_id = ? AND status = 'active'
            `, [sqlDate(input.now), agent.id, placementRow.id]);
          }
          const [generationRows] = await connection.execute<RowDataPacket[]>(`
            SELECT COALESCE(MAX(generation), 0) AS generation
            FROM placements WHERE agent_id = ?
          `, [agent.id]);
          const generation = Number((generationRows[0] as { generation?: unknown }).generation) + 1;
          placement = {
            ...input.placement,
            agentId: agent.id,
            generation
          };
          enrollment = {
            ...input.enrollment,
            agentId: agent.id,
            placementId: placement.id
          };
          await connection.execute(`
            INSERT INTO placements (
              id, agent_id, device_id, state, generation, created_at
            ) VALUES (?, ?, ?, 'pending', ?, ?)
          `, [
            placement.id, placement.agentId, placement.deviceId,
            placement.generation, sqlDate(placement.createdAt)
          ]);
          await connection.execute(`
            INSERT INTO enrollment_grants (
              id, agent_id, device_id, placement_id, credential_id,
              verifier_hash, status, expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, ?)
          `, [
            enrollment.id, enrollment.agentId, enrollment.deviceId,
            enrollment.placementId, enrollment.credentialId,
            enrollment.verifierChallenge, sqlDate(enrollment.expiresAt),
            sqlDate(enrollment.createdAt)
          ]);
          return {
            ok: true,
            value: {
              aggregate: await loadAgentAggregate(connection, agent.id, placement.id),
              enrollment
            }
          };
        }
        const [enrollmentRows] = await connection.execute<EnrollmentRow[]>(`
          SELECT id, agent_id, device_id, placement_id, credential_id,
                 verifier_hash, status, expires_at, redeemed_at, created_at
          FROM enrollment_grants
          WHERE agent_id = ? AND placement_id = ?
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
        `, [agent.id, placementRow.id]);
        const enrollmentRow = enrollmentRows[0];
        if (enrollmentRow === undefined) {
          throw new Error(`Agent enrollment is missing: ${agent.id}`);
        }
        if (enrollmentRow.verifier_hash !== input.enrollment.verifierChallenge) {
          return { ok: false, reason: "verifier_mismatch" };
        }
        if (enrollmentRow.status === "revoked") {
          return { ok: false, reason: "agent_not_active" };
        }
        if (
          enrollmentRow.status === "expired" ||
          (enrollmentRow.status === "issued" &&
            enrollmentRow.expires_at.getTime() <= Date.parse(input.now))
        ) {
          await connection.execute(`
            UPDATE enrollment_grants
            SET status = 'issued', expires_at = ?
            WHERE id = ?
          `, [sqlDate(input.enrollment.expiresAt), enrollmentRow.id]);
          enrollmentRow.status = "issued";
          enrollmentRow.expires_at = sqlDate(input.enrollment.expiresAt);
        }
        placement = placementRecord(placementRow);
        enrollment = enrollmentRecord(enrollmentRow);
      }
      return {
        ok: true,
        value: {
          aggregate: await loadAgentAggregate(connection, agent.id, placement.id),
          enrollment
        }
      };
    });
  }

  public async redeemEnrollment(
    input: RedeemEnrollmentInput
  ): Promise<RedeemEnrollmentOutcome> {
    return withTransaction(this.#pool, async (connection) => {
      const [enrollmentRows] = await connection.execute<EnrollmentRow[]>(`
        SELECT id, agent_id, device_id, placement_id, credential_id,
               verifier_hash, status, expires_at, redeemed_at, created_at
        FROM enrollment_grants
        WHERE id = ?
        FOR UPDATE
      `, [input.grantId]);
      const enrollment = enrollmentRows[0];
      if (enrollment === undefined) {
        return { ok: false, reason: "not_found" };
      }
      if (typeof enrollment.credential_id !== "string" || enrollment.credential_id === "") {
        throw new Error(`Agent enrollment credential is missing: ${enrollment.id}`);
      }
      if (enrollment.device_id !== input.deviceId) {
        return { ok: false, reason: "device_mismatch" };
      }
      if (enrollment.verifier_hash !== input.verifierChallenge) {
        return { ok: false, reason: "verifier_mismatch" };
      }
      if (enrollment.status === "revoked") {
        return { ok: false, reason: "revoked" };
      }
      if (
        enrollment.status !== "redeemed" &&
        enrollment.expires_at.getTime() <= Date.parse(input.now)
      ) {
        await connection.execute(`
          UPDATE enrollment_grants SET status = 'expired' WHERE id = ?
        `, [enrollment.id]);
        return { ok: false, reason: "expired" };
      }
      const [agentRows] = await connection.execute<AgentRow[]>(`
        SELECT id, name, owner_human_id, operator_human_id, status,
               created_at, suspended_at
        FROM agents WHERE id = ? FOR UPDATE
      `, [enrollment.agent_id]);
      const [placementRows] = await connection.execute<PlacementRow[]>(`
        SELECT id, agent_id, device_id, state, generation, created_at,
               activated_at, superseded_at
        FROM placements WHERE id = ? FOR UPDATE
      `, [enrollment.placement_id]);
      const agent = agentRows[0];
      const placement = placementRows[0];
      if (agent === undefined || (agent.status !== "provisioning" && agent.status !== "active")) {
        return { ok: false, reason: "agent_inactive" };
      }
      if (
        placement === undefined ||
        (placement.state !== "pending" && placement.state !== "active")
      ) {
        return { ok: false, reason: "placement_inactive" };
      }
      let credential: AgentCredentialRecord;
      if (enrollment.status === "redeemed") {
        const [credentialRows] = await connection.execute<RowDataPacket[]>(`
          SELECT id, principal_id, placement_id, secret_hash, status,
                 created_at, expires_at, revoked_at
          FROM credential_metadata
          WHERE id = ? AND principal_kind = 'agent'
        `, [enrollment.credential_id]);
        const row = credentialRows[0] as {
          id?: unknown;
          principal_id?: unknown;
          placement_id?: unknown;
          secret_hash?: unknown;
          status?: unknown;
          created_at?: unknown;
          expires_at?: unknown;
          revoked_at?: unknown;
        } | undefined;
        if (
          typeof row?.id !== "string" ||
          typeof row.principal_id !== "string" ||
          typeof row.placement_id !== "string" ||
          typeof row.secret_hash !== "string" ||
          !(row.created_at instanceof Date)
        ) {
          throw new Error(`Redeemed Agent credential is missing: ${enrollment.credential_id}`);
        }
        credential = {
          id: row.id,
          agentId: row.principal_id,
          placementId: row.placement_id,
          secretHash: row.secret_hash,
          status: row.status as AgentCredentialRecord["status"],
          createdAt: row.created_at.toISOString(),
          ...(row.expires_at instanceof Date
            ? { expiresAt: row.expires_at.toISOString() }
            : {}),
          ...(row.revoked_at instanceof Date
            ? { revokedAt: row.revoked_at.toISOString() }
            : {})
        };
      } else {
        credential = {
          ...input.credential,
          id: enrollment.credential_id,
          agentId: enrollment.agent_id,
          placementId: enrollment.placement_id
        };
        await connection.execute(`
          INSERT INTO credential_metadata (
            id, principal_kind, principal_id, placement_id, secret_hash,
            hash_algorithm, status, created_at
          ) VALUES (?, 'agent', ?, ?, ?, 'scrypt', 'active', ?)
        `, [
          credential.id,
          credential.agentId,
          credential.placementId,
          credential.secretHash,
          sqlDate(credential.createdAt)
        ]);
        await connection.execute(`
          UPDATE placements
          SET state = 'active', activated_at = ?
          WHERE id = ? AND state = 'pending'
        `, [sqlDate(input.now), enrollment.placement_id]);
        await connection.execute(`
          UPDATE agents SET status = 'active'
          WHERE id = ? AND status = 'provisioning'
        `, [enrollment.agent_id]);
        await connection.execute(`
          UPDATE enrollment_grants
          SET status = 'redeemed', redeemed_at = ?
          WHERE id = ?
        `, [sqlDate(input.now), enrollment.id]);
      }
      return {
        ok: true,
        value: {
          aggregate: await loadAgentAggregate(
            connection,
            enrollment.agent_id,
            enrollment.placement_id
          ),
          credential
        }
      };
    });
  }

  public async listAgentsForDevice(
    deviceId: string
  ): Promise<readonly AgentAggregate[]> {
    const [rows] = await this.#pool.execute<AgentAggregateRow[]>(`
      ${AGENT_AGGREGATE_SELECT}
      WHERE p.device_id = ? AND p.state IN ('pending', 'active')
      ORDER BY a.name ASC
    `, [deviceId]);
    return rows.map(agentAggregate);
  }

  public async getAgentForDeviceByName(
    deviceId: string,
    name: string
  ): Promise<AgentAggregate | undefined> {
    const [rows] = await this.#pool.execute<AgentAggregateRow[]>(`
      ${AGENT_AGGREGATE_SELECT}
      WHERE p.device_id = ? AND p.state IN ('pending', 'active') AND a.name = ?
      LIMIT 1
    `, [deviceId, name]);
    return rows[0] === undefined ? undefined : agentAggregate(rows[0]);
  }

  public async getAgentAuthentication(
    credentialId: string,
    now: string
  ): Promise<AgentAuthenticationRecord | undefined> {
    const [rows] = await this.#pool.execute<AgentAuthenticationRow[]>(`
      ${AGENT_AUTHENTICATION_SELECT}
      WHERE c.id = ?
        AND c.principal_kind = 'agent'
        AND c.status = 'active'
        AND c.revoked_at IS NULL
        AND (c.expires_at IS NULL OR c.expires_at > ?)
        AND p.id = c.placement_id
        AND p.state = 'active'
        AND a.status = 'active'
        AND owner.status = 'active'
        AND operator.status = 'active'
    `, [credentialId, sqlDate(now)]);
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      ...agentAggregate(row),
      credential: {
        id: row.credential_id,
        agentId: row.credential_agent_id,
        placementId: row.credential_placement_id,
        secretHash: row.secret_hash,
        status: row.credential_status ?? "active",
        createdAt: row.credential_created_at.toISOString(),
        ...(row.credential_expires_at === null
          ? {}
          : { expiresAt: row.credential_expires_at.toISOString() }),
        ...(row.credential_revoked_at === null
          ? {}
          : { revokedAt: row.credential_revoked_at.toISOString() })
      }
    };
  }

  public async getAgentAggregateById(
    agentId: string
  ): Promise<AgentAggregate | undefined> {
    const [rows] = await this.#pool.execute<AgentAggregateRow[]>(`
      ${AGENT_AGGREGATE_SELECT}
      WHERE a.id = ? AND p.state IN ('pending', 'active')
      ORDER BY p.generation DESC
      LIMIT 1
    `, [agentId]);
    return rows[0] === undefined ? undefined : agentAggregate(rows[0]);
  }

  public async rotateAgentCredential(
    agentId: string,
    placementId: string,
    credential: AgentCredentialRecord,
    now: string
  ): Promise<AgentCredentialRecord | undefined> {
    return withTransaction(this.#pool, async (connection) => {
      const [placements] = await connection.execute<RowDataPacket[]>(`
        SELECT id FROM placements
        WHERE id = ? AND agent_id = ? AND state = 'active'
        FOR UPDATE
      `, [placementId, agentId]);
      if (placements.length !== 1) return undefined;
      const [rows] = await connection.execute<RowDataPacket[]>(`
        SELECT id FROM credential_metadata
        WHERE principal_kind = 'agent' AND principal_id = ? AND status = 'active'
        ORDER BY created_at DESC, id DESC
        FOR UPDATE
      `, [agentId]);
      const previousId = typeof (rows[0] as { id?: unknown } | undefined)?.id === "string"
        ? (rows[0] as { id: string }).id
        : undefined;
      await connection.execute(`
        UPDATE credential_metadata SET status = 'revoked', revoked_at = ?
        WHERE principal_kind = 'agent' AND principal_id = ? AND status = 'active'
      `, [sqlDate(now), agentId]);
      await connection.execute(`
        INSERT INTO credential_metadata (
          id, principal_kind, principal_id, placement_id, secret_hash,
          hash_algorithm, status, created_at, rotated_from_credential_id
        ) VALUES (?, 'agent', ?, ?, ?, 'scrypt', 'active', ?, ?)
      `, [
        credential.id, agentId, placementId, credential.secretHash,
        sqlDate(credential.createdAt), previousId ?? null
      ]);
      return {
        ...credential,
        ...(previousId === undefined ? {} : { rotatedFromCredentialId: previousId })
      };
    });
  }

  public async revokeAgentCredentials(agentId: string, now: string): Promise<number> {
    const [result] = await this.#pool.execute<ResultSetHeader>(`
      UPDATE credential_metadata SET status = 'revoked', revoked_at = ?
      WHERE principal_kind = 'agent' AND principal_id = ? AND status = 'active'
    `, [sqlDate(now), agentId]);
    return result.affectedRows;
  }

  public async getAgentRoomBinding(
    agentId: string,
    roomId: string
  ): Promise<AgentRoomBindingRecord | undefined> {
    const [rows] = await this.#pool.execute<AgentRoomBindingRow[]>(`
      ${AGENT_ROOM_BINDING_SELECT} WHERE agent_id = ? AND room_id = ?
    `, [agentId, roomId]);
    return rows[0] === undefined ? undefined : agentRoomBindingRecord(rows[0]);
  }

  public async putAgentRoomBinding(
    binding: AgentRoomBindingRecord
  ): Promise<AgentRoomBindingRecord> {
    return withTransaction(this.#pool, async (connection) => {
      const [rows] = await connection.execute<AgentRoomBindingRow[]>(`
        ${AGENT_ROOM_BINDING_SELECT}
        WHERE agent_id = ? AND room_id = ?
        FOR UPDATE
      `, [binding.agentId, binding.roomId]);
      const existing = rows[0];
      if (existing !== undefined && existing.status === "active") {
        return agentRoomBindingRecord(existing);
      }
      if (existing === undefined) {
        await connection.execute(`
          INSERT INTO agent_room_bindings (
            id, agent_id, room_id, wake_mode, created_by_human_id,
            status, created_at, updated_at, deactivated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, bindingValues(binding));
      } else {
        await updateBinding(connection, binding);
      }
      return binding;
    });
  }

  public async updateAgentRoomBinding(binding: AgentRoomBindingRecord): Promise<void> {
    const [result] = await this.#pool.execute<ResultSetHeader>(`
      UPDATE agent_room_bindings
      SET wake_mode = ?, created_by_human_id = ?, status = ?,
          updated_at = ?, deactivated_at = ?
      WHERE agent_id = ? AND room_id = ?
    `, [
      binding.wakeMode,
      binding.createdByHumanId,
      binding.status,
      sqlDate(binding.updatedAt),
      binding.deactivatedAt === undefined ? null : sqlDate(binding.deactivatedAt),
      binding.agentId,
      binding.roomId
    ]);
    if (result.affectedRows !== 1) {
      throw new Error(`Agent Room binding is missing: ${binding.agentId}/${binding.roomId}`);
    }
  }

  public async listAgentRoomBindings(
    agentId: string,
    activeOnly = false
  ): Promise<readonly AgentRoomBindingRecord[]> {
    const [rows] = await this.#pool.execute<AgentRoomBindingRow[]>(`
      ${AGENT_ROOM_BINDING_SELECT}
      WHERE agent_id = ? ${activeOnly ? "AND status = 'active'" : ""}
      ORDER BY room_id ASC
    `, [agentId]);
    return rows.map(agentRoomBindingRecord);
  }

}
