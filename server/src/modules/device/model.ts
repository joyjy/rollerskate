import type { DeviceSummary } from "@rollerskate/protocol";

import type { HumanRecord } from "../trust/model.js";

export interface PairingRecord {
  readonly id: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly verifierChallenge: string;
  readonly status: "pending" | "approved" | "redeemed" | "expired" | "cancelled";
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly oidcDeviceCode?: string;
  readonly pollIntervalMilliseconds?: number;
  readonly lastPolledAt?: string;
  readonly approvedHumanId?: string;
  readonly redeemedAt?: string;
}

export interface DeviceRecord {
  readonly id: string;
  readonly humanId: string;
  readonly name: string;
  readonly status: "active" | "revoked";
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface DeviceCredentialRecord {
  readonly id: string;
  readonly deviceId: string;
  readonly secretHash: string;
  readonly status: "active" | "revoked" | "expired";
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
}

export interface DeviceAuthenticationRecord {
  readonly credential: DeviceCredentialRecord;
  readonly device: DeviceRecord;
  readonly human: HumanRecord;
}

export interface RedeemPairingInput {
  readonly pairingId: string;
  readonly deviceId: string;
  readonly verifierChallenge: string;
  readonly credential: DeviceCredentialRecord;
  readonly now: string;
}

export interface RedeemPairingResult {
  readonly device: DeviceRecord;
  readonly human: HumanRecord;
  readonly credential: DeviceCredentialRecord;
}

export function toDeviceSummary(
  device: DeviceRecord,
  human: HumanRecord
): DeviceSummary {
  return {
    id: device.id,
    name: device.name,
    status: device.status,
    createdAt: device.createdAt,
    ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }),
    human: {
      id: human.id,
      displayName: human.displayName,
      isAdmin: human.isAdmin
    }
  };
}
