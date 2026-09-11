import assert from "node:assert/strict";
import test from "node:test";

import { stewardOrchestratorPrompt } from "../src/application/steward/prompt.js";
import { parseRunDecision } from "../src/modules/steward/caller-contract.js";

function finishExample(prompt: string): Record<string, unknown> {
  const section = prompt.split("For finish use:\n")[1]!;
  return JSON.parse(section.split("\nFor needs_human")[0]!) as Record<string, unknown>;
}

test("published finish examples obey their admitted decision version and output location", () => {
  for (const contractVersion of [3, 4, 5, 6] as const) {
    const prompt = stewardOrchestratorPrompt({
      objective: "Return AgentTurnResult@1.outputs containing a ReviewPacket@1 report.",
      runVersion: 7, maxSteps: 20, completedWorkerSteps: 1, participants: [], contractVersion
    });
    const example = finishExample(prompt);
    const parsed = parseRunDecision(example);
    assert.equal(parsed.schemaVersion, `RunDecision@${contractVersion}`);
    assert.equal(parsed.expectedRunVersion, 7);
    assert.equal(parsed.action, "finish");
    assert.equal(Object.hasOwn(example, "outputs"), false);
    const finish = example.finish as Record<string, unknown>;
    assert.equal(Object.hasOwn(finish, "outputs"), contractVersion >= 4);
    if (contractVersion >= 4) {
      assert.match(prompt, /map that outputs array to finish\.outputs/);
      assert.throws(() => parseRunDecision({ ...example, outputs: finish.outputs }),
        new RegExp(`RunDecision@${contractVersion}.*top-level field: outputs;.*finish\\.outputs`));
      // The real failure shape moves deliverables to the root; it must not be normalized.
      const { outputs, ...withoutOutputs } = finish;
      assert.throws(() => parseRunDecision({ ...example, finish: withoutOutputs, outputs }), /top-level field/);
    }
  }
});

test("large business requests and accepted state stay intact without being copied into examples", () => {
  const objective = `Keep exact acceptance and report schema: ${"business-evidence ".repeat(700)}`;
  const priorState = {
    schemaVersion: "OrchestratorState@1", goal: "existing goal", tasks: [],
    acceptedEvidence: ["UNIQUE_ACCEPTED_EVIDENCE"], unresolvedQuestions: ["UNIQUE_OPEN_QUESTION"]
  };
  const prompt = stewardOrchestratorPrompt({
    objective, priorState, runVersion: 3, maxSteps: 20, completedWorkerSteps: 1,
    participants: [], contractVersion: 6
  });
  assert.equal(prompt.split(objective).length - 1, 1);
  assert.equal(prompt.split("UNIQUE_ACCEPTED_EVIDENCE").length - 1, 1);
  assert.equal(prompt.split("UNIQUE_OPEN_QUESTION").length - 1, 1);
  assert.ok(prompt.includes(JSON.stringify(priorState, null, 2)));
  assert.ok(prompt.length < objective.length + 12_000);
  assert.equal(priorState.goal, "existing goal");
  assert.equal(finishExample(prompt).expectedRunVersion, 3);
});
