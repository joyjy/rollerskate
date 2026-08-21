import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import test from "node:test";

import {
  buildRunProgressSnapshot,
  writePrivateJsonIfChanged
} from "../src/application/runtime/progress.js";
import type { AgentRunProjection } from
  "../src/modules/steward/state-machine.js";

test("Run progress never copies terminal summary content", () => {
  const run: AgentRunProjection = {
    runId: "run_019ff8e9-8812-74d5-869d-205202f2a9ad",
    rootEventId: "evt_root",
    ownerRequestId: "candidate-request",
    ownerPrincipalId: "prn_owner",
    stewardAgentId: "prn_steward",
    mandate: {
      schemaVersion: "RunMandateSnapshot@1",
      kind: "objective",
      objective: "Analyze one release candidate",
      renderedInstruction: "Analyze one release candidate"
    },
    orchestrationMode: "autonomous",
    status: "needs_human",
    stepCount: 1,
    maxSteps: 1,
    maxDepth: 0,
    terminalSummary: "---DETAIL--- full issue patch",
    version: 2,
    createdAt: "2026-08-13T03:00:00.000Z",
    updatedAt: "2026-08-13T03:01:00.000Z"
  };

  const snapshot = buildRunProgressSnapshot(run);

  assert.equal(snapshot.terminalSummaryAvailable, true);
  assert.equal(JSON.stringify(snapshot).includes("full issue patch"), false);
});

test("each Run progress replaces its own stable private snapshot", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-progress-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const runDirectory = join(directory, "run_one");
  mkdirSync(runDirectory, { mode: 0o700 });
  const path = join(runDirectory, "progress.json");
  const first = {
    schemaVersion: "RunProgressSnapshot@1",
    runId: "run_one",
    status: "active",
    progress: { currentStepId: "stp_one", steps: 1, maxSteps: 4 },
    updatedAt: "2026-08-13T03:00:00.000Z"
  };
  const second = {
    ...first,
    status: "succeeded",
    progress: { currentStepId: null, steps: 2, maxSteps: 4 },
    updatedAt: "2026-08-13T03:01:00.000Z"
  };

  assert.equal(writePrivateJsonIfChanged(path, first), true);
  assert.equal(writePrivateJsonIfChanged(path, first), false);
  assert.equal(writePrivateJsonIfChanged(path, second), true);

  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), second);
  assert.equal(lstatSync(path).mode & 0o077, 0);
  assert.deepEqual(readdirSync(runDirectory), ["progress.json"]);
});
