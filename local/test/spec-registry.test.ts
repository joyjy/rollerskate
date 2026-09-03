import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSpecCompatibility,
  createSpecRegistry,
  normalizeSpecRef,
  parseArtifactDigest,
  parseSpecRef,
  resolveSpecToken,
  specRegistryInventory,
  verifySpecArtifact,
  type SpecRegistryEntry
} from "../src/modules/spec/registry.js";
import { workflowMandateSnapshot } from
  "../src/infrastructure/resources/workflow-resource.js";

const NULL_DIGEST_ENTRY = {
  status: "active",
  owner: "local/test/spec-registry.test.ts#fixture",
  source: "local/test/spec-registry.test.ts",
  parser: "fixtureParser",
  artifactDigest: null
} as const;

test("SpecRef@1 grammar is canonical and keeps digests outside the namespace", () => {
  assert.deepEqual(parseSpecRef("spec:rollerskate/run-intent@1"), {
    schemaVersion: "SpecRef@1",
    namespace: "rollerskate",
    name: "run-intent",
    major: 1,
    canonical: "spec:rollerskate/run-intent@1"
  });
  assert.equal(
    normalizeSpecRef({ name: "subscription.continuous", major: 1 }),
    "spec:rollerskate/subscription.continuous@1"
  );
  for (const malformed of [
    "RunIntent@1",
    "spec:rollerskate/RunIntent@1",
    "spec:rollerskate/run-intent@0",
    "spec:other/run-intent@1",
    `sha256:${"a".repeat(64)}`
  ]) {
    assert.throws(() => parseSpecRef(malformed), /SpecRef@1/);
  }
  assert.equal(parseArtifactDigest(`sha256:${"a".repeat(64)}`), `sha256:${"a".repeat(64)}`);
  assert.throws(() => parseArtifactDigest("spec:rollerskate/review@1"), /artifactDigest/);
});

test("the registry rejects duplicate refs, discriminator collisions and name-kind collisions", () => {
  const first = fixtureEntry("fixture", 1, "contract", ["Fixture@1"]);
  assert.throws(
    () => createSpecRegistry([first, { ...first, payloadDiscriminators: ["FixtureAgain@1"] }]),
    /Duplicate spec registry ref/
  );
  assert.throws(
    () => createSpecRegistry([
      first,
      fixtureEntry("another", 1, "contract", ["Fixture@1"])
    ]),
    /Duplicate spec registry discriminator/
  );
  assert.throws(
    () => createSpecRegistry([
      first,
      fixtureEntry("fixture", 2, "workflow", ["fixture@2"])
    ]),
    /name collision/
  );
});

test("registry resolution admits active input and requires an explicit historical reader", () => {
  assert.equal(
    resolveSpecToken("RunIntent@1", { kind: "contract" }).ref,
    "spec:rollerskate/run-intent@1"
  );
  assert.equal(
    resolveSpecToken("spec:rollerskate/run-intent@1", { kind: "contract" }).owner,
    "local/src/modules/steward/admission-contract.ts#RunIntent"
  );
  assert.throws(
    () => resolveSpecToken("Unknown@1", { kind: "contract" }),
    /Unknown spec registry entry/
  );
  assert.throws(
    () => resolveSpecToken("RunIntent@1", { kind: "workflow" }),
    /Wrong spec kind/
  );
  assert.throws(
    () => resolveSpecToken("ScheduleRevision@1", { kind: "contract" }),
    /Historical spec requires an explicit persisted-data reader/
  );
  assert.equal(
    resolveSpecToken("ScheduleRevision@1", {
      kind: "contract",
      allowHistorical: true
    }).status,
    "historical"
  );
  assert.throws(
    () => resolveSpecToken("RunDecision@2", { kind: "result-contract" }),
    /Historical spec requires an explicit persisted-data reader/
  );
});

