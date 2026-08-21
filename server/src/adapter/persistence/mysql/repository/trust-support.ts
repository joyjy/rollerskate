import type { RowDataPacket } from "mysql2/promise";

import type { AuthorizationTransactionRecord } from
  "../../../../application/model.js";

export interface AuthorizationRow extends RowDataPacket {
  state: string;
  nonce: string;
  code_verifier: string;
  return_to: string;
  expires_at: Date;
  created_at: Date;
  consumed_at: Date | null;
}

export interface DeploymentBootstrapRow extends RowDataPacket {
  admin_human_id: string | null;
}

export interface SessionRow extends RowDataPacket {
  id: string;
  human_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
  revoked_at: Date | null;
}

export function authorizationRecord(row: AuthorizationRow): AuthorizationTransactionRecord {
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
