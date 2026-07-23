#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { createBffServer } from "../bootstrap/http-server.js";
import { TrustService } from "../modules/trust/service.js";
import { AgentService } from "../modules/agent/service.js";
import { AgentRoomService } from "../application/room/agent-service.js";
import { DeviceService } from "../modules/device/service.js";
import { DeviceLoginService } from "../application/device/login-service.js";
import { RoomEventBroker } from "../modules/event/broker.js";
import { EventService } from "../modules/event/service.js";
import { RoomService } from "../application/room/service.js";
import { HttpMatrixApplicationServiceGateway } from "../adapter/matrix/application-service.js";
import { connectMysql, connectMysqlPool } from "../adapter/persistence/mysql/connection.js";
import { migrateServerDatabase } from "../adapter/persistence/mysql/migrations.js";
import { MysqlRepository } from "../adapter/persistence/mysql/repository.js";
import { OidcClient } from "../adapter/oidc/client.js";
import { credentialService } from "../adapter/security/credentials.js";

const CLIENT_ID = "rollerskate-smoke";
const CLIENT_SECRET = "rollerskate-smoke-secret";
const SUBJECTS = ["phase7-owner", "phase7-member-b", "phase7-member-c"] as const;

interface PendingCode {
  readonly nonce: string;
  readonly challenge: string;
  readonly subject: string;
}

interface PendingDeviceCode {
  readonly subject: string;
  approved: boolean;
}

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const databaseUrl = required(environment, "ROLLERSKATE_DATABASE_URL");
  const homeserverUrl = required(environment, "ROLLERSKATE_MATRIX_HOMESERVER_URL");
  const serverName = required(environment, "ROLLERSKATE_MATRIX_SERVER_NAME");
  const asToken = required(environment, "ROLLERSKATE_MATRIX_AS_TOKEN");
  const hsToken = required(environment, "ROLLERSKATE_MATRIX_HS_TOKEN");
  const serverPort = parsePort(environment.ROLLERSKATE_SERVER_PORT ?? "13000");
  const oidcPort = parsePort(environment.ROLLERSKATE_OIDC_SMOKE_PORT ?? "13001");
  const publicUrl = `http://127.0.0.1:${serverPort}`;
  const issuer = `http://127.0.0.1:${oidcPort}`;

  const migrationConnection = await connectMysql(databaseUrl);
  try {
    await migrateServerDatabase(migrationConnection);
  } finally {
    await migrationConnection.end();
  }

  const oidcProvider = await createSmokeOidcProvider(issuer, `${publicUrl}/auth/callback`);
  const pool = connectMysqlPool(databaseUrl);
  const repository = new MysqlRepository(pool);
  const trust = new TrustService(repository, {
    issuer,
    publicUrl
  });
  const devices = new DeviceService(repository, { publicUrl, credentials: credentialService });
  const agents = new AgentService(repository, { credentials: credentialService });
  const oidc = new OidcClient({
    issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: `${publicUrl}/auth/callback`
  });
  const deviceLogin = new DeviceLoginService(repository, trust, oidc);
  const matrix = new HttpMatrixApplicationServiceGateway({
    homeserverUrl,
    serverName,
    asToken
  });
  const rooms = new RoomService(repository, matrix);
  const agentRooms = new AgentRoomService(repository, matrix);
  const events = new EventService(repository, new RoomEventBroker());
  const app = createBffServer({
    trust,
    devices,
    deviceLogin,
    agents,
    oidc,
    rooms,
    agentRooms,
    events,
    matrixHsToken: hsToken
  });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await Promise.all([closeServer(app), closeServer(oidcProvider)]);
    await pool.end();
  };
  try {
    await listen(oidcProvider, oidcPort);
    await listen(app, serverPort);
    process.stdout.write(`${JSON.stringify({
      status: "ready",
      serverUrl: publicUrl,
      oidcIssuer: issuer,
      subjects: SUBJECTS
    })}\n`);
    await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM")]);
  } finally {
    await close();
  }
}

async function createSmokeOidcProvider(issuer: string, redirectUri: string): Promise<Server> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "rollerskate-smoke-key", alg: "RS256" };
  const codes = new Map<string, PendingCode>();
  const deviceCodes = new Map<string, PendingDeviceCode>();
  let authorizationCount = 0;
  return createServer((request, response) => {
    void routeOidc(request, response, {
      issuer,
      redirectUri,
      privateKey,
      jwk,
      codes,
      deviceCodes,
      nextSubject: () => SUBJECTS[authorizationCount++]
    }).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: message(error) }));
    });
  });
}

