import { createHash } from "node:crypto";

import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify
} from "jose";

import type { OidcIdentity } from "../../modules/trust/model.js";
import type {
  DeviceAuthorizationPoll,
  DeviceAuthorizationStart,
  OidcProvider
} from "../../modules/trust/oidc.js";

export type {
  DeviceOidcProvider,
  OidcProvider,
  WebOidcProvider
} from "../../modules/trust/oidc.js";

const SECURE_ID_TOKEN_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512"
] as const;

export interface OidcClientOptions {
  readonly issuer: string;
  readonly discoveryUrl?: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly authorizationRequestMethod?: "get" | "post";
  readonly redirectUri: string;
  readonly fetch?: typeof fetch;
}

interface OidcDiscoveryDocument {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly device_authorization_endpoint?: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly grant_types_supported?: readonly string[];
  readonly id_token_signing_alg_values_supported?: readonly string[];
}

interface TokenResponse {
  readonly id_token?: unknown;
  readonly access_token?: unknown;
  readonly token_type?: unknown;
  readonly error?: unknown;
}

interface DeviceAuthorizationResponse {
  readonly device_code?: unknown;
  readonly user_code?: unknown;
  readonly verification_uri?: unknown;
  readonly verification_uri_complete?: unknown;
  readonly expires_in?: unknown;
  readonly interval?: unknown;
}

export class OidcClient implements OidcProvider {
  readonly #options: OidcClientOptions;
  readonly #fetch: typeof fetch;
  #discovery?: OidcDiscoveryDocument;

