import {
  deviceCredentialIssuanceSchema,
  devicePairingCreateResponseSchema,
  devicePairingStatusSchema,
  type DeviceCredentialIssuance,
  type DevicePairingCreateRequest,
  type DevicePairingCreateResponse,
  type DevicePairingStatus
} from "../../protocol.js";
import { ServerHttpTransport, type ServerClientOptions } from "./transport.js";

export type PairingServerClientOptions = Omit<ServerClientOptions, "credential">;

export class PairingServerClient {
  readonly #transport: ServerHttpTransport;

  public constructor(options: PairingServerClientOptions) {
    this.#transport = new ServerHttpTransport({
      serverUrl: options.serverUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.timeoutMilliseconds === undefined
        ? {}
        : { timeoutMilliseconds: options.timeoutMilliseconds })
    });
  }

  public createPairing(
    request: DevicePairingCreateRequest
  ): Promise<DevicePairingCreateResponse> {
    return this.#transport.json("/api/device-pairings", {
      method: "POST",
      body: JSON.stringify(request)
    }, devicePairingCreateResponseSchema.parse);
  }

  public createBrowserPairing(
    request: DevicePairingCreateRequest
  ): Promise<DevicePairingCreateResponse> {
    return this.#transport.json("/api/device-pairings/browser", {
      method: "POST",
      body: JSON.stringify(request)
    }, devicePairingCreateResponseSchema.parse);
  }

  public pairingStatus(pairingId: string): Promise<DevicePairingStatus> {
    return this.#transport.json(
      `/api/device-pairings/${encodeURIComponent(pairingId)}`,
      { method: "GET" },
      devicePairingStatusSchema.parse
    );
  }

  public redeemPairing(
    pairingId: string,
    deviceId: string,
    verifier: string
  ): Promise<DeviceCredentialIssuance> {
    return this.#transport.json(
      `/api/device-pairings/${encodeURIComponent(pairingId)}/redeem`,
      { method: "POST", body: JSON.stringify({ deviceId, verifier }) },
      deviceCredentialIssuanceSchema.parse
    );
  }
}