async function routeOidc(
  request: IncomingMessage,
  response: ServerResponse,
  state: {
    readonly issuer: string;
    readonly redirectUri: string;
    readonly privateKey: SigningKey;
    readonly jwk: Readonly<Record<string, unknown>>;
    readonly codes: Map<string, PendingCode>;
    readonly deviceCodes: Map<string, PendingDeviceCode>;
    readonly nextSubject: () => string | undefined;
  }
): Promise<void> {
  const url = new URL(request.url ?? "/", state.issuer);
  if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
    json(response, 200, {
      issuer: state.issuer,
      authorization_endpoint: `${state.issuer}/authorize`,
      device_authorization_endpoint: `${state.issuer}/device`,
      token_endpoint: `${state.issuer}/token`,
      jwks_uri: `${state.issuer}/jwks`,
      grant_types_supported: [
        "authorization_code",
        "urn:ietf:params:oauth:grant-type:device_code"
      ],
      id_token_signing_alg_values_supported: ["RS256"]
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/jwks") {
    json(response, 200, { keys: [state.jwk] });
    return;
  }
  if (request.method === "GET" && url.pathname === "/authorize") {
    assertEqual(url.searchParams.get("response_type"), "code", "response_type");
    assertEqual(url.searchParams.get("client_id"), CLIENT_ID, "client_id");
    assertEqual(url.searchParams.get("redirect_uri"), state.redirectUri, "redirect_uri");
    assertEqual(url.searchParams.get("code_challenge_method"), "S256", "code_challenge_method");
    const subject = state.nextSubject();
    if (subject === undefined) throw new Error("smoke provider supports exactly three logins");
    const code = randomUUID();
    state.codes.set(code, {
      nonce: requiredQuery(url, "nonce"),
      challenge: requiredQuery(url, "code_challenge"),
      subject
    });
    const callback = new URL(state.redirectUri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", requiredQuery(url, "state"));
    response.writeHead(302, { location: callback.href, "cache-control": "no-store" });
    response.end();
    return;
  }
  if (request.method === "POST" && url.pathname === "/device") {
    assertEqual(
      request.headers.authorization,
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      "client authentication"
    );
    const body = new URLSearchParams(await readBody(request));
    assertEqual(body.get("scope"), "openid profile", "scope");
    const subject = state.nextSubject();
    if (subject === undefined) throw new Error("smoke provider supports exactly three logins");
    const deviceCode = randomUUID();
    const userCode = randomUUID().slice(0, 8).toUpperCase();
    state.deviceCodes.set(deviceCode, { subject, approved: false });
    json(response, 200, {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${state.issuer}/activate`,
      verification_uri_complete:
        `${state.issuer}/activate?device_code=${encodeURIComponent(deviceCode)}`,
      expires_in: 600,
      interval: 1
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/activate") {
    const pending = state.deviceCodes.get(requiredQuery(url, "device_code"));
    if (pending === undefined) throw new Error("device code is invalid or expired");
    pending.approved = true;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><p>Device approved. Return to the terminal.</p>");
    return;
  }
  if (request.method === "POST" && url.pathname === "/token") {
    assertEqual(
      request.headers.authorization,
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      "client authentication"
    );
    const body = new URLSearchParams(await readBody(request));
    if (body.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
      const deviceCode = body.get("device_code") ?? "";
      const pending = state.deviceCodes.get(deviceCode);
      if (pending === undefined) {
        json(response, 400, { error: "expired_token" });
        return;
      }
      if (!pending.approved) {
        json(response, 400, { error: "authorization_pending" });
        return;
      }
      state.deviceCodes.delete(deviceCode);
      const idToken = await signSmokeIdToken(
        state,
        pending.subject
      );
      json(response, 200, { id_token: idToken, token_type: "Bearer" });
      return;
    }
    assertEqual(body.get("grant_type"), "authorization_code", "grant_type");
    assertEqual(body.get("redirect_uri"), state.redirectUri, "redirect_uri");
    const code = body.get("code") ?? "";
    const pending = state.codes.get(code);
    if (pending === undefined) throw new Error("authorization code is invalid or already used");
    state.codes.delete(code);
    assertEqual(
      createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url"),
      pending.challenge,
      "PKCE verifier"
    );
    const idToken = await signSmokeIdToken(state, pending.subject, pending.nonce);
    json(response, 200, { id_token: idToken, token_type: "Bearer" });
    return;
  }
  json(response, 404, { error: "not_found" });
}

async function signSmokeIdToken(
  state: {
    readonly issuer: string;
    readonly privateKey: SigningKey;
  },
  subject: string,
  nonce?: string
): Promise<string> {
  return new SignJWT({
    ...(nonce === undefined ? {} : { nonce }),
    name: `Smoke ${subject}`,
    email: `${subject}@rollerskate.test`
  })
    .setProtectedHeader({ alg: "RS256", kid: "rollerskate-smoke-key" })
    .setIssuer(state.issuer)
    .setAudience(CLIENT_ID)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(state.privateKey);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error("request body exceeds 64 KiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value === "") throw new Error(`${name} is required`);
  return value;
}

function assertEqual(actual: unknown, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`${label} is invalid`);
}

async function listen(server: Server, port: number): Promise<void> {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) =>
    error === undefined ? resolve() : reject(error)));
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("smoke ports must be integers from 1 to 65535");
  }
  return port;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main();
