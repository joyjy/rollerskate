import { randomUUID } from "node:crypto";

import type {
  DevicePairingCreateRequest,
  DevicePairingCreateResponse,
  DevicePairingStatus
} from "@rollerskate/protocol";

import type { DeviceRepository } from "../../modules/device/repository.js";
import type { PairingRecord } from "../../modules/device/model.js";
import { ServerError } from "../../modules/shared/error.js";
import { addMilliseconds, now, type ClockOptions } from "../../modules/shared/time.js";
import type { DeviceOidcProvider } from "../../modules/trust/oidc.js";
import type { TrustService } from "../../modules/trust/service.js";

const MAX_POLL_INTERVAL_MILLISECONDS = 60_000;
const SLOW_DOWN_MILLISECONDS = 5_000;

export class DeviceLoginService {
  readonly #repository: DeviceRepository;
  readonly #trust: TrustService;
  readonly #oidc: DeviceOidcProvider;
  readonly #options: ClockOptions;

  public constructor(
    repository: DeviceRepository,
    trust: TrustService,
    oidc: DeviceOidcProvider,
    options: ClockOptions = {}
  ) {
    this.#repository = repository;
    this.#trust = trust;
    this.#oidc = oidc;
    this.#options = options;
  }

  public async begin(
    request: DevicePairingCreateRequest
  ): Promise<DevicePairingCreateResponse> {
    const authorization = await this.#oidc.beginDeviceAuthorization();
    const timestamp = now(this.#options);
    const pollIntervalMilliseconds = Math.min(
      authorization.pollIntervalSeconds * 1_000,
      MAX_POLL_INTERVAL_MILLISECONDS
    );
    const pairing: PairingRecord = {
      id: randomUUID(),
      deviceId: request.deviceId,
      deviceName: request.deviceName,
      verifierChallenge: request.verifierChallenge,
      status: "pending",
      expiresAt: addMilliseconds(timestamp, authorization.expiresInSeconds * 1_000),
      createdAt: timestamp,
      oidcDeviceCode: authorization.deviceCode,
      pollIntervalMilliseconds
    };
    await this.#repository.putPairing(pairing);
    return {
      pairingId: pairing.id,
      deviceId: pairing.deviceId,
      verificationUri: authorization.verificationUri,
      userCode: authorization.userCode,
      expiresAt: pairing.expiresAt,
      pollIntervalMilliseconds
    };
  }

  public async status(pairingId: string): Promise<DevicePairingStatus> {
    const timestamp = now(this.#options);
    const pairing = await this.#repository.getPairing(pairingId, timestamp);
    if (pairing === undefined) {
      throw new ServerError("pairing_not_found", 404, "pairing was not found");
    }
    if (pairing.status !== "pending" || pairing.oidcDeviceCode === undefined) {
      return statusOf(pairing);
    }
    const claimed = await this.#repository.claimPairingAuthorizationPoll(
      pairingId,
      timestamp
    );
    if (claimed === undefined || claimed.oidcDeviceCode === undefined) {
      return statusOf(pairing);
    }
    const result = await this.#oidc.pollDeviceAuthorization(claimed.oidcDeviceCode);
    if (result.status === "pending") return statusOf(claimed);
    if (result.status === "slow_down") {
      const interval = Math.min(
        (claimed.pollIntervalMilliseconds ?? 5_000) + SLOW_DOWN_MILLISECONDS,
        MAX_POLL_INTERVAL_MILLISECONDS
      );
      await this.#repository.updatePairingPollInterval(pairingId, interval);
      return { ...statusOf(claimed), pollIntervalMilliseconds: interval };
    }
    if (result.status === "denied" || result.status === "expired") {
      const status = result.status === "denied" ? "cancelled" : "expired";
      await this.#repository.finishPairingAuthorization(pairingId, status);
      return { ...statusOf(claimed), status };
    }
    try {
      const human = await this.#trust.admitIdentity(result.identity, timestamp);
      const approved = await this.#repository.approvePairing(pairingId, human.id, timestamp);
      if (!approved) {
        throw new ServerError(
          "pairing_not_approvable",
          409,
          "pairing is missing, expired or no longer pending"
        );
      }
      return { ...statusOf(claimed), status: "approved" };
    } catch (error) {
      await this.#repository.finishPairingAuthorization(pairingId, "cancelled");
      throw error;
    }
  }
}

function statusOf(pairing: PairingRecord): DevicePairingStatus {
  return {
    pairingId: pairing.id,
    deviceId: pairing.deviceId,
    status: pairing.status,
    expiresAt: pairing.expiresAt,
    ...(pairing.pollIntervalMilliseconds === undefined
      ? {}
      : { pollIntervalMilliseconds: pairing.pollIntervalMilliseconds })
  };
}
