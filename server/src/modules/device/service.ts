import { randomUUID } from "node:crypto";

import type {
  DeviceCredentialIssuance,
  DevicePairingCreateRequest,
  DevicePairingCreateResponse,
  DevicePairingStatus,
  DeviceSummary
} from "@rollerskate/protocol";

import { ServerError } from "../shared/error.js";
import type { CredentialService } from "../shared/credentials.js";
import type { HumanRecord } from "../trust/model.js";
import type {
  DeviceAuthenticationRecord,
  PairingRecord
} from "./model.js";
import { toDeviceSummary } from "./model.js";
import {
  parseOpaqueCredential,
  sha256Base64Url
} from "../shared/opaque-credential.js";
import { addMilliseconds, now, type ClockOptions } from "../shared/time.js";
import type { DeviceRepository } from "./repository.js";

const PAIRING_TTL_MILLISECONDS = 10 * 60 * 1_000;
const POLL_INTERVAL_MILLISECONDS = 1_000;

export interface DeviceServiceOptions extends ClockOptions {
  readonly publicUrl: string;
  readonly credentials: CredentialService;
}

export class DeviceService {
  readonly #repository: DeviceRepository;
  readonly #options: DeviceServiceOptions;

  public constructor(repository: DeviceRepository, options: DeviceServiceOptions) {
    this.#repository = repository;
    this.#options = { ...options, publicUrl: new URL(options.publicUrl).origin };
  }

  public async createPairing(
    request: DevicePairingCreateRequest
  ): Promise<DevicePairingCreateResponse> {
    const timestamp = now(this.#options);
    const pairing: PairingRecord = {
      id: randomUUID(),
      deviceId: request.deviceId,
      deviceName: request.deviceName,
      verifierChallenge: request.verifierChallenge,
      status: "pending",
      expiresAt: addMilliseconds(timestamp, PAIRING_TTL_MILLISECONDS),
      createdAt: timestamp
    };
    await this.#repository.putPairing(pairing);
    return {
      pairingId: pairing.id,
      deviceId: pairing.deviceId,
      verificationUri: `${this.#options.publicUrl}/device/pair/${encodeURIComponent(pairing.id)}`,
      expiresAt: pairing.expiresAt,
      pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS
    };
  }

  public async getPairingStatus(pairingId: string): Promise<DevicePairingStatus> {
    const pairing = await this.#repository.getPairing(pairingId, now(this.#options));
    if (pairing === undefined) {
      throw new ServerError("pairing_not_found", 404, "pairing was not found");
    }
    return {
      pairingId: pairing.id,
      deviceId: pairing.deviceId,
      status: pairing.status,
      expiresAt: pairing.expiresAt
    };
  }

  public async approvePairing(pairingId: string, human: HumanRecord): Promise<void> {
    const approved = await this.#repository.approvePairing(
      pairingId,
      human.id,
      now(this.#options)
    );
    if (!approved) {
      throw new ServerError(
        "pairing_not_approvable",
        409,
        "pairing is missing, expired or no longer pending"
      );
    }
  }

  public async redeemPairing(
    pairingId: string,
    deviceId: string,
    verifier: string
  ): Promise<DeviceCredentialIssuance> {
    const secret = this.#options.credentials.generateSecret();
    const credentialId = randomUUID();
    const timestamp = now(this.#options);
    const outcome = await this.#repository.redeemPairing({
      pairingId,
      deviceId,
      verifierChallenge: sha256Base64Url(verifier),
      credential: {
        id: credentialId,
        deviceId,
        secretHash: await this.#options.credentials.hashSecret(secret),
        status: "active",
        createdAt: timestamp
      },
      now: timestamp
    });
    if (!outcome.ok) {
      const status = outcome.reason === "not_found" ? 404
        : outcome.reason === "not_approved" ? 425
        : 409;
      throw new ServerError(
        `pairing_${outcome.reason}`,
        status,
        `pairing redemption failed: ${outcome.reason}`
      );
    }
    return {
      credentialId,
      credential: `${credentialId}.${secret}`,
      device: toDeviceSummary(outcome.value.device, outcome.value.human)
    };
  }

  public async authenticateDevice(
    token: string | undefined
  ): Promise<DeviceAuthenticationRecord> {
    const parsed = parseOpaqueCredential(token);
    if (parsed === undefined) {
      throw new ServerError("unauthorized", 401, "device credential is required");
    }
    const authentication = await this.#repository.getDeviceAuthentication(
      parsed.id,
      now(this.#options)
    );
    if (
      authentication === undefined ||
      !await this.#options.credentials.verifySecret(
        parsed.secret,
        authentication.credential.secretHash
      )
    ) {
      throw new ServerError("unauthorized", 401, "device credential is invalid");
    }
    return authentication;
  }

  public deviceSummary(authentication: DeviceAuthenticationRecord): DeviceSummary {
    return toDeviceSummary(authentication.device, authentication.human);
  }

  public async revokeDevice(authentication: DeviceAuthenticationRecord): Promise<void> {
    const revoked = await this.#repository.revokeDeviceCredential(
      authentication.credential.id,
      now(this.#options)
    );
    if (!revoked) {
      throw new ServerError("credential_not_active", 409, "credential is not active");
    }
  }
}
