import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  loadLocalRuntime,
  runtimePaths,
  setupLocalRuntime
} from "../src/application/runtime-config.js";

test("setup keeps all Local app state under the selected repo .rollerskate", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-app-config-"));
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
    }, "2026-07-16T10:00:00.000Z");
    const canonicalRepo = realpathSync(repo);

    assert.deepEqual(setup.paths, runtimePaths(repo));
    assert.equal(setup.paths.runtimeDirectory, join(canonicalRepo, ".rollerskate"));
    assert.equal(setup.config.projectRoot, canonicalRepo);
    assert.equal(setup.config.grantExpiresAt, "2027-07-16T10:00:00.000Z");
    assert.doesNotMatch(readFileSync(setup.paths.config, "utf8"), /secret-token/);
    assert.match(readFileSync(setup.paths.secrets, "utf8"), /secret-token/);

    const database = new DatabaseSync(setup.paths.database, { readOnly: true });
    try {
      const tables = (database.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `).all() as unknown as Array<{ name: string }>).map((row) => row.name);
      assert.ok(tables.includes("events"));
      assert.ok(tables.includes("executions"));
      assert.ok(!tables.includes("work_items"));
      assert.ok(!tables.includes("command_triggers"));
    } finally {
      database.close();
    }

    const loaded = loadLocalRuntime(repo);
    assert.equal(loaded.matrixAccessToken, "secret-token");
    assert.equal(
      loaded.paths.database,
      join(canonicalRepo, ".rollerskate", "runtime.db")
    );
    assert.equal((loaded.config.runtime.requestTimeoutMilliseconds), 35_000);

    const repeated = setupLocalRuntime(repo, {
      homeserver: "https://matrix.example",
      roomId: "!room:example",
      ownerUserId: "@owner:example",
      agentUserId: "@rollerskate:example",
      matrixAccessToken: "rotated-token",
      projectRoot: repo,
      codexExecutable: codex
    }, "2026-07-16T11:00:00.000Z");
    assert.equal(repeated.config.grantExpiresAt, setup.config.grantExpiresAt);
    assert.equal(loadLocalRuntime(repo).matrixAccessToken, "rotated-token");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("load rejects a secrets file readable by other users", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-app-secret-"));
  try {
    const codex = join(repo, "codex");
    writeFileSync(codex, "fixture");
    const setup = setupLocalRuntime(repo, {
      homeserver: "https://matrix.example",
      roomId: "!room:example",
      ownerUserId: "@owner:example",
      agentUserId: "@rollerskate:example",
      matrixAccessToken: "secret-token",
      projectRoot: repo,
      codexExecutable: codex
    });
    chmodSync(setup.paths.secrets, 0o644);
    assert.throws(
      () => loadLocalRuntime(repo),
      /must not be accessible by group or others/
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
