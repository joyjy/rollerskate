import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import type {
  DeviceAuthenticationRecord,
  DeviceRecord,
  PairingRecord,
  RedeemPairingInput
} from "../../../../application/model.js";
import type {
  DeviceRepository,
  PairingRedeemOutcome
} from "../../../../modules/device/repository.js";
import type {
  DeviceAuthenticationRow,
  DeviceRow,
  HumanRow,
  PairingRow
} from "./support.js";
import {
  humanRecord,
  pairingRecord,
  sqlDate,
  withTransaction
} from "./support.js";

export class MysqlDeviceRepository implements DeviceRepository {
  readonly #pool: Pool;

  public constructor(pool: Pool) {
    this.#pool = pool;
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
    return withTransaction(this.#pool, async (connection) => {
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
    return withTransaction(this.#pool, async (connection) => {
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
    return withTransaction(this.#pool, async (connection) => {
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
      const [deviceRows] = await connection.execute<DeviceRow[]>(`
        SELECT id, human_id, name, status, created_at, revoked_at
        FROM devices WHERE id = ? FOR UPDATE
      `, [input.deviceId]);
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
      const existingDevice = deviceRows[0];
      if (existingDevice !== undefined && existingDevice.human_id !== humanRow.id) {
        return { ok: false, reason: "device_owner_mismatch" };
      }
      const device: DeviceRecord = existingDevice === undefined
        ? {
          id: pairing.device_id,
          humanId: humanRow.id,
          name: pairing.device_name,
          status: "active",
          createdAt: input.now
        }
        : {
          id: existingDevice.id,
          humanId: existingDevice.human_id,
          name: pairing.device_name,
          status: "active",
          createdAt: existingDevice.created_at.toISOString()
        };
      let rotatedFromCredentialId: string | null = null;
      if (existingDevice === undefined) {
        await connection.execute(`
          INSERT INTO devices (id, human_id, name, status, created_at)
          VALUES (?, ?, ?, 'active', ?)
        `, [device.id, device.humanId, device.name, sqlDate(device.createdAt)]);
      } else {
        const [credentialRows] = await connection.execute<RowDataPacket[]>(`
          SELECT id FROM credential_metadata
          WHERE principal_kind = 'device' AND principal_id = ? AND status = 'active'
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE
        `, [device.id]);
        rotatedFromCredentialId = typeof credentialRows[0]?.id === "string"
          ? credentialRows[0].id
          : null;
        await connection.execute(`
          UPDATE credential_metadata
          SET status = 'revoked', revoked_at = ?
          WHERE principal_kind = 'device' AND principal_id = ? AND status = 'active'
        `, [sqlDate(input.now), device.id]);
        await connection.execute(`
          UPDATE devices
          SET name = ?, status = 'active', revoked_at = NULL
          WHERE id = ?
        `, [device.name, device.id]);
      }
      await connection.execute(`
        INSERT INTO credential_metadata (
          id, principal_kind, principal_id, secret_hash, hash_algorithm,
          status, created_at, rotated_from_credential_id
        ) VALUES (?, 'device', ?, ?, 'scrypt', 'active', ?, ?)
      `, [
        input.credential.id,
        device.id,
        input.credential.secretHash,
        sqlDate(input.credential.createdAt),
        rotatedFromCredentialId
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
    return withTransaction(this.#pool, async (connection) => {
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

}
