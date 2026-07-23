import { randomUUID } from "node:crypto";

import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket
} from "mysql2/promise";

import { eventEnvelopeSchema } from "@rollerskate/protocol";

import type {
  AgentAggregate,
  AgentAuthenticationRecord,
  AgentCredentialRecord,
  AgentRecord,
  AgentRoomBindingRecord,
  AppendedRoomEvent,
  AuthorizationTransactionRecord,
  BffSessionRecord,
  DeviceAuthenticationRecord,
  DeviceCredentialRecord,
  DeviceRecord,
  HumanRecord,
  MatrixPrincipalRecord,
  OidcIdentity,
  PairingRecord,
  PlacementRecord,
  RoomMembershipRecord,
  RoomRecord,
  StoredRoomEventRecord,
  EnrollmentGrantRecord,
  RedeemPairingInput
} from "../../../application/model.js";
import type {
  CreateAgentInput,
  CreateAgentOutcome,
  ServerRepository,
  PairingRedeemOutcome,
  RedeemEnrollmentInput,
  RedeemEnrollmentOutcome
} from "../../../application/repository.js";

interface AuthorizationRow extends RowDataPacket {
  state: string;
  nonce: string;
  code_verifier: string;
  return_to: string;
  expires_at: Date;
  created_at: Date;
  consumed_at: Date | null;
}

interface HumanRow extends RowDataPacket {
  id: string;
  oauth_issuer: string;
  oauth_subject: string;
  display_name: string;
  status: "active" | "revoked";
  is_admin: number | boolean;
  identity_metadata: string | null;
  created_at: Date;
}

interface DeploymentBootstrapRow extends RowDataPacket {
  admin_human_id: string | null;
}

interface SessionRow extends RowDataPacket {
  id: string;
  human_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
  revoked_at: Date | null;
}

interface PairingRow extends RowDataPacket {
  id: string;
  device_id: string;
  device_name: string;
  verifier_hash: string;
  oidc_device_code: string | null;
  poll_interval_ms: number | null;
  last_polled_at: Date | null;
  status: PairingRecord["status"];
  expires_at: Date;
  approved_human_id: string | null;
  redeemed_at: Date | null;
  created_at: Date;
}

interface DeviceAuthenticationRow extends HumanRow {
  credential_id: string;
  credential_device_id: string;
  secret_hash: string;
  credential_status: DeviceCredentialRecord["status"];
  credential_created_at: Date;
  credential_expires_at: Date | null;
  credential_revoked_at: Date | null;
  device_id: string;
  device_human_id: string;
  device_name: string;
  device_status: DeviceRecord["status"];
  device_created_at: Date;
  device_revoked_at: Date | null;
}

interface AgentRow extends RowDataPacket {
  id: string;
  name: string;
  owner_human_id: string;
  operator_human_id: string;
  status: AgentRecord["status"];
  created_at: Date;
  suspended_at: Date | null;
}

interface PlacementRow extends RowDataPacket {
  id: string;
  agent_id: string;
  device_id: string;
  state: PlacementRecord["state"];
  generation: number;
  created_at: Date;
  activated_at: Date | null;
  superseded_at: Date | null;
}

interface EnrollmentRow extends RowDataPacket {
  id: string;
  agent_id: string;
  device_id: string;
  placement_id: string;
  credential_id: string | null;
  verifier_hash: string;
  status: EnrollmentGrantRecord["status"];
  expires_at: Date;
  redeemed_at: Date | null;
  created_at: Date;
}

interface AgentAggregateRow extends RowDataPacket {
  agent_id: string;
  agent_name: string;
  owner_human_id: string;
  operator_human_id: string;
  agent_status: AgentRecord["status"];
  agent_created_at: Date;
  agent_suspended_at: Date | null;
  placement_id: string;
  placement_device_id: string;
  placement_state: PlacementRecord["state"];
  placement_generation: number;
  placement_created_at: Date;
  placement_activated_at: Date | null;
  placement_superseded_at: Date | null;
  credential_status: AgentCredentialRecord["status"] | null;
  owner_issuer: string;
  owner_subject: string;
  owner_display_name: string;
  owner_status: HumanRecord["status"];
  owner_is_admin: number | boolean;
  owner_metadata: string | null;
  owner_created_at: Date;
  operator_issuer: string;
  operator_subject: string;
  operator_display_name: string;
  operator_status: HumanRecord["status"];
  operator_is_admin: number | boolean;
  operator_metadata: string | null;
  operator_created_at: Date;
}

interface AgentAuthenticationRow extends AgentAggregateRow {
  credential_id: string;
  credential_agent_id: string;
  credential_placement_id: string;
  secret_hash: string;
  credential_created_at: Date;
  credential_expires_at: Date | null;
  credential_revoked_at: Date | null;
}

interface RoomRow extends RowDataPacket {
  id: string;
  name: string;
  matrix_room_id: string;
  visibility: RoomRecord["visibility"];
  created_by_human_id: string;
  head_sequence: number | string;
  created_at: Date;
}

interface RoomMembershipRow extends RowDataPacket {
  room_id: string;
  human_id: string;
  role: RoomMembershipRecord["role"];
  can_invite: number | boolean;
  status: RoomMembershipRecord["status"];
  invited_by_human_id: string | null;
  created_at: Date;
  left_at: Date | null;
}

interface RoomListRow extends RoomRow {
  membership_human_id: string | null;
  membership_role: RoomMembershipRecord["role"] | null;
  membership_can_invite: number | boolean | null;
  membership_status: RoomMembershipRecord["status"] | null;
  membership_invited_by_human_id: string | null;
  membership_created_at: Date | null;
  membership_left_at: Date | null;
}

interface AgentRoomBindingRow extends RowDataPacket {
  id: string;
  agent_id: string;
  room_id: string;
  wake_mode: AgentRoomBindingRecord["wakeMode"];
  created_by_human_id: string;
  status: AgentRoomBindingRecord["status"];
  created_at: Date;
  updated_at: Date;
  deactivated_at: Date | null;
}