  public constructor(options: OidcClientOptions) {
    this.#options = {
      ...options,
      issuer: normalizeIssuer(options.issuer),
      redirectUri: new URL(options.redirectUri).href
    };
    this.#fetch = options.fetch ?? fetch;
  }

  public async authorizationUrl(input: {
    readonly state: string;
    readonly nonce: string;
    readonly codeVerifier: string;
  }): Promise<string> {
    const discovery = await this.#discover();
    const parameters = new URLSearchParams({
      response_type: "code",
      client_id: this.#options.clientId,
      redirect_uri: this.#options.redirectUri,
      scope: "openid profile",
      state: input.state,
      nonce: input.nonce,
      code_challenge: sha256Base64Url(input.codeVerifier),
      code_challenge_method: "S256"
    });
    if ((this.#options.authorizationRequestMethod ?? "get") === "get") {
      const url = new URL(discovery.authorization_endpoint);
      url.search = parameters.toString();
      return url.href;
    }
    const response = await this.#fetch(discovery.authorization_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "x-requested-with": "XMLHttpRequest"
      },
      body: parameters,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok && (response.status < 300 || response.status >= 400)) {
      throw new Error(`OIDC authorization endpoint returned HTTP ${response.status}`);
    }
    const location = response.headers.get("location");
    if (location === null || location.trim() === "") {
      throw new Error("OIDC authorization endpoint did not return a location");
    }
    const authorization = new URL(location, discovery.authorization_endpoint);
    const redirect = new URL(this.#options.redirectUri);
    if (
      authorization.origin !== redirect.origin ||
      authorization.pathname !== redirect.pathname
    ) {
      authorization.searchParams.set("client_id", this.#options.clientId);
      authorization.searchParams.set("redirect_uri", this.#options.redirectUri);
    }
    return authorization.href;
  }

  public async exchangeAuthorizationCode(input: {
    readonly code: string;
    readonly nonce: string;
    readonly codeVerifier: string;
  }): Promise<OidcIdentity> {
    const discovery = await this.#discover();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: this.#options.redirectUri,
      code_verifier: input.codeVerifier
    });
    if (this.#options.clientSecret === undefined) {
      body.set("client_id", this.#options.clientId);
    }
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    });
    if (this.#options.clientSecret !== undefined) {
      headers.set(
        "authorization",
        `Basic ${Buffer.from(
          `${this.#options.clientId}:${this.#options.clientSecret}`,
          "utf8"
        ).toString("base64")}`
      );
    }
    const response = await this.#fetch(discovery.token_endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      throw new Error(`OIDC token endpoint returned HTTP ${response.status}`);
    }
    const token = await readJson<TokenResponse>(response, "OIDC token response");
    return this.#identityFromToken(discovery, token, input.nonce);
  }

  public async beginDeviceAuthorization(): Promise<DeviceAuthorizationStart> {
    const discovery = await this.#discover();
    const endpoint = discovery.device_authorization_endpoint;
    if (endpoint === undefined) {
      throw new Error("OIDC discovery did not include device_authorization_endpoint");
    }
    if (!discovery.grant_types_supported?.includes(
      "urn:ietf:params:oauth:grant-type:device_code"
    )) {
      throw new Error("OIDC discovery does not advertise the device_code grant");
    }
    const body = new URLSearchParams({ scope: "openid profile" });
    const headers = this.#clientAuthentication(body);
    const response = await this.#fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      throw new Error(`OIDC device authorization endpoint returned HTTP ${response.status}`);
    }
    const value = await readJson<DeviceAuthorizationResponse>(
      response,
      "OIDC device authorization response"
    );
    const deviceCode = requireNonEmptyString(value.device_code, "device_code");
    const userCode = requireNonEmptyString(value.user_code, "user_code");
    const verificationUri = requireUrl(
      typeof value.verification_uri_complete === "string"
        ? value.verification_uri_complete
        : value.verification_uri,
      "verification_uri"
    );
    const expiresInSeconds = requirePositiveInteger(value.expires_in, "expires_in");
    const pollIntervalSeconds = value.interval === undefined
      ? 5
      : requirePositiveInteger(value.interval, "interval");
    return {
      deviceCode,
      userCode,
      verificationUri,
      expiresInSeconds,
      pollIntervalSeconds
    };
  }

  public async pollDeviceAuthorization(
    deviceCode: string
  ): Promise<DeviceAuthorizationPoll> {
    const discovery = await this.#discover();
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode
    });
    const headers = this.#clientAuthentication(body);
    const response = await this.#fetch(discovery.token_endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000)
    });
    const token = await readJson<TokenResponse>(response, "OIDC device token response");
    if (response.ok) {
      return {
        status: "complete",
        identity: await this.#identityFromToken(discovery, token)
      };
    }
    const status = typeof token.error === "string" ? {
      authorization_pending: "pending",
      slow_down: "slow_down",
      access_denied: "denied",
      expired_token: "expired"
    }[token.error] : undefined;
    if (status === undefined) {
      throw new Error(
        typeof token.error === "string"
          ? `OIDC device token endpoint returned ${token.error}`
          : `OIDC token endpoint returned HTTP ${response.status}`
      );
    }
    return { status } as DeviceAuthorizationPoll;
  }

  async #identityFromToken(
    discovery: OidcDiscoveryDocument,
    token: TokenResponse,
    expectedNonce?: string
  ): Promise<OidcIdentity> {
    if (typeof token.id_token !== "string" || token.id_token === "") {
      throw new Error("OIDC token response did not include an id_token");
    }

    const algorithms = secureAlgorithms(discovery);
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri), {
      [customFetch]: (url, options) => this.#fetch(url, options)
    });
    const { payload } = await jwtVerify(token.id_token, jwks, {
      issuer: this.#options.issuer,
      audience: this.#options.clientId,
      algorithms
    });
    if (expectedNonce !== undefined && payload.nonce !== expectedNonce) {
      throw new Error("OIDC id_token nonce does not match the authorization request");
    }
    if (typeof payload.sub !== "string" || payload.sub.trim() === "") {
      throw new Error("OIDC id_token subject is missing");
    }
    const displayName = firstNonEmptyString(
      payload.name,
      payload.preferred_username,
      payload.email,
      payload.sub
    );
    return {
      issuer: this.#options.issuer,
      subject: payload.sub,
      displayName,
      metadata: stringClaims(payload, [
        "email",
        "preferred_username",
        "tenant",
        "organization"
      ])
    };
  }

  #clientAuthentication(body: URLSearchParams): Headers {
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    });
    if (this.#options.clientSecret === undefined) {
      body.set("client_id", this.#options.clientId);
    } else {
      headers.set(
        "authorization",
        `Basic ${Buffer.from(
          `${this.#options.clientId}:${this.#options.clientSecret}`,
          "utf8"
        ).toString("base64")}`
      );
    }
    return headers;
  }

  async #discover(): Promise<OidcDiscoveryDocument> {
    if (this.#discovery !== undefined) {
      return this.#discovery;
    }
    const discoveryUrl = new URL(
      this.#options.discoveryUrl ??
      `${this.#options.issuer}/.well-known/openid-configuration`
    );
    const response = await this.#fetch(discoveryUrl, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      throw new Error(`OIDC discovery returned HTTP ${response.status}`);
    }
    const value = await readJson<Partial<OidcDiscoveryDocument>>(
      response,
      "OIDC discovery document"
    );
    const issuer = requireUrl(value.issuer, "issuer");
    if (normalizeIssuer(issuer) !== this.#options.issuer) {
      throw new Error("OIDC discovery issuer does not match configured issuer");
    }
    const discovery: OidcDiscoveryDocument = {
      issuer: this.#options.issuer,
      authorization_endpoint: requireUrl(
        value.authorization_endpoint,
        "authorization_endpoint"
      ),
      ...(value.device_authorization_endpoint === undefined
        ? {}
        : { device_authorization_endpoint: requireUrl(
            value.device_authorization_endpoint,
            "device_authorization_endpoint"
          ) }),
      token_endpoint: requireUrl(value.token_endpoint, "token_endpoint"),
      jwks_uri: requireUrl(value.jwks_uri, "jwks_uri"),
      ...(Array.isArray(value.grant_types_supported)
        ? { grant_types_supported: value.grant_types_supported.filter(
            (item): item is string => typeof item === "string"
          ) }
        : {}),
      ...(Array.isArray(value.id_token_signing_alg_values_supported)
        ? { id_token_signing_alg_values_supported:
            value.id_token_signing_alg_values_supported.filter(
              (item): item is string => typeof item === "string"
            ) }
        : {})
    };
    secureAlgorithms(discovery);
    this.#discovery = discovery;
    return discovery;
  }
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`OIDC device authorization response ${name} is missing`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`OIDC device authorization response ${name} must be positive`);
  }
  return value as number;
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > 1_048_576) {
    throw new Error(`${label} exceeds the 1 MiB limit`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 1_048_576) {
    throw new Error(`${label} exceeds the 1 MiB limit`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function secureAlgorithms(discovery: OidcDiscoveryDocument): string[] {
  const advertised = discovery.id_token_signing_alg_values_supported;
  const algorithms = advertised === undefined
    ? ["RS256"]
    : advertised.filter((algorithm) =>
        SECURE_ID_TOKEN_ALGORITHMS.includes(
          algorithm as (typeof SECURE_ID_TOKEN_ALGORITHMS)[number]
        )
      );
  if (algorithms.length === 0) {
    throw new Error("OIDC provider does not advertise a supported asymmetric id_token algorithm");
  }
  return algorithms;
}

function stringClaims(
  payload: Readonly<Record<string, unknown>>,
  names: readonly string[]
): Readonly<Record<string, string>> {
  return Object.fromEntries(names.flatMap((name) => {
    const value = payload[name];
    return typeof value === "string" && value.trim() !== ""
      ? [[name, value]]
      : [];
  }));
}

function firstNonEmptyString(...values: readonly unknown[]): string {
  const value = values.find(
    (candidate) => typeof candidate === "string" && candidate.trim() !== ""
  );
  if (typeof value !== "string") {
    throw new Error("OIDC identity has no displayable name");
  }
  return value;
}

function requireUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`OIDC discovery ${field} is missing`);
  }
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(`OIDC discovery ${field} must use https`);
  }
  return url.href;
}

function normalizeIssuer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("OIDC issuer must use https");
  }
  url.hash = "";
  url.search = "";
  return url.href.replace(/\/$/, "");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}
