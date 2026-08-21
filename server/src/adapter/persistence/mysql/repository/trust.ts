import { randomUUID } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";

import type {
  AuthorizationTransactionRecord,
  BffSessionRecord,
  HumanRecord,
  OidcIdentity
} from "../../../../application/model.js";
import type { TrustRepository } from "../../../../modules/trust/repository.js";
import type {
  AuthorizationRow,
  DeploymentBootstrapRow,
  HumanRow,
  SessionRow
} from "./support.js";
import {
  authorizationRecord,
  humanRecord,
  sqlDate,
  withTransaction
} from "./support.js";

export class MysqlTrustRepository implements TrustRepository {
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
    return withTransaction(this.#pool, async (connection) => {
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
    return withTransaction(this.#pool, async (connection) => {
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
    await withTransaction(this.#pool, async (connection) => {
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

}