interface StoredRoomEventRow extends RowDataPacket {
  room_id: string;
  room_sequence: number | string;
  matrix_event_id: string;
  event_json: string;
  retained_until: Date | null;
}

interface MatrixPrincipalRow extends RowDataPacket {
  principal_kind: MatrixPrincipalRecord["principalKind"];
  principal_id: string;
  mxid: string;
  created_at: Date;
}

const AGENT_AGGREGATE_SELECT = `
  SELECT
    a.id AS agent_id,
    a.name AS agent_name,
    a.owner_human_id,
    a.operator_human_id,
    a.status AS agent_status,
    a.created_at AS agent_created_at,
    a.suspended_at AS agent_suspended_at,
    p.id AS placement_id,
    p.device_id AS placement_device_id,
    p.state AS placement_state,
    p.generation AS placement_generation,
    p.created_at AS placement_created_at,
    p.activated_at AS placement_activated_at,
    p.superseded_at AS placement_superseded_at,
    c.status AS credential_status,
    owner.oauth_issuer AS owner_issuer,
    owner.oauth_subject AS owner_subject,
    owner.display_name AS owner_display_name,
    owner.status AS owner_status,
    owner.is_admin AS owner_is_admin,
    owner.identity_metadata AS owner_metadata,
    owner.created_at AS owner_created_at,
    operator.oauth_issuer AS operator_issuer,
    operator.oauth_subject AS operator_subject,
    operator.display_name AS operator_display_name,
    operator.status AS operator_status,
    operator.is_admin AS operator_is_admin,
    operator.identity_metadata AS operator_metadata,
    operator.created_at AS operator_created_at
  FROM agents a
  JOIN placements p ON p.agent_id = a.id
  JOIN humans owner ON owner.id = a.owner_human_id
  JOIN humans operator ON operator.id = a.operator_human_id
  LEFT JOIN credential_metadata c ON c.id = (
    SELECT latest.id
    FROM credential_metadata latest
    WHERE latest.principal_kind = 'agent'
      AND latest.principal_id = a.id
      AND latest.placement_id = p.id
    ORDER BY latest.created_at DESC, latest.id DESC
    LIMIT 1
  )
`;

const AGENT_AUTHENTICATION_SELECT = `
  SELECT
    a.id AS agent_id,
    a.name AS agent_name,
    a.owner_human_id,
    a.operator_human_id,
    a.status AS agent_status,
    a.created_at AS agent_created_at,
    a.suspended_at AS agent_suspended_at,
    p.id AS placement_id,
    p.device_id AS placement_device_id,
    p.state AS placement_state,
    p.generation AS placement_generation,
    p.created_at AS placement_created_at,
    p.activated_at AS placement_activated_at,
    p.superseded_at AS placement_superseded_at,
    c.status AS credential_status,
    owner.oauth_issuer AS owner_issuer,
    owner.oauth_subject AS owner_subject,
    owner.display_name AS owner_display_name,
    owner.status AS owner_status,
    owner.is_admin AS owner_is_admin,
    owner.identity_metadata AS owner_metadata,
    owner.created_at AS owner_created_at,
    operator.oauth_issuer AS operator_issuer,
    operator.oauth_subject AS operator_subject,
    operator.display_name AS operator_display_name,
    operator.status AS operator_status,
    operator.is_admin AS operator_is_admin,
    operator.identity_metadata AS operator_metadata,
    operator.created_at AS operator_created_at,
    c.id AS credential_id,
    c.principal_id AS credential_agent_id,
    c.placement_id AS credential_placement_id,
    c.secret_hash,
    c.created_at AS credential_created_at,
    c.expires_at AS credential_expires_at,
    c.revoked_at AS credential_revoked_at
  FROM credential_metadata c
  JOIN agents a ON a.id = c.principal_id
  JOIN placements p ON p.id = c.placement_id AND p.agent_id = a.id
  JOIN humans owner ON owner.id = a.owner_human_id
  JOIN humans operator ON operator.id = a.operator_human_id
`;

const ROOM_SELECT = `
  SELECT id, name, matrix_room_id, visibility, created_by_human_id,
         head_sequence, created_at
  FROM rooms
`;

const ROOM_MEMBERSHIP_SELECT = `
  SELECT room_id, human_id, role, can_invite, status,
         invited_by_human_id, created_at, left_at
  FROM room_human_memberships
`;

const AGENT_ROOM_BINDING_SELECT = `
  SELECT id, agent_id, room_id, wake_mode, created_by_human_id,
         status, created_at, updated_at, deactivated_at
  FROM agent_room_bindings
`;

const STORED_ROOM_EVENT_SELECT = `
  SELECT room_id, room_sequence, matrix_event_id, event_json, retained_until
  FROM room_event_projections
`;

const MATRIX_PRINCIPAL_SELECT = `
  SELECT principal_kind, principal_id, mxid, created_at
  FROM matrix_principals
`;

export class MysqlRepository implements ServerRepository {
  readonly #pool: Pool;

  public constructor(pool: Pool) {
    this.#pool = pool;
  }

