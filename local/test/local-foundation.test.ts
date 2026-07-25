import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  addLocalAgent,
  configureLocalAgent,
  localRuntimeSnapshot,
  renameLocalAgent,
  resumeLocalAgent,
  suspendLocalAgent
} from "../src/application/agent/control.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";

test("default runtime is global and ignores a repo-local legacy runtime", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-global-runtime-"));
  try {
    mkdirSync(join(repo, ".rollerskate"));
    const paths = runtimePaths(repo);
    assert.equal(paths.runtimeDirectory, join(homedir(), ".rollerskate"));
    assert.equal(paths.workspace, join(homedir(), ".rollerskate", "workspace"));
    assert.notEqual(paths.runtimeDirectory, join(repo, ".rollerskate"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("fresh local runtime bootstraps infrastructure and durable Agent lifecycle", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-local-foundation-repo-"));
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-local-foundation-runtime-"));
  const at = sequence(
    "2026-07-23T10:00:00.000Z",
    "2026-07-23T10:01:00.000Z",
    "2026-07-23T10:02:00.000Z",
    "2026-07-23T10:03:00.000Z",
    "2026-07-23T10:04:00.000Z"
  );
  try {
    const options = { runtimeDirectory: runtime, now: at };
    const fresh = localRuntimeSnapshot(repo, options);
    assert.match(fresh.foundation.deviceId, /^dev_.+-7/);
    assert.match(fresh.foundation.topicId, /^top_.+-7/);
    assert.match(fresh.foundation.owner.principalId, /^prn_.+-7/);
    assert.equal(fresh.foundation.owner.kind, "owner");
    assert.equal(fresh.foundation.topicHandle, "local");
    assert.equal(fresh.foundation.workspacePath, join(realpathSync(runtime), "workspace"));
    assert.equal(existsSync(fresh.foundation.workspacePath), true);
    assert.deepEqual(fresh.agents, []);

    const alice = addLocalAgent(repo, "Alice", "codex", options);
    const bob = addLocalAgent(repo, "bob-2", "claude-code", options);
    const claude = addLocalAgent(
      repo,
      "claude",
      "claude-code",
      options,
      ["--model", "claude-sonnet-4-6"]
    );
    const kimi = addLocalAgent(repo, "kimi", "kimi-code", options);
    assert.match(alice.principalId, /^prn_.+-7/);
    assert.match(bob.principalId, /^prn_.+-7/);
    assert.notEqual(alice.principalId, fresh.foundation.owner.principalId);
    assert.equal(alice.handle, "Alice");
    assert.equal(bob.client, "claude-code");
    assert.deepEqual(claude.executionConfig.launchArgs, [
      "--model",
      "claude-sonnet-4-6"
    ]);
    assert.equal(kimi.client, "kimi-code");
    assert.deepEqual(
      configureLocalAgent(repo, kimi.principalId, ["--model", "kimi-code/k2.5"], options)
        .executionConfig.launchArgs,
      ["--model", "kimi-code/k2.5"]
    );
    assert.throws(() => addLocalAgent(repo, "alice", "codex", options), /already in use/);
    assert.throws(() => addLocalAgent(repo, "bad handle", "codex", options), /1-32/);

    const renamed = renameLocalAgent(repo, alice.principalId, "helper", options);
    assert.equal(renamed.handle, "helper");
    assert.equal(suspendLocalAgent(repo, alice.principalId, options).status, "suspended");
    assert.equal(resumeLocalAgent(repo, alice.principalId, options).status, "active");

    const restarted = localRuntimeSnapshot(repo, options);
    assert.equal(restarted.foundation.deviceId, fresh.foundation.deviceId);
    assert.equal(restarted.foundation.topicId, fresh.foundation.topicId);
    assert.equal(restarted.foundation.owner.principalId, fresh.foundation.owner.principalId);
    assert.deepEqual(restarted.agents.map(({ handle, status }) => ({ handle, status })), [
      { handle: "bob-2", status: "active" },
      { handle: "claude", status: "active" },
      { handle: "helper", status: "active" },
      { handle: "kimi", status: "active" }
    ]);

    const database = new DatabaseSync(join(runtime, "runtime.db"), { readOnly: true });
    try {
      assert.equal((database.prepare(`
        SELECT COUNT(*) AS count FROM local_foundation
      `).get() as { count: number }).count, 1);
      assert.equal((database.prepare(`
        SELECT COUNT(*) AS count FROM agents
      `).get() as { count: number }).count, 4);
      assert.equal((database.prepare(`
        SELECT owner_handle FROM local_foundation WHERE singleton = 1
      `).get() as { owner_handle: string }).owner_handle, "owner");
    } finally {
      database.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

function sequence(...timestamps: string[]): () => Date {
  let offset = 0;
  return () => new Date(timestamps[Math.min(offset++, timestamps.length - 1)]!);
}
