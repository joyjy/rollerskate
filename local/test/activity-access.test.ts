import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  grantOwnerWideActivityAccess,
  inspectActivityAccess,
  revokeOwnerWideActivityAccess
} from "../src/application/activity/control.js";
import { queryLocalActivity } from "../src/application/activity/query.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import {
  admitOwnerWideActivityPolicy,
  type ProviderPolicyObservation
} from "../src/modules/agent/activity-policy.js";

const NOW = "2026-07-27T10:00:00.000Z";
const ALICE_SESSION = "11111111-1111-4111-8111-111111111111";
const BOB_SESSION = "22222222-2222-4222-8222-222222222222";

test("Activity access is owner-granted, bounded, redacted and revoked immediately", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-activity-repo-"));
  const runtimeDirectory = join(repo, "runtime");
  const roots = fixtureSources(repo);
  try {
    mkdirSync(runtimeDirectory, { recursive: true });
    const paths = runtimePaths(repo, runtimeDirectory);
    bootstrapLocalFoundation(paths, NOW);
    const foundation = new LocalFoundationStore(paths.database);
    const alice = foundation.addAgent("alice", "codex", NOW);
    const bob = foundation.addAgent("bob", "claude-code", NOW);
    foundation.close();
    seedSession(paths.database, alice.principalId, ALICE_SESSION, "Alice private prompt");
    seedSession(paths.database, bob.principalId, BOB_SESSION, "Bob private prompt");

    const own = queryLocalActivity(repo, alice.principalId, {
      runtimeDirectory,
      sourceRoots: roots,
      limit: 20
    });
    assert.equal(own.scope, "agent");
    assert.ok(own.records.some((record) => record.sessionId === ALICE_SESSION));
    assert.ok(!own.records.some((record) => record.sessionId === BOB_SESSION));
    assert.ok(!JSON.stringify(own).includes("sk-secret-alice-123456789"));
    assert.ok(JSON.stringify(own).includes("[REDACTED_CREDENTIAL]"));
    assert.ok(own.coverage.every((source) => source.state === "available"));

    assert.throws(() => queryLocalActivity(repo, alice.principalId, {
      runtimeDirectory,
      scope: "owner-wide",
      sourceRoots: roots
    }), /not granted/);
    const granted = grantOwnerWideActivityAccess(repo, "alice", {
      runtimeDirectory,
      now: () => new Date(NOW)
    });
    assert.equal(granted.status, "active");
    assert.equal(lstatSync(paths.activityAccess).mode & 0o777, 0o600);
    assert.deepEqual(inspectActivityAccess(repo, "alice", { runtimeDirectory }), granted);
    assert.throws(() => queryLocalActivity(repo, alice.principalId, {
      runtimeDirectory,
      scope: "owner-wide",
      sourceRoots: roots
    }), /policy receipt/);

    const ownerWide = queryLocalActivity(repo, alice.principalId, {
      runtimeDirectory,
      scope: "owner-wide",
      sourceRoots: roots,
      policyReceipt: admitOwnerWideActivityPolicy(policy("codex")),
      limit: 20
    });
    assert.ok(ownerWide.records.some((record) => record.sessionId === BOB_SESSION));
    assert.ok(ownerWide.records.some((record) => record.source === "claude-code"));
    assert.ok(ownerWide.records.some((record) => record.source === "kimi-code"));
    assert.ok(ownerWide.records.every((record) => !record.reference.includes(repo)));

    const revoked = revokeOwnerWideActivityAccess(repo, "alice", {
      runtimeDirectory,
      now: () => new Date("2026-07-27T10:01:00.000Z")
    });
    assert.equal(revoked?.status, "revoked");
    assert.throws(() => queryLocalActivity(repo, alice.principalId, {
      runtimeDirectory,
      scope: "owner-wide",
      sourceRoots: roots,
      policyReceipt: admitOwnerWideActivityPolicy(policy("codex"))
    }), /not granted/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Provider policy admission fails closed for every missing hard boundary", () => {
  for (const observation of [
    { ...policy("codex"), hook: { state: "ignored" as const, helperDigest: "a".repeat(64) } },
    { ...policy("claude-code"), controls: { permissionMode: "plan", tools: "Write" } },
    { ...policy("kimi-code"), hook: { state: "fail-open" as const,
      helperDigest: "a".repeat(64) } }
  ]) {
    assert.throws(() => admitOwnerWideActivityPolicy(observation));
  }
});

function seedSession(databasePath: string, agentId: string, sessionId: string, prompt: string): void {
  const runtime = new RuntimeStore(databasePath);
  const event = runtime.appendEvent({
    type: "agent.request",
    source: { kind: "cli" },
    agentId,
    prompt: `${prompt} sk-secret-alice-123456789`
  });
  const execution = runtime.claimDueExecutions().find((item) =>
    item.eventId === event.event.eventId)!;
  runtime.completeExecution(execution.executionId, {
    adapterId: agentId.includes("bob")
      ? "claude-code-runtime-json-v1"
      : "codex-runtime-app-server-v1",
    workspace: "/tmp",
    providerSessionId: sessionId,
    output: "completed"
  });
  runtime.close();
}

function fixtureSources(repo: string) {
  const codex = join(repo, "sources", "codex");
  const claude = join(repo, "sources", "claude");
  const kimi = join(repo, "sources", "kimi");
  mkdirSync(codex, { recursive: true });
  mkdirSync(claude, { recursive: true });
  const kimiWire = join(kimi, "wd_fixture", "session_44444444-4444-4444-8444-444444444444",
    "agents", "main");
  mkdirSync(kimiWire, { recursive: true });
  writeFileSync(join(codex, `rollout-2026-07-27-${ALICE_SESSION}.jsonl`),
    `${JSON.stringify({ message: "Alice says sk-secret-alice-123456789" })}\n`);
  writeFileSync(join(codex, `rollout-2026-07-27-${BOB_SESSION}.jsonl`),
    `${JSON.stringify({ message: "Bob owner-wide record" })}\n`);
  writeFileSync(join(claude, "55555555-5555-4555-8555-555555555555.jsonl"),
    `${JSON.stringify({ content: "Claude record", tool_output: "password=never-copy" })}\n`);
  writeFileSync(join(kimiWire, "wire.jsonl"),
    `${JSON.stringify({ text: "Kimi record", token: "never-copy" })}\n`);
  return { codex, "claude-code": claude, "kimi-code": kimi };
}

function policy(client: ProviderPolicyObservation["client"]): ProviderPolicyObservation {
  const controls = client === "codex"
    ? { sandbox: "read-only", approvalPolicy: "never", ignoreUserConfig: true }
    : client === "claude-code"
        ? { permissionMode: "plan", tools: "Read,Glob,Grep" }
        : {
            prompt: true,
            outputFormat: "stream-json",
            agentFile: "bundled-read-only",
            auto: true,
            yolo: false
          };
  return {
    client,
    controls,
    hook: { state: "enforced", helperDigest: "a".repeat(64) }
  };
}