  public async putAuthorizationTransaction(
    record: AuthorizationTransactionRecord
  ): Promise<void> {
    await this.#pool.execute(`
      INSERT INTO oidc_authorization_transactions (
        state, nonce, code_verifier, return_to, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
      record.state,
      record.nonce,
      record.codeVerifier,
      record.returnTo,
      sqlDate(record.expiresAt),
      sqlDate(record.createdAt)
    ]);
  }

  public async takeAuthorizationTransaction(
    state: string,
    now: string
  ): Promise<AuthorizationTransactionRecord | undefined> {
    return this.#transaction(async (connection) => {
      const [rows] = await connection.execute<AuthorizationRow[]>(`
        SELECT state, nonce, code_verifier, return_to, expires_at, created_at, consumed_at
        FROM oidc_authorization_transactions
        WHERE state = ?
        FOR UPDATE
      `, [state]);
      const row = rows[0];
      if (
        row === undefined ||
        row.consumed_at !== null ||
        row.expires_at.getTime() <= Date.parse(now)
      ) {
        return undefined;
      }
      await connection.execute(`
        UPDATE oidc_authorization_transactions
        SET consumed_at = ?
        WHERE state = ?
      `, [sqlDate(now), state]);
      return authorizationRecord(row);
    });
  }

  public async admitHuman(
    identity: OidcIdentity,
    now: string
  ): Promise<HumanRecord | undefined> {
    return this.#transaction(async (connection) => {
      const [bootstrapRows] = await connection.execute<DeploymentBootstrapRow[]>(`
        SELECT admin_human_id
        FROM deployment_bootstrap
        WHERE id = 1
        FOR UPDATE
      `);
      const bootstrap = bootstrapRows[0];
      if (bootstrap === undefined) {
        throw new Error("deployment bootstrap state is missing");
      }

      const [humanRows] = await connection.execute<HumanRow[]>(`
        SELECT id, oauth_issuer, oauth_subject, display_name, status, is_admin,
               identity_metadata, created_at
        FROM humans
        WHERE oauth_issuer = ? AND oauth_subject = ?
        FOR UPDATE
      `, [identity.issuer, identity.subject]);
      const existing = humanRows[0];
      const isBootstrapAdmin = bootstrap.admin_human_id === null;
      let isAdmitted = isBootstrapAdmin || Boolean(existing?.is_admin);
      if (!isAdmitted) {
        const [allowlistRows] = await connection.execute<RowDataPacket[]>(`
          SELECT 1 AS admitted
          FROM admission_allowlist
          WHERE issuer = ? AND oauth_subject = ? AND status = 'active'
        `, [identity.issuer, identity.subject]);
        isAdmitted = allowlistRows.length === 1;
      }
      if (!isAdmitted) return undefined;

      const isAdmin = isBootstrapAdmin || Boolean(existing?.is_admin);
      let human: HumanRecord;
      if (existing === undefined) {
        const id = randomUUID();
        await connection.execute(`
          INSERT INTO humans (
            id, oauth_issuer, oauth_subject, display_name, status, is_admin,
            identity_metadata, created_at
          ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
        `, [
          id,
          identity.issuer,
          identity.subject,
          identity.displayName,
          isAdmin,
          JSON.stringify(identity.metadata),
          sqlDate(now)
        ]);
        human = {
          id,
          issuer: identity.issuer,
          subject: identity.subject,
          displayName: identity.displayName,
          status: "active",
          isAdmin,
          metadata: identity.metadata,
          createdAt: now
        };
      } else {
        await connection.execute(`
          UPDATE humans
          SET display_name = ?, is_admin = ?, identity_metadata = ?
          WHERE id = ?
        `, [
          identity.displayName,
          isAdmin,
          JSON.stringify(identity.metadata),
          existing.id
        ]);
        human = {
          ...humanRecord(existing),
          displayName: identity.displayName,
          isAdmin,
          metadata: identity.metadata
        };
      }

      if (isBootstrapAdmin) {
        await connection.execute(`
          UPDATE deployment_bootstrap
          SET admin_human_id = ?, claimed_at = ?
          WHERE id = 1
        `, [human.id, sqlDate(now)]);
      }
      return human;
    });
  }

  public async allowSubject(
    issuer: string,
    subject: string,
    createdByHumanId: string,
    now: string
  ): Promise<void> {
    await this.#transaction(async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(`
        SELECT status
        FROM admission_allowlist
        WHERE issuer = ? AND oauth_subject = ?
        FOR UPDATE
      `, [issuer, subject]);
      if (rows.length === 0) {
        await connection.execute(`
          INSERT INTO admission_allowlist (
            issuer, oauth_subject, status, created_by_human_id, created_at
          ) VALUES (?, ?, 'active', ?, ?)
        `, [issuer, subject, createdByHumanId, sqlDate(now)]);
      } else {
        await connection.execute(`
          UPDATE admission_allowlist
          SET status = 'active', revoked_at = NULL
          WHERE issuer = ? AND oauth_subject = ?
        `, [issuer, subject]);
      }
    });
  }

  public async getHuman(id: string): Promise<HumanRecord | undefined> {
    const [rows] = await this.#pool.execute<HumanRow[]>(`
      SELECT id, oauth_issuer, oauth_subject, display_name, status, is_admin,
             identity_metadata, created_at
      FROM humans
      WHERE id = ?
    `, [id]);
    return rows[0] === undefined ? undefined : humanRecord(rows[0]);
  }

  public async putSession(record: BffSessionRecord): Promise<void> {
    await this.#pool.execute(`
      INSERT INTO bff_sessions (
        id, human_id, token_hash, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `, [
      record.id,
      record.humanId,
      record.tokenHash,
      sqlDate(record.expiresAt),
      sqlDate(record.createdAt)
    ]);
  }

  public async getSession(
    id: string,
    now: string
  ): Promise<BffSessionRecord | undefined> {
    const [rows] = await this.#pool.execute<SessionRow[]>(`
      SELECT id, human_id, token_hash, expires_at, created_at, revoked_at
      FROM bff_sessions
      WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
    `, [id, sqlDate(now)]);
    const row = rows[0];
    return row === undefined ? undefined : {
      id: row.id,
      humanId: row.human_id,
      tokenHash: row.token_hash,
      expiresAt: row.expires_at.toISOString(),
      createdAt: row.created_at.toISOString(),
      ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at.toISOString() })
    };
  }

  public async putPairing(record: PairingRecord): Promise<void> {
    await this.#pool.execute(`
      INSERT INTO pairing_transactions (
        id, device_id, device_name, verifier_hash, oidc_device_code,
        poll_interval_ms, status, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.deviceId,
      record.deviceName,
      record.verifierChallenge,
      record.oidcDeviceCode ?? null,
      record.pollIntervalMilliseconds ?? null,
      record.status,
      sqlDate(record.expiresAt),
      sqlDate(record.createdAt)
    ]);
  }

  public async getPairing(id: string, now: string): Promise<PairingRecord | undefined> {
    return this.#transaction(async (connection) => {
      const [rows] = await connection.execute<PairingRow[]>(`
        SELECT id, device_id, device_name, verifier_hash, oidc_device_code,
               poll_interval_ms, last_polled_at, status, expires_at,
               approved_human_id, redeemed_at, created_at
        FROM pairing_transactions
        WHERE id = ?
        FOR UPDATE
      `, [id]);
      const row = rows[0];
      if (row === undefined) {
        return undefined;
      }
      if (
        (row.status === "pending" || row.status === "approved") &&
        row.expires_at.getTime() <= Date.parse(now)
      ) {
        await connection.execute(`
          UPDATE pairing_transactions SET status = 'expired' WHERE id = ?
        `, [id]);
        return { ...pairingRecord(row), status: "expired" };
      }
      return pairingRecord(row);
    });
  }

  public async claimPairingAuthorizationPoll(
    id: string,
    now: string
  ): Promise<PairingRecord | undefined> {
    return this.#transaction(async (connection) => {
      const [rows] = await connection.execute<PairingRow[]>(`
        SELECT id, device_id, device_name, verifier_hash, oidc_device_code,
               poll_interval_ms, last_polled_at, status, expires_at,
               approved_human_id, redeemed_at, created_at
        FROM pairing_transactions
        WHERE id = ?
        FOR UPDATE
      `, [id]);
      const row = rows[0];
      if (
        row === undefined ||
        row.status !== "pending" ||
        row.oidc_device_code === null ||
        row.poll_interval_ms === null ||
        row.expires_at.getTime() <= Date.parse(now)
      ) {
        return undefined;
      }
      if (
        row.last_polled_at !== null &&
        row.last_polled_at.getTime() + row.poll_interval_ms > Date.parse(now)
      ) {
        return undefined;
      }
      await connection.execute(`
        UPDATE pairing_transactions SET last_polled_at = ? WHERE id = ?
      `, [sqlDate(now), id]);
      return { ...pairingRecord(row), lastPolledAt: now };
    });
  }

  public async updatePairingPollInterval(
    id: string,
    milliseconds: number
  ): Promise<void> {
    await this.#pool.execute(`
      UPDATE pairing_transactions
      SET poll_interval_ms = ?
      WHERE id = ? AND status = 'pending'
    `, [milliseconds, id]);
  }

  public async finishPairingAuthorization(
    id: string,
    status: "expired" | "cancelled"
  ): Promise<void> {
    await this.#pool.execute(`
      UPDATE pairing_transactions
      SET status = ?
      WHERE id = ? AND status = 'pending'
    `, [status, id]);
  }

  public async approvePairing(
    id: string,
    humanId: string,
    now: string
  ): Promise<boolean> {
    const [result] = await this.#pool.execute<ResultSetHeader>(`
      UPDATE pairing_transactions
      SET status = 'approved', approved_human_id = ?
      WHERE id = ? AND status = 'pending' AND expires_at > ?
    `, [humanId, id, sqlDate(now)]);
    return result.affectedRows === 1;
  }

  public async redeemPairing(input: RedeemPairingInput): Promise<PairingRedeemOutcome> {
    return this.#transaction(async (connection) => {
      const [rows] = await connection.execute<PairingRow[]>(`
        SELECT id, device_id, device_name, verifier_hash, oidc_device_code,
               poll_interval_ms, last_polled_at, status, expires_at,
               approved_human_id, redeemed_at, created_at
        FROM pairing_transactions
        WHERE id = ?
        FOR UPDATE
      `, [input.pairingId]);
      const pairing = rows[0];
      if (pairing === undefined) {
        return { ok: false, reason: "not_found" };
      }
      if (pairing.status === "redeemed") {
        return { ok: false, reason: "already_redeemed" };
      }
      if (pairing.expires_at.getTime() <= Date.parse(input.now)) {
        await connection.execute(`
          UPDATE pairing_transactions SET status = 'expired' WHERE id = ?
        `, [input.pairingId]);
        return { ok: false, reason: "expired" };
      }
      if (pairing.status !== "approved" || pairing.approved_human_id === null) {
        return { ok: false, reason: "not_approved" };
      }
      if (pairing.device_id !== input.deviceId) {
        return { ok: false, reason: "device_mismatch" };
      }
      if (pairing.verifier_hash !== input.verifierChallenge) {
        return { ok: false, reason: "verifier_mismatch" };
      }
      const [deviceRows] = await connection.execute<RowDataPacket[]>(`
        SELECT id FROM devices WHERE id = ? FOR UPDATE
      `, [input.deviceId]);
      if (deviceRows.length !== 0) {
        return { ok: false, reason: "device_exists" };
      }
      const [humanRows] = await connection.execute<HumanRow[]>(`
        SELECT id, oauth_issuer, oauth_subject, display_name, status, is_admin,
               identity_metadata, created_at
        FROM humans
        WHERE id = ? AND status = 'active'
      `, [pairing.approved_human_id]);
      const humanRow = humanRows[0];
      if (humanRow === undefined) {
        return { ok: false, reason: "not_approved" };
      }
      const device: DeviceRecord = {
        id: pairing.device_id,
        humanId: humanRow.id,
        name: pairing.device_name,
        status: "active",
        createdAt: input.now
      };
      await connection.execute(`
        INSERT INTO devices (id, human_id, name, status, created_at)
        VALUES (?, ?, ?, 'active', ?)
      `, [device.id, device.humanId, device.name, sqlDate(device.createdAt)]);
      await connection.execute(`
        INSERT INTO credential_metadata (
          id, principal_kind, principal_id, secret_hash, hash_algorithm,
          status, created_at
        ) VALUES (?, 'device', ?, ?, 'scrypt', 'active', ?)
      `, [
        input.credential.id,
        device.id,
        input.credential.secretHash,
        sqlDate(input.credential.createdAt)
      ]);
      await connection.execute(`
        UPDATE pairing_transactions
        SET status = 'redeemed', redeemed_at = ?
        WHERE id = ?
      `, [sqlDate(input.now), input.pairingId]);
      return {
        ok: true,
        value: {
          device,
          human: humanRecord(humanRow),
          credential: input.credential
        }
      };
    });
  }

  public async getDeviceAuthentication(
    credentialId: string,
    now: string
  ): Promise<DeviceAuthenticationRecord | undefined> {
    const [rows] = await this.#pool.execute<DeviceAuthenticationRow[]>(`
      SELECT
        c.id AS credential_id,
        c.principal_id AS credential_device_id,
        c.secret_hash,
        c.status AS credential_status,
        c.created_at AS credential_created_at,
        c.expires_at AS credential_expires_at,
        c.revoked_at AS credential_revoked_at,
        d.id AS device_id,
        d.human_id AS device_human_id,
        d.name AS device_name,
        d.status AS device_status,
        d.created_at AS device_created_at,
        d.revoked_at AS device_revoked_at,
        h.id,
        h.oauth_issuer,
        h.oauth_subject,
        h.display_name,
        h.status,
        h.is_admin,
        h.identity_metadata,
        h.created_at
      FROM credential_metadata c
      JOIN devices d ON d.id = c.principal_id
      JOIN humans h ON h.id = d.human_id
      WHERE c.id = ?
        AND c.principal_kind = 'device'
        AND c.status = 'active'
        AND c.revoked_at IS NULL
        AND (c.expires_at IS NULL OR c.expires_at > ?)
        AND d.status = 'active'
        AND h.status = 'active'
    `, [credentialId, sqlDate(now)]);
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      credential: {
        id: row.credential_id,
        deviceId: row.credential_device_id,
        secretHash: row.secret_hash,
        status: row.credential_status,
        createdAt: row.credential_created_at.toISOString(),
        ...(row.credential_expires_at === null
          ? {}
          : { expiresAt: row.credential_expires_at.toISOString() }),
        ...(row.credential_revoked_at === null
          ? {}
          : { revokedAt: row.credential_revoked_at.toISOString() })
      },
      device: {
        id: row.device_id,
        humanId: row.device_human_id,
        name: row.device_name,
        status: row.device_status,
        createdAt: row.device_created_at.toISOString(),
        ...(row.device_revoked_at === null
          ? {}
          : { revokedAt: row.device_revoked_at.toISOString() })
      },
      human: humanRecord(row)
    };
  }

  public async revokeDeviceCredential(
    credentialId: string,
    now: string
  ): Promise<boolean> {
    return this.#transaction(async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(`
        SELECT principal_id
        FROM credential_metadata
        WHERE id = ? AND principal_kind = 'device' AND status = 'active'
        FOR UPDATE
      `, [credentialId]);
      const row = rows[0] as { principal_id?: unknown } | undefined;
      if (typeof row?.principal_id !== "string") {
        return false;
      }
      await connection.execute(`
        UPDATE credential_metadata
        SET status = 'revoked', revoked_at = ?
        WHERE id = ?
      `, [sqlDate(now), credentialId]);
      await connection.execute(`
        UPDATE devices
        SET status = 'revoked', revoked_at = ?
        WHERE id = ?
      `, [sqlDate(now), row.principal_id]);
      return true;
    });
  }

  public async createOrResumeAgent(
    input: CreateAgentInput
  ): Promise<CreateAgentOutcome> {
    return this.#transaction(async (connection) => {
      const [agentRows] = await connection.execute<AgentRow[]>(`
        SELECT id, name, owner_human_id, operator_human_id, status,
               created_at, suspended_at
        FROM agents
        WHERE name = ?
        FOR UPDATE
      `, [input.agent.name]);
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
        if (agent.owner_human_id !== input.device.human.id) {
          return { ok: false, reason: "name_taken" };
        }
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
          return { ok: false, reason: "different_device" };
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
          aggregate: await this.#agentAggregate(connection, agent.id, placement.id),
          enrollment
        }
      };
    });
  }

  public async redeemEnrollment(
    input: RedeemEnrollmentInput
  ): Promise<RedeemEnrollmentOutcome> {
    return this.#transaction(async (connection) => {
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
          aggregate: await this.#agentAggregate(
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

  public async createRoom(
    room: RoomRecord,
    creator: RoomMembershipRecord
  ): Promise<void> {
    await this.#transaction(async (connection) => {
      await connection.execute(`
        INSERT INTO rooms (
          id, name, matrix_room_id, visibility, created_by_human_id,
          head_sequence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        room.id, room.name, room.matrixRoomId, room.visibility,
        room.createdByHumanId, room.headSequence, sqlDate(room.createdAt)
      ]);
      await connection.execute(`
        INSERT INTO room_human_memberships (
          room_id, human_id, role, can_invite, status,
          invited_by_human_id, created_at, left_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, membershipValues(creator));
    });
  }

  public async getRoom(roomId: string): Promise<RoomRecord | undefined> {
    const [rows] = await this.#pool.execute<RoomRow[]>(`
      ${ROOM_SELECT} WHERE id = ?
    `, [roomId]);
    return rows[0] === undefined ? undefined : roomRecord(rows[0]);
  }

  public async getRoomByMatrixId(
    matrixRoomId: string
  ): Promise<RoomRecord | undefined> {
    const [rows] = await this.#pool.execute<RoomRow[]>(`
      ${ROOM_SELECT} WHERE matrix_room_id = ?
    `, [matrixRoomId]);
    return rows[0] === undefined ? undefined : roomRecord(rows[0]);
  }

  public async listRoomsForHuman(humanId: string): Promise<readonly {
    readonly room: RoomRecord;
    readonly membership?: RoomMembershipRecord;
  }[]> {
    const [rows] = await this.#pool.execute<RoomListRow[]>(`
      SELECT
        r.id, r.name, r.matrix_room_id, r.visibility,
        r.created_by_human_id, r.head_sequence, r.created_at,
        m.human_id AS membership_human_id,
        m.role AS membership_role,
        m.can_invite AS membership_can_invite,
        m.status AS membership_status,
        m.invited_by_human_id AS membership_invited_by_human_id,
        m.created_at AS membership_created_at,
        m.left_at AS membership_left_at
      FROM rooms r
      LEFT JOIN room_human_memberships m
        ON m.room_id = r.id AND m.human_id = ?
      WHERE r.visibility = 'public' OR m.status IN ('invited', 'active')
      ORDER BY r.name ASC, r.id ASC
    `, [humanId]);
    return rows.map((row) => ({
      room: roomRecord(row),
      ...(row.membership_human_id === null
        ? {}
        : { membership: roomMembershipRecord(row) })
    }));
  }

  public async getRoomMembership(
    roomId: string,
    humanId: string
  ): Promise<RoomMembershipRecord | undefined> {
    const [rows] = await this.#pool.execute<RoomMembershipRow[]>(`
      ${ROOM_MEMBERSHIP_SELECT} WHERE room_id = ? AND human_id = ?
    `, [roomId, humanId]);
    return rows[0] === undefined ? undefined : roomMembershipRecord(rows[0]);
  }

  public async putRoomMembership(membership: RoomMembershipRecord): Promise<void> {
    await this.#pool.execute(`
      INSERT INTO room_human_memberships (
        room_id, human_id, role, can_invite, status,
        invited_by_human_id, created_at, left_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        role = VALUES(role), can_invite = VALUES(can_invite),
        status = VALUES(status), invited_by_human_id = VALUES(invited_by_human_id),
        left_at = VALUES(left_at)
    `, membershipValues(membership));
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
    return this.#transaction(async (connection) => {
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

  public async appendRoomEvent(input: {
    readonly roomId: string;
    readonly matrixEventId: string;
    readonly event: StoredRoomEventRecord["event"];
    readonly retainedUntil?: string;
  }): Promise<AppendedRoomEvent> {
    return this.#transaction(async (connection) => {
      const [roomRows] = await connection.execute<RoomRow[]>(`
        ${ROOM_SELECT} WHERE id = ? FOR UPDATE
      `, [input.roomId]);
      const room = roomRows[0];
      if (room === undefined) {
        throw new Error(`Room is missing: ${input.roomId}`);
      }
      const [existingRows] = await connection.execute<StoredRoomEventRow[]>(`
        ${STORED_ROOM_EVENT_SELECT} WHERE matrix_event_id = ?
      `, [input.matrixEventId]);
      const existing = existingRows[0];
      if (existing !== undefined) {
        return {
          created: false,
          record: storedRoomEventRecord(existing),
          candidateBindings: []
        };
      }
      const sequence = Number(room.head_sequence) + 1;
      const position = String(sequence);
      await connection.execute(`
        UPDATE rooms SET head_sequence = ?, room_head = ? WHERE id = ?
      `, [sequence, position, input.roomId]);
      await connection.execute(`
        INSERT INTO room_event_projections (
          event_id, room_id, room_position, room_sequence, matrix_event_id,
          event_type, occurred_at, source_kind, source_id, payload,
          adapter_metadata, event_json, retained_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        input.event.eventId,
        input.roomId,
        position,
        sequence,
        input.matrixEventId,
        input.event.type,
        sqlDate(input.event.occurredAt),
        input.event.source.kind,
        input.event.source.id,
        JSON.stringify(input.event.payload),
        input.event.adapter === undefined
          ? null
          : JSON.stringify(input.event.adapter.metadata),
        JSON.stringify(input.event),
        input.retainedUntil === undefined ? null : sqlDate(input.retainedUntil)
      ]);
      const [bindingRows] = await connection.execute<AgentRoomBindingRow[]>(`
        ${AGENT_ROOM_BINDING_SELECT}
        WHERE room_id = ? AND status = 'active'
        ORDER BY agent_id ASC
      `, [input.roomId]);
      return {
        created: true,
        record: {
          roomId: input.roomId,
          sequence,
          matrixEventId: input.matrixEventId,
          event: input.event,
          ...(input.retainedUntil === undefined
            ? {}
            : { retainedUntil: input.retainedUntil })
        },
        candidateBindings: bindingRows.map(agentRoomBindingRecord)
      };
    });
  }

  public async listRoomEvents(
    roomId: string,
    afterSequence: number,
    throughSequence: number,
    limit: number
  ): Promise<readonly StoredRoomEventRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Room event limit must be from 1 to 100");
    }
    const [rows] = await this.#pool.execute<StoredRoomEventRow[]>(`
      ${STORED_ROOM_EVENT_SELECT}
      WHERE room_id = ? AND room_sequence > ? AND room_sequence <= ?
      ORDER BY room_sequence ASC
      LIMIT ${limit}
    `, [roomId, afterSequence, throughSequence]);
    return rows.map(storedRoomEventRecord);
  }

  public async getMatrixPrincipalByMxid(
    mxid: string
  ): Promise<MatrixPrincipalRecord | undefined> {
    const [rows] = await this.#pool.execute<MatrixPrincipalRow[]>(`
      ${MATRIX_PRINCIPAL_SELECT} WHERE mxid = ?
    `, [mxid]);
    return rows[0] === undefined ? undefined : matrixPrincipalRecord(rows[0]);
  }

  public async getMatrixPrincipal(
    principalKind: MatrixPrincipalRecord["principalKind"],
    principalId: string
  ): Promise<MatrixPrincipalRecord | undefined> {
    const [rows] = await this.#pool.execute<MatrixPrincipalRow[]>(`
      ${MATRIX_PRINCIPAL_SELECT}
      WHERE principal_kind = ? AND principal_id = ?
    `, [principalKind, principalId]);
    return rows[0] === undefined ? undefined : matrixPrincipalRecord(rows[0]);
  }

  public async putMatrixPrincipal(record: MatrixPrincipalRecord): Promise<void> {
    await this.#pool.execute(`
      INSERT INTO matrix_principals (
        principal_kind, principal_id, mxid, created_at
      ) VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE mxid = VALUES(mxid)
    `, [record.principalKind, record.principalId, record.mxid, sqlDate(record.createdAt)]);
  }

  public async isMatrixTransactionComplete(transactionId: string): Promise<boolean> {
    const [rows] = await this.#pool.execute<RowDataPacket[]>(`
      SELECT 1 AS completed FROM matrix_transactions WHERE transaction_id = ?
    `, [transactionId]);
    return rows.length === 1;
  }

  public async completeMatrixTransaction(
    transactionId: string,
    now: string
  ): Promise<boolean> {
    const [result] = await this.#pool.execute<ResultSetHeader>(`
      INSERT IGNORE INTO matrix_transactions (transaction_id, completed_at)
      VALUES (?, ?)
    `, [transactionId, sqlDate(now)]);
    return result.affectedRows === 1;
  }

  async #agentAggregate(
    connection: PoolConnection,
    agentId: string,
    placementId: string
  ): Promise<AgentAggregate> {
    const [rows] = await connection.execute<AgentAggregateRow[]>(`
      ${AGENT_AGGREGATE_SELECT}
      WHERE a.id = ? AND p.id = ?
      LIMIT 1
    `, [agentId, placementId]);
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Agent aggregate is missing: ${agentId}/${placementId}`);
    }
    return agentAggregate(row);
  }

  async #transaction<T>(operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.#pool.getConnection();
    try {
      await connection.beginTransaction();
      const value = await operation(connection);
      await connection.commit();
      return value;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

function authorizationRecord(row: AuthorizationRow): AuthorizationTransactionRecord {
  return {
    state: row.state,
    nonce: row.nonce,
    codeVerifier: row.code_verifier,
    returnTo: row.return_to,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at.toISOString() })
  };
}

