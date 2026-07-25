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
  statusDevice
} from "../src/application/device/server-control.js";

test.skip("v0.4 Server Device login persists only a private credential", async () => {
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

test.skip("v0.4 Server Device login reuses the saved server", async () => {
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
