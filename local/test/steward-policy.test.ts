import { cancelStewardRun, setStewardRunArchived } from "../src/application/steward/control.js";
import { stewardStatsView } from "../src/application/steward/stats-query.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureStewardPolicy } from "../src/application/steward/policy-control.js";
import { startStewardRunFromIntent } from "../src/application/steward/intent-control.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { bootstrapLocalFoundation, LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { parseStewardPolicy, selectSteward } from "../src/modules/steward/steward-policy.js";

test("stable request buckets approximate 80/10/10 and reject ambiguous policy", () => {
  const policy = parseStewardPolicy({ schemaVersion: "StewardPolicy@1", entries: [
    { agentId: "codex", weight: 80 }, { agentId: "kimi", weight: 10 }, { agentId: "pi", weight: 10 }
  ] });
  const counts: Record<string, number> = { codex: 0, kimi: 0, pi: 0 };
  for (let i = 0; i < 10000; i++) {
    const selected = selectSteward(policy, `request-${i}`);
    assert.deepEqual(selected, selectSteward(policy, `request-${i}`));
    counts[selected.agentId]! += 1;
  }
  assert.ok(Math.abs(counts.codex! - 8000) < 200);
  assert.ok(Math.abs(counts.kimi! - 1000) < 100);
  assert.ok(Math.abs(counts.pi! - 1000) < 100);
  assert.throws(() => parseStewardPolicy({ ...policy, entries: [{ agentId: "codex", weight: 80 }] }));
  assert.throws(() => parseStewardPolicy({ ...policy, entries: [{ agentId: "codex", weight: 50 }, { agentId: "codex", weight: 50 }] }));
});

for (const client of ["kimi-code", "pi"] as const) {
  test(`${client} public admission pins identity across policy change and duplicate start`, () => {
    const root = mkdtempSync(join(tmpdir(), "rs-steward-policy-"));
    const runtime = root;
    const paths = runtimePaths(root, runtime);
    initializeRuntimeSchema(paths.database);
    bootstrapLocalFoundation(paths);
    const foundation = new LocalFoundationStore(paths.database);
    const codex = foundation.addAgent("codex", "codex");
    const candidate = foundation.addAgent("candidate", client);
    foundation.close();
    const policy = (agentId: string) => ({ schemaVersion: "StewardPolicy@1", entries: [{ agentId, weight: 100 }] });
    const intent = { schemaVersion: "RunIntent@1", requestId: "pinned-request", objective: "Read-only smoke",
      acceptance: ["Return evidence"], contextRefs: [], terminalEvidence: ["receipt"] };
    try {
      configureStewardPolicy(root, policy(candidate.principalId), runtime);
      const first = startStewardRunFromIntent(root, intent, runtime, "2026-09-07T00:00:00.000Z");
      assert.equal(first.run.stewardAgentId, candidate.principalId);
      assert.equal(first.run.orchestratorBinding?.schemaVersion, "OrchestratorBinding@3");
      assert.equal(first.admission.authority.maxDepth, 0);
      configureStewardPolicy(root, policy(codex.principalId), runtime);
      const duplicate = startStewardRunFromIntent(root, intent, runtime, "2026-09-07T00:00:00.000Z");
      assert.equal(duplicate.run.runId, first.run.runId);
      assert.deepEqual(duplicate.admission.stewardSelection, first.admission.stewardSelection);
      assert.equal(duplicate.admission.admissionDigest, first.admission.admissionDigest);
      const digest = first.admission.stewardSelection!.policyDigest;
      const pending = stewardStatsView(root, runtime, digest).groups[0]!;
      assert.equal(pending.inProgress, 1);
      assert.equal(pending.successRate, null);
      assert.equal(pending.durationSamples, 0);
      cancelStewardRun(root, first.run.runId, runtime, "2026-09-07T00:00:10.000Z");
      setStewardRunArchived(root, first.run.runId, true, runtime, "2026-09-07T01:00:00.000Z");
      const settled = stewardStatsView(root, runtime, digest).groups[0]!;
      assert.equal(settled.cancelled, 1);
      assert.equal(settled.successRate, 0);
      assert.equal(settled.meanDurationMs, 10000);
      assert.equal(settled.fallbackRuns, 0);
      assert.throws(() => configureStewardPolicy(root, policy("missing-agent"), runtime), /active supported/);
      configureStewardPolicy(root, policy(candidate.principalId), runtime);
      const changed = new LocalFoundationStore(paths.database);
      changed.setAgentStatus(candidate.principalId, "suspended");
      changed.close();
      assert.throws(() => startStewardRunFromIntent(root, { ...intent, requestId: "unavailable" }, runtime), /selected Agent is unavailable/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