function humanRecord(row: HumanRow): HumanRecord {
  return {
    id: row.id,
    issuer: row.oauth_issuer,
    subject: row.oauth_subject,
    displayName: row.display_name,
    status: row.status,
    isAdmin: Boolean(row.is_admin),
    metadata: parseMetadata(row.identity_metadata),
    createdAt: row.created_at.toISOString()
  };
}

function pairingRecord(row: PairingRow): PairingRecord {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    verifierChallenge: row.verifier_hash,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    ...(row.oidc_device_code === null ? {} : { oidcDeviceCode: row.oidc_device_code }),
    ...(row.poll_interval_ms === null
      ? {}
      : { pollIntervalMilliseconds: row.poll_interval_ms }),
    ...(row.last_polled_at === null
      ? {}
      : { lastPolledAt: row.last_polled_at.toISOString() }),
    ...(row.approved_human_id === null
      ? {}
      : { approvedHumanId: row.approved_human_id }),
    ...(row.redeemed_at === null ? {} : { redeemedAt: row.redeemed_at.toISOString() })
  };
}

function placementRecord(row: PlacementRow): PlacementRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    deviceId: row.device_id,
    state: row.state,
    generation: row.generation,
    createdAt: row.created_at.toISOString(),
    ...(row.activated_at === null ? {} : { activatedAt: row.activated_at.toISOString() }),
    ...(row.superseded_at === null
      ? {}
      : { supersededAt: row.superseded_at.toISOString() })
  };
}

