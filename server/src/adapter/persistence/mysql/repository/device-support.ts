import type { RowDataPacket } from "mysql2/promise";

import type {
  DeviceCredentialRecord,
  DeviceRecord,
  PairingRecord
} from "../../../../application/model.js";
import type { HumanRow } from "./human-support.js";

export interface PairingRow extends RowDataPacket {
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

export interface DeviceAuthenticationRow extends HumanRow {
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

export interface DeviceRow extends RowDataPacket {
  id: string;
  human_id: string;
  name: string;
  status: DeviceRecord["status"];
  created_at: Date;
  revoked_at: Date | null;
}

export function pairingRecord(row: PairingRow): PairingRecord {
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
