import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadServerConfig, loadServerRuntimeConfig } from "../src/bootstrap/config.js";
import { createBffServer } from "../src/bootstrap/http-server.js";
import {
  generateCredentialSecret,
  hashCredentialSecret,
  redactCredentialSecret,
  verifyCredentialSecret
} from "../src/adapter/security/credentials.js";

const runtimeEnvironment = {
  ROLLERSKATE_PUBLIC_URL: "http://localhost:3000",
  ROLLERSKATE_DATABASE_URL: "mysql://rollerskate:rollerskate@mysql:3306/rollerskate",
  ROLLERSKATE_OIDC_ISSUER: "https://identity.example.com",
  ROLLERSKATE_OIDC_CLIENT_ID: "rollerskate-dev",
  ROLLERSKATE_OIDC_CLIENT_SECRET: "test-secret",
  ROLLERSKATE_MATRIX_HOMESERVER_URL: "http://synapse:8008",
  ROLLERSKATE_MATRIX_SERVER_NAME: "rollerskate.test",
  ROLLERSKATE_MATRIX_AS_TOKEN: "test-as-token",
  ROLLERSKATE_MATRIX_HS_TOKEN: "test-hs-token"
} satisfies NodeJS.ProcessEnv;

test("server uses the dedicated Rollerskate development port by default", () => {
  assert.equal(loadServerConfig({}).port, 4100);
});

test("runtime config derives a public OIDC client from an explicit discovery URL", () => {
  const discoveryUrl =
    "https://identity.example.com/api/discov/client-id/.well-known/openid-configuration";
  const config = loadServerRuntimeConfig({
    ...runtimeEnvironment,
    ROLLERSKATE_OIDC_ISSUER: "",
    ROLLERSKATE_OIDC_DISCOVERY_URL: discoveryUrl,
    ROLLERSKATE_OIDC_CLIENT_SECRET: "",
    ROLLERSKATE_ALLOW_INSECURE_MATRIX_HTTP: "true"
  });

  assert.equal(
    config.oidc.issuer,
    "https://identity.example.com/api/discov/client-id"
  );
  assert.equal(config.oidc.discoveryUrl, discoveryUrl);
  assert.equal(config.oidc.clientSecret, undefined);
});

test("runtime config requires an explicit Matrix-only insecure HTTP opt-in", () => {
  assert.throws(
    () => loadServerRuntimeConfig(runtimeEnvironment),
    /ROLLERSKATE_MATRIX_HOMESERVER_URL must use https outside localhost/
  );

  const config = loadServerRuntimeConfig({
    ...runtimeEnvironment,
    ROLLERSKATE_ALLOW_INSECURE_MATRIX_HTTP: "true"
  });
  assert.ok(config.matrix);
  assert.equal(config.matrix.homeserverUrl, "http://synapse:8008");

  assert.throws(
    () => loadServerRuntimeConfig({
      ...runtimeEnvironment,
      ROLLERSKATE_ALLOW_INSECURE_MATRIX_HTTP: "true",
      ROLLERSKATE_OIDC_ISSUER: "http://identity.example.com"
    }),
    /ROLLERSKATE_OIDC_ISSUER must use https outside localhost/
  );
});

test("runtime config reads Matrix secrets from mounted files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rollerskate-secrets-"));
  try {
    const asTokenFile = join(directory, "matrix_as_token");
    const hsTokenFile = join(directory, "matrix_hs_token");
    await writeFile(asTokenFile, "file-as-token\n", { mode: 0o600 });
    await writeFile(hsTokenFile, "file-hs-token\n", { mode: 0o600 });
    const config = loadServerRuntimeConfig({
      ...runtimeEnvironment,
      ROLLERSKATE_ALLOW_INSECURE_MATRIX_HTTP: "true",
      ROLLERSKATE_MATRIX_AS_TOKEN: undefined,
      ROLLERSKATE_MATRIX_AS_TOKEN_FILE: asTokenFile,
      ROLLERSKATE_MATRIX_HS_TOKEN: undefined,
      ROLLERSKATE_MATRIX_HS_TOKEN_FILE: hsTokenFile
    });

    assert.ok(config.matrix);
    assert.equal(config.matrix.asToken, "file-as-token");
    assert.equal(config.matrix.hsToken, "file-hs-token");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("runtime config starts the native control plane without Matrix", () => {
  const config = loadServerRuntimeConfig({
    ROLLERSKATE_PUBLIC_URL: runtimeEnvironment.ROLLERSKATE_PUBLIC_URL,
    ROLLERSKATE_DATABASE_URL: runtimeEnvironment.ROLLERSKATE_DATABASE_URL,
    ROLLERSKATE_OIDC_ISSUER: runtimeEnvironment.ROLLERSKATE_OIDC_ISSUER,
    ROLLERSKATE_OIDC_CLIENT_ID: runtimeEnvironment.ROLLERSKATE_OIDC_CLIENT_ID
  });
  assert.equal(config.matrix, undefined);
});

test("BFF exposes a protocol-aware health endpoint", async () => {
  const server = createBffServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      service: "rollerskate-server",
      protocolVersion: 1
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("credential secrets are random, hashed at rest and redactable", async () => {
  const secret = generateCredentialSecret();
  const other = generateCredentialSecret();
  const encodedHash = await hashCredentialSecret(secret);

  assert.notEqual(secret, other);
  assert.equal(encodedHash.includes(secret), false);
  assert.equal(await verifyCredentialSecret(secret, encodedHash), true);
  assert.equal(await verifyCredentialSecret(other, encodedHash), false);
  assert.equal(redactCredentialSecret(secret), "[REDACTED]");
});