function enrollmentRecord(row: EnrollmentRow): EnrollmentGrantRecord {
  if (typeof row.credential_id !== "string" || row.credential_id === "") {
    throw new Error(`Agent enrollment credential is missing: ${row.id}`);
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    deviceId: row.device_id,
    placementId: row.placement_id,
    credentialId: row.credential_id,
    verifierChallenge: row.verifier_hash,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    ...(row.redeemed_at === null ? {} : { redeemedAt: row.redeemed_at.toISOString() })
  };
}

function agentAggregate(row: AgentAggregateRow): AgentAggregate {
  return {
    agent: {
      id: row.agent_id,
      name: row.agent_name,
      ownerHumanId: row.owner_human_id,
      operatorHumanId: row.operator_human_id,
      status: row.agent_status,
      createdAt: row.agent_created_at.toISOString(),
      ...(row.agent_suspended_at === null
        ? {}
        : { suspendedAt: row.agent_suspended_at.toISOString() })
    },
    placement: {
      id: row.placement_id,
      agentId: row.agent_id,
      deviceId: row.placement_device_id,
      state: row.placement_state,
      generation: row.placement_generation,
      createdAt: row.placement_created_at.toISOString(),
      ...(row.placement_activated_at === null
        ? {}
        : { activatedAt: row.placement_activated_at.toISOString() }),
      ...(row.placement_superseded_at === null
        ? {}
        : { supersededAt: row.placement_superseded_at.toISOString() })
    },
    owner: prefixedHumanRecord(row, "owner"),
    operator: prefixedHumanRecord(row, "operator"),
    credentialStatus: row.credential_status ?? "pending"
  };
}

