import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { doctorLocalRuntime } from "../src/application/doctor.js";
import { setupLocalRuntime } from "../src/application/runtime-config.js";

test("doctor checks local state and exact Matrix identity without exposing the token", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-app-doctor-"));
  try {
    const codex = join(repo, "codex");
    writeFileSync(codex, "fixture");
    chmodSync(codex, 0o700);
    const setup = setupLocalRuntime(repo, {
      homeserver: "https://matrix.example",
      roomId: "!room:example",
      ownerUserId: "@owner:example",
      agentUserId: "@rollerskate:example",
      matrixAccessToken: "secret-token",
      projectRoot: repo,
      codexExecutable: codex
    });
    let requests = 0;
    const result = await doctorLocalRuntime(repo, {
      fetch: async (input, init) => {
        requests += 1;
        assert.equal(
          (init?.headers as Record<string, string>).authorization,
          "Bearer secret-token"
        );
        assert.doesNotMatch(String(input), /secret-token/);
        return String(input).endsWith("/account/whoami")
          ? Response.json({
              user_id: "@rollerskate:example",
              device_id: "DEVICE-1"
            })
          : Response.json({ joined_rooms: ["!room:example"] });
      }
    });
    assert.equal(requests, 2);
    assert.equal(result.status, "ready");
    assert.equal(result.projectRoot, setup.config.projectRoot);
    assert.equal(result.schemaVersion, 31);
    assert.deepEqual(result.matrix, {
      homeserver: "https://matrix.example",
      roomId: "!room:example",
      userId: "@rollerskate:example",
      deviceId: "DEVICE-1"
    });
    assert.doesNotMatch(JSON.stringify(result), /secret-token/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
