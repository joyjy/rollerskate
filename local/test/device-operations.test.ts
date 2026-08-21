import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import {
  loginDevice,
  logoutDevice,
  startBrowserDeviceLogin,
  statusDevice
} from "../src/application/device/server-control.js";
import { ConsoleDeviceLogin } from "../src/entrypoints/console/network-api.js";

test("v0.4 Server Device login persists only a private credential", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-device-"));
  const runtimeDirectory = join(repo, "runtime");
  const serverUrl = "http://127.0.0.1:7777";
  const credential = "credential-id.this-is-a-device-secret-that-must-remain-private";
  let pairedDeviceId = "";
  let revoked = false;
  const requests: Array<{ readonly path: string; readonly authorization: string | null }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    requests.push({ path: url.pathname, authorization: headers.get("authorization") });
    if (url.pathname === "/api/device-pairings" && init?.method === "POST") {
      const body = JSON.parse(init.body?.toString() ?? "{}") as { deviceId: string };
      pairedDeviceId = body.deviceId;
      return Response.json({
        pairingId: "pairing-id",
        deviceId: pairedDeviceId,
        verificationUri: `${serverUrl}/device/pair/pairing-id`,
        userCode: "ABCD-EFGH",
        expiresAt: "2099-01-01T00:00:00.000Z",
        pollIntervalMilliseconds: 100
      }, { status: 201 });
    }
    if (url.pathname === "/api/device-pairings/pairing-id") {
      return Response.json({
        pairingId: "pairing-id",
        deviceId: pairedDeviceId,
        status: "approved",
        expiresAt: "2099-01-01T00:00:00.000Z",
        pollIntervalMilliseconds: 500
      });
    }
    if (url.pathname === "/api/device-pairings/pairing-id/redeem") {
      return Response.json({
        credentialId: "credential-id",
        credential,
        device: summary(pairedDeviceId)
      });
    }
    if (url.pathname === "/api/device" && init?.method === "GET") {
      if (revoked || headers.get("authorization") !== `Bearer ${credential}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json(summary(pairedDeviceId));
    }
    if (url.pathname === "/api/device" && init?.method === "DELETE") {
      assert.equal(headers.get("authorization"), `Bearer ${credential}`);
      revoked = true;
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  let output = "";
  try {
    const login = await loginDevice(repo, {
      serverUrl
    }, {
      runtimeDirectory,
      fetch: fakeFetch,
      now: () => new Date("2026-07-19T09:00:00.000Z"),
      sleep: async () => {},
      write: (text) => {
        output += text;
      }
    });
    assert.equal(login.summary.id, pairedDeviceId);
    assert.match(output, /Open this URL to approve the device/);
    assert.match(output, /Enter code: ABCD-EFGH/);
    assert.doesNotMatch(output, /this-is-a-device-secret/);

    const paths = runtimePaths(repo, runtimeDirectory);
    assert.equal(lstatSync(paths.deviceCredential).mode & 0o777, 0o600);
    assert.match(readFileSync(paths.deviceCredential, "utf8"), /this-is-a-device-secret/);
    assert.doesNotMatch(readFileSync(paths.database).toString("utf8"), /this-is-a-device-secret/);

    const afterRestart = await statusDevice(repo, {
      runtimeDirectory,
      fetch: fakeFetch,
      now: () => new Date("2026-07-19T09:05:00.000Z")
    });
    assert.equal(afterRestart.summary.human.displayName, "Example Human");
    assert.equal(afterRestart.metadata.status, "active");

    await logoutDevice(repo, {
      runtimeDirectory,
      fetch: fakeFetch,
      now: () => new Date("2026-07-19T09:10:00.000Z")
    });
    assert.equal(revoked, true);
    assert.equal(lstatOrUndefined(paths.deviceCredential), undefined);
    await assert.rejects(
      () => statusDevice(repo, { runtimeDirectory, fetch: fakeFetch }),
      /not paired/
    );
    assert.ok(requests.some((request) => request.authorization === `Bearer ${credential}`));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("v0.4 Server Device login reuses the saved server", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-device-resume-"));
  const runtimeDirectory = join(repo, "runtime");
  const serverUrl = "http://127.0.0.1:7777";
  try {
    await assert.rejects(() => loginDevice(repo, {
      serverUrl
    }, {
      runtimeDirectory,
      fetch: async () => Response.json({ error: "unavailable" }, { status: 503 })
    }));

    let requestedOrigin = "";
    await assert.rejects(() => loginDevice(repo, {}, {
      runtimeDirectory,
      fetch: async (input, init) => {
        requestedOrigin = new URL(input instanceof Request ? input.url : input.toString()).origin;
        assert.notEqual(
          (JSON.parse(init?.body?.toString() ?? "{}") as { deviceName?: string }).deviceName,
          "codex-client"
        );
        return Response.json({ error: "unavailable" }, { status: 503 });
      }
    }));

    assert.equal(requestedOrigin, serverUrl);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Console browser login replaces a stale Server binding only after approval", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-device-reconnect-"));
  const runtimeDirectory = join(repo, "runtime");
  const oldServerUrl = "http://127.0.0.1:7777";
  const newServerUrl = "http://127.0.0.1:4100";
  let deviceId = "";
  let retryNextBrowserStatus = false;
  let transientStatusFailures = 0;
  const approvedFetch = (serverUrl: string, credential: string): typeof fetch =>
    async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/api/device-pairings" ||
        url.pathname === "/api/device-pairings/browser") {
        if (url.pathname.endsWith("/browser")) retryNextBrowserStatus = true;
        deviceId = (JSON.parse(init?.body?.toString() ?? "{}") as { deviceId: string }).deviceId;
        return Response.json({
          pairingId: "pairing-id",
          deviceId,
          verificationUri: `${serverUrl}/device/pair/pairing-id`,
          expiresAt: "2099-01-01T00:00:00.000Z",
          pollIntervalMilliseconds: 100
        }, { status: 201 });
      }
      if (url.pathname === "/api/device-pairings/pairing-id") {
        if (retryNextBrowserStatus) {
          retryNextBrowserStatus = false;
          transientStatusFailures += 1;
          throw new TypeError("fetch failed");
        }
        return Response.json({
          pairingId: "pairing-id",
          deviceId,
          status: "approved",
          expiresAt: "2099-01-01T00:00:00.000Z"
        });
      }
      if (url.pathname.endsWith("/redeem")) {
        return Response.json({
          credentialId: `${credential}-id`,
          credential,
          device: summary(deviceId)
        });
      }
      if (url.pathname === "/api/device") return Response.json(summary(deviceId));
      return Response.json({ error: "not_found" }, { status: 404 });
    };
  try {
    await loginDevice(repo, { serverUrl: oldServerUrl }, {
      runtimeDirectory,
      fetch: approvedFetch(oldServerUrl, "old-credential-secret-value-1234567890"),
      now: () => new Date("2026-07-27T01:00:00.000Z"),
      sleep: async () => {}
    });
    const reconnect = await startBrowserDeviceLogin(repo, {
      serverUrl: newServerUrl,
      replaceExisting: true
    }, {
      runtimeDirectory,
      fetch: approvedFetch(newServerUrl, "new-credential-secret-value-1234567890"),
      now: () => new Date("2026-07-27T01:05:00.000Z"),
      sleep: async () => {}
    });
    assert.equal(reconnect.verificationUri, `${newServerUrl}/device/pair/pairing-id`);
    const connected = await reconnect.completion;
    assert.equal(transientStatusFailures, 1);
    assert.equal(connected.metadata.serverUrl, newServerUrl);
    const credentialFile = readFileSync(runtimePaths(repo, runtimeDirectory).deviceCredential, "utf8");
    assert.match(credentialFile, /new-credential-secret-value-1234567890/);
    assert.doesNotMatch(credentialFile, /old-credential-secret-value-1234567890/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Console browser login admits only one pairing start at a time", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-console-device-login-"));
  const runtimeDirectory = join(repo, "runtime");
  const serverUrl = "http://127.0.0.1:4100";
  let releasePairing!: (response: Response) => void;
  const pairingResponse = new Promise<Response>((resolvePromise) => {
    releasePairing = resolvePromise;
  });
  let pairingRequests = 0;
  const deviceLogin = new ConsoleDeviceLogin({
    repoRoot: repo,
    runtimeDirectory,
    port: 0,
    signal: new AbortController().signal,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/api/device-pairings/browser" && init?.method === "POST") {
        pairingRequests += 1;
        return pairingResponse;
      }
      if (url.pathname === "/api/device-pairings/pairing-id") {
        return Response.json({
          pairingId: "pairing-id",
          deviceId: "device-id",
          status: "cancelled",
          expiresAt: "2099-01-01T00:00:00.000Z"
        });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }
  });
  try {
    const first = deviceLogin.start(serverUrl, false);
    assert.equal(pairingRequests, 1);
    await assert.rejects(
      () => deviceLogin.start(serverUrl, false),
      /already waiting for OIDC approval/
    );
    assert.equal(pairingRequests, 1);
    releasePairing(Response.json({
      pairingId: "pairing-id",
      deviceId: "device-id",
      verificationUri: `${serverUrl}/device/pair/pairing-id`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      pollIntervalMilliseconds: 100
    }, { status: 201 }));
    assert.equal((await first).status, "pending");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function summary(deviceId: string): object {
  return {
    id: deviceId,
    name: "Test Laptop",
    status: "active",
    createdAt: "2026-07-19T09:00:00.000Z",
    human: {
      id: "human-id",
      displayName: "Example Human",
      isAdmin: false
    }
  };
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
