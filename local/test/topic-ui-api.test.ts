import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { startUiServer } from "../src/entrypoints/console/launcher.js";
import { DeviceCredentialStore } from
  "../src/infrastructure/files/device-credential-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { bootstrapLocalFoundation } from
  "../src/infrastructure/sqlite/foundation-store.js";

test("Console publishes a Server Topic message as the paired Human", async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-topic-ui-api-"));
  const paths = runtimePaths(repoRoot, runtime);
  const foundation = bootstrapLocalFoundation(paths, "2026-07-28T08:00:00.000Z");
  new DeviceCredentialStore(paths.deviceCredential).save({
    serverUrl: "http://127.0.0.1:7777",
    deviceId: foundation.deviceId,
    credentialId: "device-credential",
    credential: "device-secret"
  });
  const requests: Array<{ authorization: string | null; body: unknown }> = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    requests.push({
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body))
    });
    return Response.json({
      eventId: "human-event-a",
      topicId: "topic-a",
      sequence: 1,
      publisher: {
        kind: "human",
        humanId: "human-a",
        displayName: "Alice",
        deviceId: foundation.deviceId
      },
      transactionId: "intent-a",
      body: "Human question",
      topicProfileRevision: 1,
      createdAt: "2026-07-28T08:00:00.000Z"
    }, { status: 201 });
  };
  const controller = new AbortController();
  const server = await startUiServer({
    repoRoot,
    runtimeDirectory: runtime,
    port: 0,
    signal: controller.signal,
    fetch: fakeFetch
  });
  const endpoint = `${new URL(server.url).origin}/api/network/topics/human-publish`;
  try {
    const rejected = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topicId: "topic-a",
        transactionId: "intent-a",
        message: "Human question"
      })
    });
    assert.equal(rejected.status, 403);

    const accepted = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Rollerskate-Request": "console"
      },
      body: JSON.stringify({
        topicId: "topic-a",
        transactionId: "intent-a",
        message: "Human question"
      })
    });
    assert.equal(accepted.status, 201);
    assert.equal((await accepted.json() as { publisher: { kind: string } }).publisher.kind, "human");
    assert.deepEqual(requests, [{
      authorization: "Bearer device-secret",
      body: { transactionId: "intent-a", body: "Human question" }
    }]);
  } finally {
    controller.abort();
    await server.close();
    rmSync(runtime, { recursive: true, force: true });
  }
});
