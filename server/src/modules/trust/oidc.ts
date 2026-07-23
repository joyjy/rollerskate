import type { OidcIdentity } from "./model.js";

export interface WebOidcProvider {
  authorizationUrl(input: {
    readonly state: string;
    readonly nonce: string;
    readonly codeVerifier: string;
  }): Promise<string>;
  exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly nonce: string;
    readonly codeVerifier: string;
  }): Promise<OidcIdentity>;
}

export interface DeviceAuthorizationStart {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresInSeconds: number;
  readonly pollIntervalSeconds: number;
}

export type DeviceAuthorizationPoll =
  | { readonly status: "pending" }
  | { readonly status: "slow_down" }
  | { readonly status: "denied" }
  | { readonly status: "expired" }
  | { readonly status: "complete"; readonly identity: OidcIdentity };

export interface DeviceOidcProvider {
  beginDeviceAuthorization(): Promise<DeviceAuthorizationStart>;
  pollDeviceAuthorization(deviceCode: string): Promise<DeviceAuthorizationPoll>;
}

export type OidcProvider = WebOidcProvider & DeviceOidcProvider;
