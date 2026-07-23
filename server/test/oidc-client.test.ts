import assert from "node:assert/strict";
import test from "node:test";

import {
  exportJWK,
  generateKeyPair,
  SignJWT
} from "jose";

import { OidcClient } from "../src/adapter/oidc/client.js";

test("OIDC client uses discovery, PKCE and validates a signed ID token", async () => {
  const issuer = "http://127.0.0.1:7777";
  const clientId = "rollerskate";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const idToken = await new SignJWT({
    nonce: "expected-nonce",
    name: "Example Human",
    email: "human@example.com"
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(clientId)
    .setSubject("subject-123")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  let tokenRequestBody = "";
  let tokenAuthorization = "";
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"]
      });
    }
    if (url === `${issuer}/token`) {
      tokenRequestBody = init?.body?.toString() ?? "";
      tokenAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ id_token: idToken });
    }
    if (url === `${issuer}/jwks`) {
      return Response.json({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] });
    }
    return new Response("not found", { status: 404 });
  };
  const client = new OidcClient({
    issuer,
    clientId,
    clientSecret: "client-secret",
    redirectUri: "http://127.0.0.1:3000/auth/callback",
    fetch: fakeFetch
  });

  const authorization = new URL(await client.authorizationUrl({
    state: "state-123",
    nonce: "expected-nonce",
    codeVerifier: "verifier-123"
  }));
  assert.equal(authorization.searchParams.get("state"), "state-123");
  assert.equal(authorization.searchParams.get("nonce"), "expected-nonce");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.notEqual(authorization.searchParams.get("code_challenge"), "verifier-123");

  const identity = await client.exchangeAuthorizationCode({
    code: "authorization-code",
    nonce: "expected-nonce",
    codeVerifier: "verifier-123"
  });
  assert.deepEqual(identity, {
    issuer,
    subject: "subject-123",
    displayName: "Example Human",
    metadata: { email: "human@example.com" }
  });
  assert.equal(new URLSearchParams(tokenRequestBody).get("code_verifier"), "verifier-123");
  assert.equal(
    tokenAuthorization,
    `Basic ${Buffer.from("rollerskate:client-secret").toString("base64")}`
  );

  await assert.rejects(
    () => client.exchangeAuthorizationCode({
      code: "authorization-code",
      nonce: "wrong-nonce",
      codeVerifier: "verifier-123"
    }),
    /nonce does not match/
  );
});

test("OIDC public client supports POST authorization and secretless code exchange", async () => {
  const issuer = "https://identity.example.com/api/discov/client-id";
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  let authorizationBody = "";
  let tokenBody = "";
  let tokenAuthorization: string | null = null;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === discoveryUrl) {
      return Response.json({
        issuer,
        authorization_endpoint: "https://identity.example.com/api/auth",
        token_endpoint: "https://identity.example.com/api/token",
        jwks_uri: "https://identity.example.com/api/pubkeys?client_id=client-id",
        id_token_signing_alg_values_supported: ["RS256"]
      });
    }
    if (url === "https://identity.example.com/api/auth") {
      authorizationBody = init?.body?.toString() ?? "";
      return new Response(null, {
        status: 302,
        headers: { location: "/login?session=example" }
      });
    }
    if (url === "https://identity.example.com/api/token") {
      tokenBody = init?.body?.toString() ?? "";
      tokenAuthorization = new Headers(init?.headers).get("authorization");
      return Response.json({});
    }
    return new Response("not found", { status: 404 });
  };
  const client = new OidcClient({
    issuer,
    discoveryUrl,
    clientId: "client-id",
    authorizationRequestMethod: "post",
    redirectUri: "http://localhost:4100/auth/callback",
    fetch: fakeFetch
  });

  const authorization = new URL(await client.authorizationUrl({
    state: "state",
    nonce: "nonce",
    codeVerifier: "verifier"
  }));
  assert.equal(authorization.href.startsWith("https://identity.example.com/login?"), true);
  assert.equal(authorization.searchParams.get("client_id"), "client-id");
  assert.equal(
    authorization.searchParams.get("redirect_uri"),
    "http://localhost:4100/auth/callback"
  );
  assert.equal(new URLSearchParams(authorizationBody).get("code_challenge_method"), "S256");

  await assert.rejects(
    () => client.exchangeAuthorizationCode({
      code: "code",
      nonce: "nonce",
      codeVerifier: "verifier"
    }),
    /did not include an id_token/
  );
  assert.equal(new URLSearchParams(tokenBody).get("client_id"), "client-id");
  assert.equal(tokenAuthorization, null);
});

