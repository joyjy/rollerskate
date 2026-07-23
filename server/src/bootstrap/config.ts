import { readFileSync } from "node:fs";

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
}

export interface ServerRuntimeConfig extends ServerConfig {
  readonly publicUrl: string;
  readonly databaseUrl: string;
  readonly oidc: {
    readonly issuer: string;
    readonly discoveryUrl: string;
    readonly clientId: string;
    readonly clientSecret?: string;
    readonly authorizationRequestMethod: "get" | "post";
    readonly redirectUri: string;
  };
  readonly matrix: {
    readonly homeserverUrl: string;
    readonly serverName: string;
    readonly asToken: string;
    readonly hsToken: string;
  };
}

export function loadServerConfig(
  environment: NodeJS.ProcessEnv = process.env
): ServerConfig {
  const host = environment.ROLLERSKATE_SERVER_HOST?.trim() || "127.0.0.1";
  const rawPort = environment.ROLLERSKATE_SERVER_PORT?.trim() || "4100";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("ROLLERSKATE_SERVER_PORT must be an integer from 0 to 65535");
  }
  return { host, port };
}

export function loadServerRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env
): ServerRuntimeConfig {
  const server = loadServerConfig(environment);
  const publicUrl = requireUrl(environment, "ROLLERSKATE_PUBLIC_URL");
  const configuredDiscoveryUrl = optionalValue(
    environment,
    "ROLLERSKATE_OIDC_DISCOVERY_URL"
  );
  const discoveryUrl = configuredDiscoveryUrl === undefined
    ? undefined
    : parseUrl(configuredDiscoveryUrl, "ROLLERSKATE_OIDC_DISCOVERY_URL");
  const configuredIssuer = optionalValue(environment, "ROLLERSKATE_OIDC_ISSUER");
  const issuer = configuredIssuer === undefined
    ? issuerFromDiscoveryUrl(discoveryUrl)
    : parseUrl(configuredIssuer, "ROLLERSKATE_OIDC_ISSUER");
  const clientSecret = optionalValue(environment, "ROLLERSKATE_OIDC_CLIENT_SECRET");
  const homeserverUrl = requireUrl(
    environment,
    "ROLLERSKATE_MATRIX_HOMESERVER_URL",
    environment.ROLLERSKATE_ALLOW_INSECURE_MATRIX_HTTP === "true"
  );
  return {
    ...server,
    publicUrl: publicUrl.origin,
    databaseUrl: requireValue(environment, "ROLLERSKATE_DATABASE_URL"),
    oidc: {
      issuer: issuer.href.replace(/\/$/, ""),
      discoveryUrl: discoveryUrl?.href ?? new URL(
        `${issuer.href.replace(/\/$/, "")}/.well-known/openid-configuration`
      ).href,
      clientId: requireValue(environment, "ROLLERSKATE_OIDC_CLIENT_ID"),
      ...(clientSecret === undefined ? {} : { clientSecret }),
      authorizationRequestMethod: authorizationRequestMethod(environment),
      redirectUri: new URL("/auth/callback", publicUrl).href
    },
    matrix: {
      homeserverUrl: homeserverUrl.origin,
      serverName: requireValue(environment, "ROLLERSKATE_MATRIX_SERVER_NAME"),
      asToken: requireSecret(environment, "ROLLERSKATE_MATRIX_AS_TOKEN"),
      hsToken: requireSecret(environment, "ROLLERSKATE_MATRIX_HS_TOKEN")
    }
  };
}

function requireSecret(environment: NodeJS.ProcessEnv, name: string): string {
  const fileName = optionalValue(environment, `${name}_FILE`);
  if (fileName === undefined) return requireValue(environment, name);
  const value = readFileSync(fileName, "utf8").trim();
  if (value === "") throw new Error(`${name}_FILE is empty`);
  return value;
}

function requireValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalValue(
  environment: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function requireUrl(
  environment: NodeJS.ProcessEnv,
  name: string,
  allowInsecureHttp = false
): URL {
  return parseUrl(requireValue(environment, name), name, allowInsecureHttp);
}

function parseUrl(value: string, name: string, allowInsecureHttp = false): URL {
  const url = new URL(value);
  const isLocalhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    url.protocol !== "https:" &&
    (url.protocol !== "http:" || (!isLocalhost && !allowInsecureHttp))
  ) {
    throw new Error(`${name} must use https outside localhost`);
  }
  return url;
}

function issuerFromDiscoveryUrl(discoveryUrl: URL | undefined): URL {
  if (discoveryUrl === undefined) {
    throw new Error(
      "ROLLERSKATE_OIDC_ISSUER or ROLLERSKATE_OIDC_DISCOVERY_URL is required"
    );
  }
  const suffix = "/.well-known/openid-configuration";
  if (!discoveryUrl.pathname.endsWith(suffix)) {
    throw new Error(
      `ROLLERSKATE_OIDC_DISCOVERY_URL must end with ${suffix}`
    );
  }
  const issuer = new URL(discoveryUrl);
  issuer.pathname = issuer.pathname.slice(0, -suffix.length);
  return issuer;
}

function authorizationRequestMethod(
  environment: NodeJS.ProcessEnv
): "get" | "post" {
  const method = optionalValue(
    environment,
    "ROLLERSKATE_OIDC_AUTHORIZATION_REQUEST_METHOD"
  )?.toLowerCase() ?? "get";
  if (method !== "get" && method !== "post") {
    throw new Error(
      "ROLLERSKATE_OIDC_AUTHORIZATION_REQUEST_METHOD must be get or post"
    );
  }
  return method;
}