test("compatibility is exact for both active contracts and historical readback", () => {
  assert.equal(assertSpecCompatibility(
    "RunDecision@3",
    "RunDecision@3",
    { kind: "result-contract" }
  ).ref, "spec:rollerskate/run-decision@3");
  assert.throws(() => assertSpecCompatibility(
    "RunDecision@2",
    "RunDecision@2",
    { kind: "result-contract" }
  ), /Historical spec requires an explicit persisted-data reader/);
  assert.equal(assertSpecCompatibility(
    "RunDecision@2",
    "RunDecision@2",
    { kind: "result-contract", allowHistorical: true }
  ).ref, "spec:rollerskate/run-decision@2");
  assert.throws(() => assertSpecCompatibility(
    "RunDecision@3",
    "RunDecision@2",
    { kind: "result-contract", allowHistorical: true }
  ), /Incompatible result-contract spec/);
  assert.throws(() => assertSpecCompatibility(
    "RunDecision@2",
    "RunDecision@3",
    { kind: "result-contract", allowHistorical: true }
  ), /Incompatible result-contract spec/);
});

test("artifact digests are bound only to file-backed specs and detect drift", () => {
  const workflow = verifySpecArtifact(
    "review@1",
    "sha256:0067e1e1efd5cc0633990b70bdce4c34e1dbd62708530a3d2ee444fdc51d7ca2"
  );
  assert.equal(workflow.kind, "workflow");
  assert.throws(
    () => verifySpecArtifact("review@1", `sha256:${"0".repeat(64)}`),
    /Artifact digest drift/
  );
  assert.throws(
    () => verifySpecArtifact("RunIntent@1", `sha256:${"0".repeat(64)}`),
    /code-native/
  );
  for (const workflowRef of [
    "review@1",
    "mr-readiness@1",
    "forum@1",
    "continuous-observation-monitor@1"
  ]) {
    assert.equal(workflowMandateSnapshot(workflowRef, {}).workflowRef, workflowRef);
  }
});

test("Run main-chain contracts and their real dependencies resolve from one inventory", () => {
  const required = [
    ["RunIntent@1", "contract"],
    ["StewardRunRequest@2", "contract"],
    ["RunAuthorityEnvelope@1", "contract"],
    ["OrchestratorBinding@3", "contract"],
    ["RunDecision@3", "result-contract"],
    ["AgentStepResult@1", "result-contract"],
    ["AgentRunCheckpoint@1", "contract"],
    ["RunSourceBinding@1", "contract"],
    ["ScheduleRevision@3", "contract"],
    ["SubscriptionDefinition@5", "contract"],
    ["ContinuousSubscriptionDefinition@3", "contract"],
    ["ProactiveTarget@1", "contract"],
    ["DeterministicApplicationActionReceipt@1", "contract"],
    ["TriggerOccurrenceEnvelope@1", "contract"],
    ["schedule.once@1", "template"],
    ["schedule.cron@1", "template"],
    ["subscription.until@1", "template"],
    ["subscription.continuous@1", "template"],
    ["review@1", "workflow"],
    ["mr-readiness@1", "workflow"],
    ["forum@1", "workflow"],
    ["continuous-observation-monitor@1", "workflow"],
    ["scheduled-task@1", "capability"],
    ["subscription@1", "capability"]
  ] as const;
  const refs = required.map(([token, kind]) => resolveSpecToken(token, { kind }).ref);
  assert.equal(new Set(refs).size, required.length);

  const inventory = specRegistryInventory();
  assert.equal(new Set(inventory.map(({ ref }) => ref)).size, inventory.length);
  for (const entry of inventory) {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry.payloadDiscriminators), true);
    assert.notEqual(entry.owner, "");
    assert.notEqual(entry.parser, "");
    assert.notEqual(entry.source, "");
  }
});

function fixtureEntry(
  name: string,
  major: number,
  kind: SpecRegistryEntry["kind"],
  payloadDiscriminators: readonly string[]
): SpecRegistryEntry {
  return {
    ref: normalizeSpecRef({ name, major }),
    kind,
    ...NULL_DIGEST_ENTRY,
    payloadDiscriminators
  };
}