test("OIDC client uses the discovered Device Authorization Grant", async () => {
  const issuer = "https://identity.example.com";
  const clientId = "rollerskate-device";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const idToken = await new SignJWT({ name: "Device Human" })
    .setProtectedHeader({ alg: "RS256", kid: "device-key" })
    .setIssuer(issuer)
    .setAudience(clientId)
    .setSubject("device-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  let pollCount = 0;
  const requestBodies: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        device_authorization_endpoint: `${issuer}/device`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        grant_types_supported: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
        id_token_signing_alg_values_supported: ["RS256"]
      });
    }
    if (url === `${issuer}/device`) {
      requestBodies.push(init?.body?.toString() ?? "");
      return Response.json({
        device_code: "provider-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: `${issuer}/activate`,
        verification_uri_complete: `${issuer}/activate?user_code=ABCD-EFGH`,
        expires_in: 600,
        interval: 2
      });
    }
    if (url === `${issuer}/token`) {
      requestBodies.push(init?.body?.toString() ?? "");
      pollCount += 1;
      if (pollCount === 1) {
        return Response.json({ error: "authorization_pending" }, { status: 428 });
      }
      if (pollCount === 2) {
        return Response.json({ error: "slow_down" }, { status: 400 });
      }
      return Response.json({ id_token: idToken, token_type: "Bearer" });
    }
    if (url === `${issuer}/jwks`) {
      return Response.json({ keys: [{ ...jwk, kid: "device-key", alg: "RS256" }] });
    }
    return new Response("not found", { status: 404 });
  };
  const client = new OidcClient({
    issuer,
    clientId,
    redirectUri: "http://localhost:4100/auth/callback",
    fetch: fakeFetch
  });

  assert.deepEqual(await client.beginDeviceAuthorization(), {
    deviceCode: "provider-device-code",
    userCode: "ABCD-EFGH",
    verificationUri: `${issuer}/activate?user_code=ABCD-EFGH`,
    expiresInSeconds: 600,
    pollIntervalSeconds: 2
  });
  assert.deepEqual(await client.pollDeviceAuthorization("provider-device-code"), {
    status: "pending"
  });
  assert.deepEqual(await client.pollDeviceAuthorization("provider-device-code"), {
    status: "slow_down"
  });
  assert.deepEqual(await client.pollDeviceAuthorization("provider-device-code"), {
    status: "complete",
    identity: {
      issuer,
      subject: "device-subject",
      displayName: "Device Human",
      metadata: {}
    }
  });
  for (const body of requestBodies) {
    assert.equal(new URLSearchParams(body).get("client_id"), clientId);
  }
  assert.equal(
    new URLSearchParams(requestBodies[1]).get("grant_type"),
    "urn:ietf:params:oauth:grant-type:device_code"
  );
});

test("OIDC discovery rejects symmetric-only ID token algorithms", async () => {
  const client = new OidcClient({
    issuer: "http://localhost:7777",
    clientId: "rollerskate",
    clientSecret: "secret",
    redirectUri: "http://localhost:3000/auth/callback",
    fetch: async () => Response.json({
      issuer: "http://localhost:7777",
      authorization_endpoint: "http://localhost:7777/authorize",
      token_endpoint: "http://localhost:7777/token",
      jwks_uri: "http://localhost:7777/jwks",
      id_token_signing_alg_values_supported: ["HS256"]
    })
  });

  await assert.rejects(
    () => client.authorizationUrl({ state: "state", nonce: "nonce", codeVerifier: "proof" }),
    /does not advertise a supported asymmetric/
  );
});
