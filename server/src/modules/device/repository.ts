import type {
  DeviceAuthenticationRecord,
  PairingRecord,
  RedeemPairingInput,
  RedeemPairingResult
} from "./model.js";

export type PairingRedeemFailure =
  | "not_found"
  | "not_approved"
  | "expired"
  | "already_redeemed"
  | "device_owner_mismatch"
  | "device_mismatch"
  | "verifier_mismatch";

export type PairingRedeemOutcome =
  | { readonly ok: true; readonly value: RedeemPairingResult }
  | { readonly ok: false; readonly reason: PairingRedeemFailure };

export interface DeviceRepository {
  putPairing(record: PairingRecord): Promise<void>;
  getPairing(id: string, now: string): Promise<PairingRecord | undefined>;
  claimPairingAuthorizationPoll(
    id: string,
    now: string
  ): Promise<PairingRecord | undefined>;
  updatePairingPollInterval(id: string, milliseconds: number): Promise<void>;
  finishPairingAuthorization(id: string, status: "expired" | "cancelled"): Promise<void>;
  approvePairing(id: string, humanId: string, now: string): Promise<boolean>;
  redeemPairing(input: RedeemPairingInput): Promise<PairingRedeemOutcome>;
  getDeviceAuthentication(
    credentialId: string,
    now: string
  ): Promise<DeviceAuthenticationRecord | undefined>;
  revokeDeviceCredential(credentialId: string, now: string): Promise<boolean>;
}
