import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { compileRunIntent } from "../src/application/steward/admission.js";
import { startStewardRun } from "../src/application/steward/control.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { runStewardCommand } from "../src/entrypoints/cli/run.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("RunAdmissionCompiler is deterministic and fails before Event creation", () => {
  const repo = gitFixture();
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-admission-runtime-"));
  try {
    const canonicalRepo = realpathSync(repo);
    const paths = runtimePaths(repo, runtimeDirectory);
    initializeRuntimeSchema(paths.database);
    bootstrapLocalFoundation(paths, "2026-08-26T01:00:00.000Z");
    const foundation = new LocalFoundationStore(paths.database);
    const steward = foundation.addAgent("codex", "codex", "2026-08-26T01:00:00.000Z");
    const worker = foundation.addAgent("worker", "codex", "2026-08-26T01:00:00.000Z");
    foundation.close();
    const intent = {
      schemaVersion: "RunIntent@1",
      requestId: "intent-1",
      objective: "Inspect the fixture",
      acceptance: ["Report repository evidence"],
      contextRefs: ["fixture:repo"],
      workspaceRef: pathToFileURL(canonicalRepo).href,
      desiredEffect: "read",
      requestedParticipantRefs: ["agent:worker"],
      terminalEvidence: ["workspace revision"]
    } as const;
    const first = compileRunIntent(repo, intent, runtimeDirectory);
    const second = compileRunIntent(repo, intent, runtimeDirectory);
    assert.equal(first.admissionDigest, second.admissionDigest);
    assert.deepEqual(first.authority.participantAgentIds, [
      steward.principalId,
      worker.principalId
    ].sort());
    assert.deepEqual(first.authority.workspace, {
      root: canonicalRepo,
      revision: first.authority.workspace?.revision,
      access: "read",
      networkAccess: false
    });
    assert.deepEqual(compileRunIntent(repo, {
      ...intent,
      requestId: "case-insensitive-participant",
      requestedParticipantRefs: ["agent:Worker"]
    }, runtimeDirectory).authority.participantAgentIds, first.authority.participantAgentIds);
    const drift = join(canonicalRepo, "drift.txt");
    writeFileSync(drift, "changed after preflight\n");
    assert.throws(() => startStewardRun(repo, {
      requestId: "stale-preflight",
      steward: "codex",
      objective: "must not start",
      workspace: {
        root: canonicalRepo,
        access: "read",
        expectedRevision: first.authority.workspace!.revision
      },
      participantAgentIds: first.authority.participantAgentIds,
      orchestration: { mode: "steward" }
    }, runtimeDirectory), /workspace revision changed after Run admission preflight/);
    rmSync(drift);

    const runtime = new RuntimeStore(paths.database);
    assert.equal(runtime.events().length, 0);
    const intentPath = join(runtimeDirectory, "run-intent.json");
    writeFileSync(intentPath, JSON.stringify(intent));
    let output = "";
    assert.equal(runStewardCommand(
      repo,
      ["preflight", intentPath],
      { write(value) { output += value; } },
      runtimeDirectory
    ), 0);
    assert.equal(
      (JSON.parse(output) as { admissionDigest: string }).admissionDigest,
      first.admissionDigest
    );
    assert.equal(runtime.events().length, 0);
    assert.throws(() => compileRunIntent(repo, {
      ...intent,
      requestId: "bad-participant",
      requestedParticipantRefs: ["agent:missing"]
    }, runtimeDirectory), /participant ref is not active/);
    assert.throws(() => compileRunIntent(repo, {
      ...intent,
      requestId: "bad-effect",
      desiredEffect: "none"
    }, runtimeDirectory), /conflicts with desiredEffect=none/);
    assert.throws(() => compileRunIntent(repo, {
      ...intent,
      requestId: "bad-destination",
      resultDestinationRef: "destination:dst_missing"
    }, runtimeDirectory), /destination is not registered/);
    assert.equal(runtime.events().length, 0);

    output = "";
    assert.equal(runStewardCommand(
      repo,
      ["start", intentPath],
      { write(value) { output += value; } },
      runtimeDirectory
    ), 0);
    const started = JSON.parse(output) as {
      status: string;
      rootEventId: string;
      admission: { admissionDigest: string };
    };
    assert.equal(started.status, "accepted");
    assert.equal(started.admission.admissionDigest, first.admissionDigest);
    const event = runtime.event(started.rootEventId);
    assert.equal(event?.type, "agent.request");
    assert.doesNotMatch(
      event?.prompt ?? "",
      new RegExp(canonicalRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
    assert.match(event?.prompt ?? "", /Admission: workspace=read:/);
    runtime.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("RunAdmissionCompiler derives Subscription authority from the Owner registry", () => {
  const repo = gitFixture();
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-plugin-registry-runtime-"));
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    initializeRuntimeSchema(paths.database);
    bootstrapLocalFoundation(paths, "2026-08-26T01:00:00.000Z");
    const foundation = new LocalFoundationStore(paths.database);
    foundation.addAgent("codex", "codex", "2026-08-26T01:00:00.000Z");
    foundation.close();
    const intent = {
      schemaVersion: "RunIntent@1",
      requestId: "subscription-intent",
      objective: "Wait for the registered source",
      acceptance: ["Process one terminal observation"],
      contextRefs: [],
      triggerIntent: "until",
      terminalEvidence: ["linked occurrence receipt"]
    } as const;
    assert.throws(
      () => compileRunIntent(repo, intent, runtimeDirectory),
      /no Owner-registered plugin/
    );
    const pluginPath = join(repo, "poll.ts");
    writeFileSync(pluginPath, [
      "export default {",
      "kind: 'subscription.probe', id: 'fixture-poll', schemaVersion: 1,",
      "plan() { return { kind: 'http', url: 'https://status.example.test' }; },",
      "evaluate() { return { version: '1', facts: {}, terminal: 'success' }; }",
      "};"
    ].join("\n"));
    writeFileSync(paths.subscriptionPlugins, JSON.stringify({
      schemaVersion: "SubscriptionPluginRegistry@1",
      plugins: [{
        ref: "plugin:fixture-poll@1",
        pluginPath: "project:poll.ts",
        pluginId: "fixture-poll",
        workspaceRef: "project:self",
        triggerKinds: ["until"],
        allowedHttpOrigins: ["https://status.example.test"],
        allowedExecutables: []
      }]
    }));
    const compiled = compileRunIntent(repo, intent, runtimeDirectory);
    assert.deepEqual(compiled.authority.trigger, {
      allowedKinds: ["until"],
      minimumIntervalMilliseconds: 1_000,
      maximumIntervalMilliseconds: 31_536_000_000,
      pluginRefs: ["plugin:fixture-poll@1"],
      pluginPolicyDigests: {
        "plugin:fixture-poll@1": compiled.authority.trigger?.pluginPolicyDigests?.[
          "plugin:fixture-poll@1"
        ]
      },
      allowedHttpOrigins: ["https://status.example.test"],
      allowedExecutables: []
    });
    const runtime = new RuntimeStore(paths.database);
    assert.equal(runtime.events().length, 0);
    runtime.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

function gitFixture(): string {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-admission-repo-"));
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["init"]);
  git(repo, ["add", "README.md"]);
  git(repo, [
    "-c", "user.name=Rollerskate Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", "fixture"
  ]);
  return repo;
}

function git(cwd: string, arguments_: readonly string[]): void {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${arguments_.join(" ")} failed: ${result.stderr}`);
  }
}