function prefixedHumanRecord(
  row: AgentAggregateRow,
  prefix: "owner" | "operator"
): HumanRecord {
  return {
    id: prefix === "owner" ? row.owner_human_id : row.operator_human_id,
    issuer: prefix === "owner" ? row.owner_issuer : row.operator_issuer,
    subject: prefix === "owner" ? row.owner_subject : row.operator_subject,
    displayName: prefix === "owner" ? row.owner_display_name : row.operator_display_name,
    status: prefix === "owner" ? row.owner_status : row.operator_status,
    isAdmin: Boolean(prefix === "owner" ? row.owner_is_admin : row.operator_is_admin),
    metadata: parseMetadata(prefix === "owner" ? row.owner_metadata : row.operator_metadata),
    createdAt: (prefix === "owner" ? row.owner_created_at : row.operator_created_at)
      .toISOString()
  };
}

function roomRecord(row: RoomRow): RoomRecord {
  if (
    typeof row.name !== "string" || row.name === "" ||
    typeof row.matrix_room_id !== "string" || row.matrix_room_id === "" ||
    typeof row.created_by_human_id !== "string" || row.created_by_human_id === ""
  ) {
    throw new Error(`Room metadata is incomplete: ${row.id}`);
  }
  return {
    id: row.id,
    name: row.name,
    matrixRoomId: row.matrix_room_id,
    visibility: row.visibility,
    createdByHumanId: row.created_by_human_id,
    headSequence: Number(row.head_sequence),
    createdAt: row.created_at.toISOString()
  };
}

