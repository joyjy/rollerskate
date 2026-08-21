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
import { MemoryRepositoryState } from "./state.js";

export class MemoryDeviceRepository implements DeviceRepository {
  readonly #state: MemoryRepositoryState;

  public constructor(state: MemoryRepositoryState) {
    this.#state = state;
  }

  public async putPairing(record: PairingRecord): Promise<void> {
    if (this.#state.pairings.has(record.id)) {
      throw new Error(`pairing already exists: ${record.id}`);
    }
    this.#state.pairings.set(record.id, record);
  }

  public async getPairing(id: string, now: string): Promise<PairingRecord | undefined> {
    const record = this.#state.pairings.get(id);
    if (record === undefined) {
      return undefined;
    }
    if (
      (record.status === "pending" || record.status === "approved") &&
      Date.parse(record.expiresAt) <= Date.parse(now)
    ) {
      const expired: PairingRecord = { ...record, status: "expired" };
      this.#state.pairings.set(id, expired);
      return expired;
    }
    return record;
  }

  public async claimPairingAuthorizationPoll(
    id: string,
    now: string
  ): Promise<PairingRecord | undefined> {
    const record = await this.getPairing(id, now);
    if (
      record === undefined ||
      record.status !== "pending" ||
      record.oidcDeviceCode === undefined ||
      record.pollIntervalMilliseconds === undefined ||
      (record.lastPolledAt !== undefined &&
        Date.parse(record.lastPolledAt) + record.pollIntervalMilliseconds > Date.parse(now))
    ) {
      return undefined;
    }
    const claimed = { ...record, lastPolledAt: now };
    this.#state.pairings.set(id, claimed);
    return claimed;
  }

  public async updatePairingPollInterval(
    id: string,
    milliseconds: number
  ): Promise<void> {
    const record = this.#state.pairings.get(id);
    if (record?.status === "pending") {
      this.#state.pairings.set(id, { ...record, pollIntervalMilliseconds: milliseconds });
    }
  }

  public async finishPairingAuthorization(
    id: string,
    status: "expired" | "cancelled"
  ): Promise<void> {
    const record = this.#state.pairings.get(id);
    if (record?.status === "pending") {
      this.#state.pairings.set(id, { ...record, status });
    }
  }

  public async approvePairing(
    id: string,
    humanId: string,
    now: string
  ): Promise<boolean> {
    const record = await this.getPairing(id, now);
    if (record === undefined || record.status !== "pending") {
      return false;
    }
    this.#state.pairings.set(id, {
      ...record,
      status: "approved",
      approvedHumanId: humanId
    });
    return true;
  }

  public async redeemPairing(input: RedeemPairingInput): Promise<PairingRedeemOutcome> {
    const record = await this.getPairing(input.pairingId, input.now);
    if (record === undefined) {
      return { ok: false, reason: "not_found" };
    }
    if (record.status === "expired") {
      return { ok: false, reason: "expired" };
    }
    if (record.status === "redeemed") {
      return { ok: false, reason: "already_redeemed" };
    }
    if (record.status !== "approved" || record.approvedHumanId === undefined) {
      return { ok: false, reason: "not_approved" };
    }
    if (record.deviceId !== input.deviceId) {
      return { ok: false, reason: "device_mismatch" };
    }
    if (record.verifierChallenge !== input.verifierChallenge) {
      return { ok: false, reason: "verifier_mismatch" };
    }
    const human = this.#state.humans.get(record.approvedHumanId);
    if (human === undefined) {
      throw new Error(`approved Human is missing: ${record.approvedHumanId}`);
    }
    const existingDevice = this.#state.devices.get(input.deviceId);
    if (existingDevice !== undefined && existingDevice.humanId !== human.id) {
      return { ok: false, reason: "device_owner_mismatch" };
    }
    const device: DeviceRecord = existingDevice === undefined
      ? {
        id: record.deviceId,
        humanId: human.id,
        name: record.deviceName,
        status: "active",
        createdAt: input.now
      }
      : {
        id: existingDevice.id,
        humanId: existingDevice.humanId,
        name: record.deviceName,
        status: "active",
        createdAt: existingDevice.createdAt
      };
    for (const [id, credential] of this.#state.credentials) {
      if (credential.deviceId === device.id && credential.status === "active") {
        this.#state.credentials.set(id, {
          ...credential,
          status: "revoked",
          revokedAt: input.now
        });
      }
    }
    this.#state.devices.set(device.id, device);
    this.#state.credentials.set(input.credential.id, input.credential);
    this.#state.pairings.set(record.id, {
      ...record,
      status: "redeemed",
      redeemedAt: input.now
    });
    return {
      ok: true,
      value: { device, human, credential: input.credential }
    };
  }

  public async getDeviceAuthentication(
    credentialId: string,
    now: string
  ): Promise<DeviceAuthenticationRecord | undefined> {
    const credential = this.#state.credentials.get(credentialId);
    if (
      credential === undefined ||
      credential.status !== "active" ||
      credential.revokedAt !== undefined ||
      (credential.expiresAt !== undefined &&
        Date.parse(credential.expiresAt) <= Date.parse(now))
    ) {
      return undefined;
    }
    const device = this.#state.devices.get(credential.deviceId);
    const human = device === undefined ? undefined : this.#state.humans.get(device.humanId);
    return device?.status === "active" && human?.status === "active"
      ? { credential, device, human }
      : undefined;
  }

  public async revokeDeviceCredential(
    credentialId: string,
    now: string
  ): Promise<boolean> {
    const credential = this.#state.credentials.get(credentialId);
    if (credential === undefined || credential.status !== "active") {
      return false;
    }
    this.#state.credentials.set(credential.id, {
      ...credential,
      status: "revoked",
      revokedAt: now
    });
    const device = this.#state.devices.get(credential.deviceId);
    if (device !== undefined) {
      this.#state.devices.set(device.id, {
        ...device,
        status: "revoked",
        revokedAt: now
      });
    }
    return true;
  }
}