function roomMembershipRecord(
  row: RoomMembershipRow | RoomListRow
): RoomMembershipRecord {
  const roomId = "room_id" in row ? row.room_id : row.id;
  const humanId = "human_id" in row ? row.human_id : row.membership_human_id;
  const role = "role" in row ? row.role : row.membership_role;
  const canInvite = "can_invite" in row ? row.can_invite : row.membership_can_invite;
  const status = "status" in row ? row.status : row.membership_status;
  const invitedBy = "invited_by_human_id" in row
    ? row.invited_by_human_id
    : row.membership_invited_by_human_id;
  const createdAt = "human_id" in row ? row.created_at : row.membership_created_at;
  const leftAt = "left_at" in row ? row.left_at : row.membership_left_at;
  if (humanId === null || role === null || canInvite === null || status === null || createdAt === null) {
    throw new Error(`Room membership metadata is incomplete: ${roomId}`);
  }
  return {
    roomId,
    humanId,
    role,
    canInvite: Boolean(canInvite),
    status,
    createdAt: createdAt.toISOString(),
    ...(invitedBy === null ? {} : { invitedByHumanId: invitedBy }),
    ...(leftAt === null ? {} : { leftAt: leftAt.toISOString() })
  };
}

function membershipValues(membership: RoomMembershipRecord): readonly unknown[] {
  return [
    membership.roomId,
    membership.humanId,
    membership.role,
    membership.canInvite,
    membership.status,
    membership.invitedByHumanId ?? null,
    sqlDate(membership.createdAt),
    membership.leftAt === undefined ? null : sqlDate(membership.leftAt)
  ];
}

function agentRoomBindingRecord(row: AgentRoomBindingRow): AgentRoomBindingRecord {
  if (
    typeof row.created_by_human_id !== "string" || row.created_by_human_id === "" ||
    !(row.updated_at instanceof Date)
  ) {
    throw new Error(`Agent Room binding metadata is incomplete: ${row.id}`);
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    roomId: row.room_id,
    wakeMode: row.wake_mode,
    createdByHumanId: row.created_by_human_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.deactivated_at === null
      ? {}
      : { deactivatedAt: row.deactivated_at.toISOString() })
  };
}

function bindingValues(binding: AgentRoomBindingRecord): readonly unknown[] {
  return [
    binding.id,
    binding.agentId,
    binding.roomId,
    binding.wakeMode,
    binding.createdByHumanId,
    binding.status,
    sqlDate(binding.createdAt),
    sqlDate(binding.updatedAt),
    binding.deactivatedAt === undefined ? null : sqlDate(binding.deactivatedAt)
  ];
}

async function updateBinding(
  connection: PoolConnection,
  binding: AgentRoomBindingRecord
): Promise<void> {
  await connection.execute(`
    UPDATE agent_room_bindings
    SET id = ?, wake_mode = ?, created_by_human_id = ?, status = ?,
        created_at = ?, updated_at = ?, deactivated_at = ?
    WHERE agent_id = ? AND room_id = ?
  `, [
    binding.id,
    binding.wakeMode,
    binding.createdByHumanId,
    binding.status,
    sqlDate(binding.createdAt),
    sqlDate(binding.updatedAt),
    binding.deactivatedAt === undefined ? null : sqlDate(binding.deactivatedAt),
    binding.agentId,
    binding.roomId
  ]);
}

function storedRoomEventRecord(row: StoredRoomEventRow): StoredRoomEventRecord {
  if (
    typeof row.matrix_event_id !== "string" || row.matrix_event_id === "" ||
    typeof row.event_json !== "string" || row.event_json === ""
  ) {
    throw new Error(`Room event metadata is incomplete: ${row.room_id}/${row.room_sequence}`);
  }
  const event = eventEnvelopeSchema.parse(JSON.parse(row.event_json) as unknown);
  return {
    roomId: row.room_id,
    sequence: Number(row.room_sequence),
    matrixEventId: row.matrix_event_id,
    event,
    ...(row.retained_until === null
      ? {}
      : { retainedUntil: row.retained_until.toISOString() })
  };
}

function matrixPrincipalRecord(row: MatrixPrincipalRow): MatrixPrincipalRecord {
  return {
    principalKind: row.principal_kind,
    principalId: row.principal_id,
    mxid: row.mxid,
    createdAt: row.created_at.toISOString()
  };
}

function parseMetadata(value: string | null): Readonly<Record<string, string>> {
  if (value === null) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    ));
  } catch {
    return {};
  }
}

function sqlDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid timestamp passed to MySQL repository");
  }
  return date;
}
