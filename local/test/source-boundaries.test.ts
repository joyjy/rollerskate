import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const localRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(localRoot, "src");
const uiRoot = resolve(localRoot, "ui/src");

test("Local source layers preserve the core and Capability dependency boundary", () => {
  assertLayerImports("core", new Set([
    "core",
    "infrastructure"
  ]));
  assertLayerImports("capabilities", new Set([
    "capabilities",
    "core",
    "infrastructure",
    "modules"
  ]));
  assertLayerImports("application", new Set([
    "application",
    "capabilities",
    "core",
    "infrastructure",
    "integrations",
    "modules",
    "protocol.js"
  ]));
  assertLayerImports("modules", new Set([
    "modules"
  ]));
  assertLayerImports("integrations", new Set([
    "core",
    "integrations",
    "protocol.js"
  ]));
  assertLayerImports("entrypoints", new Set([
    "application",
    "bootstrap",
    "entrypoints",
    "protocol.js"
  ]));
  assertLayerImports("infrastructure", new Set([
    "capabilities",
    "core",
    "infrastructure",
    "integrations",
    "modules",
    "protocol.js"
  ]));
});

test("Core and Agent adapters do not own application result schemas", () => {
  for (const file of sourceFiles(resolve(sourceRoot, "core"))) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /AgentTurnResult@1/,
      `${relative(sourceRoot, file)} cannot own the Agent Run result schema`
    );
  }
  for (const file of sourceFiles(resolve(sourceRoot, "integrations/agent"))) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /AgentTurnResult@1|ReviewerResult@1|ImplementerResult@1/,
      `${relative(sourceRoot, file)} cannot own an application result schema`
    );
  }
});

test("Steward result destination stays provider-neutral", () => {
  const contract = readFileSync(
    resolve(sourceRoot, "modules/steward/caller-contract.ts"),
    "utf8"
  );
  assert.match(contract, /RunResultDestination@2/);
  assert.doesNotMatch(contract, /Vikunja|vikunja-task|taskUrl/);

  const vikunja = readFileSync(
    resolve(sourceRoot, "integrations/vikunja/task-destination.ts"),
    "utf8"
  );
  assert.match(vikunja, /VikunjaTaskResultDestination@1/);
  assert.match(vikunja, /RunResultDestination@2/);
});

test("Client history continuation remains application-owned", () => {
  for (const root of [
    resolve(sourceRoot, "core/runtime"),
    resolve(sourceRoot, "integrations/agent")
  ]) {
    for (const file of sourceFiles(root)) {
      assert.doesNotMatch(
        readFileSync(file, "utf8"),
        /ClientHistoryRequest@1/,
        `${relative(sourceRoot, file)} cannot own Client history continuation`
      );
    }
  }
  assert.match(
    readFileSync(resolve(sourceRoot, "application/chat/agent-continuation.ts"), "utf8"),
    /ClientHistoryRequest@1/
  );
});

test("Steward, Schedule and Subscription keep separate conversation ownership", () => {
  assert.equal(existsSync(resolve(sourceRoot, "application/agent-run")), false);
  assert.equal(existsSync(resolve(sourceRoot, "application/steward/query.ts")), true);
  assert.equal(existsSync(resolve(sourceRoot, "modules/steward/state-machine.ts")), true);

  const stewardQuery = readFileSync(
    resolve(sourceRoot, "application/steward/query.ts"),
    "utf8"
  );
  assert.doesNotMatch(stewardQuery, /schedule|subscription/i);

  const stewardView = readFileSync(resolve(uiRoot, "views/StewardView.vue"), "utf8");
  assert.doesNotMatch(
    stewardView,
    /steward\/invocations|StewardInvocationOverview|route\.query\.eventId|Scheduled turn|Subscription callback/
  );
  assert.match(
    readFileSync(resolve(uiRoot, "components/AgentRunOverview.vue"), "utf8"),
    /AgentInvocationDetail/
  );
  assert.match(
    readFileSync(resolve(uiRoot, "views/SchedulesView.vue"), "utf8"),
    /AgentInvocationDetail/
  );
  const subscriptionView = readFileSync(
    resolve(uiRoot, "components/SubscriptionTrace.vue"),
    "utf8"
  );
  assert.match(subscriptionView, /subscription\.callbacks/);
  assert.doesNotMatch(subscriptionView, /fireEventId|subscription\.callback\./);
});

test("Local core owns the only long-running loop", () => {
  const loopFiles = sourceFiles(sourceRoot)
    .filter((file) => readFileSync(file, "utf8").includes("while (!signal.aborted)"))
    .map((file) => relative(sourceRoot, file))
    .sort();
  assert.deepEqual(loopFiles, ["core/loop.ts"]);
  const importers = sourceFiles(sourceRoot)
    .filter((file) => /\bimport\s*\{[^}]*\brunLoop\b[^}]*\}\s*from\s*["'][^"']*core\/loop\.js["']/s
      .test(readFileSync(file, "utf8")))
    .map((file) => relative(sourceRoot, file));
  assert.deepEqual(importers, ["bootstrap/runtime.ts"]);
});

test("Server clients and Subscription stores preserve authority boundaries", () => {
  const deviceClient = readFileSync(
    resolve(sourceRoot, "integrations/server/device-client.ts"),
    "utf8"
  );
  const agentClient = readFileSync(
    resolve(sourceRoot, "integrations/server/agent-client.ts"),
    "utf8"
  );
  const pairingClient = readFileSync(
    resolve(sourceRoot, "integrations/server/pairing-client.ts"),
    "utf8"
  );
  assert.doesNotMatch(deviceClient, /createPairing|redeemPairing|publishTopic|agentPrincipal/);
  assert.doesNotMatch(agentClient, /allowSubject|createAgent|updateAgentProfile|createTopic/);
  assert.doesNotMatch(pairingClient, /authorization|createAgent|publishTopic/);

  const subscriptionStore = readFileSync(
    resolve(sourceRoot, "capabilities/subscription/store.ts"),
    "utf8"
  );
  assert.doesNotMatch(
    subscriptionStore,
    /CreatePollSubscription|Definition@2|fire_event_id/
  );
});

test("Server Topic policy stays above bootstrap and transport-neutral Chat persistence", () => {
  const bootstrap = readFileSync(resolve(sourceRoot, "bootstrap/runtime.ts"), "utf8");
  assert.doesNotMatch(
    bootstrap,
    /mentionedChatAgents|localParticipantIds|profileResolution\(agentId|destinationIds\.get/,
    "bootstrap may assemble the Server Topic bridge but cannot own Topic policy"
  );

  const chatStore = readFileSync(
    resolve(sourceRoot, "infrastructure/sqlite/chat-store.ts"),
    "utf8"
  );
  assert.doesNotMatch(
    chatStore,
    /TopicEvent|publisher\.humanId|publisher\.displayName|protocol\.js/,
    "Chat persistence must consume normalized ingress rather than Server Topic wire models"
  );
});

test("Topic governance remains application-owned and does not create a Core state path", () => {
  for (const file of sourceFiles(resolve(sourceRoot, "core"))) {
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      /TopicGovernance|TopicParticipant|ConversationPolicy/,
      `${relative(sourceRoot, file)} cannot own Topic governance`
    );
  }
  const bootstrap = readFileSync(resolve(sourceRoot, "bootstrap/runtime.ts"), "utf8");
  assert.doesNotMatch(
    bootstrap,
    /starterEnabled|participantMessageEnabled|scheduledEnabled|choose_from_themes/,
    "bootstrap may materialize Topic governance but cannot own its policy"
  );
  assert.match(
    readFileSync(resolve(sourceRoot, "modules/topic/governance.ts"), "utf8"),
    /TopicGovernanceControlReceipt@1/
  );
  assert.match(
    readFileSync(resolve(sourceRoot, "application/topic/governance-control.ts"), "utf8"),
    /materializeLocalTopicGovernance/
  );
});

test("Capabilities coordinate Execution ownership through Core Runtime APIs", () => {
  for (const file of sourceFiles(resolve(sourceRoot, "capabilities"))) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /UPDATE\s+executions\b/i,
      `${relative(sourceRoot, file)} cannot mutate Core Execution storage directly`
    );
  }
});

test("one host callback kernel owns command execution and owner Event policy stays outside it", () => {
  const commandExecutors = sourceFiles(sourceRoot)
    .filter((file) => /\bexecFile\b/.test(readFileSync(file, "utf8")))
    .map((file) => relative(sourceRoot, file));
  assert.deepEqual(commandExecutors, ["infrastructure/callback/host-kernel.ts"]);

  for (const legacyFile of ["callback-model.ts", "callback-store.ts", "callback-runtime.ts"]) {
    assert.equal(
      existsSync(resolve(sourceRoot, "capabilities/subscription", legacyFile)),
      false,
      `${legacyFile} must stay cut over to the shared callback module`
    );
  }

  for (const file of [
    resolve(sourceRoot, "application/callback/proactive-runtime.ts"),
    resolve(sourceRoot, "infrastructure/callback/store.ts")
  ]) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /source:\s*\{|scheduled-run:|kind === "schedule"/,
      `${relative(sourceRoot, file)} cannot own Schedule/Subscription Event source policy`
    );
  }
});

test("ordinary SQLite stores share one immediate transaction template", () => {
  const rawTransactionOwners = sourceFiles(sourceRoot)
    .filter((file) => readFileSync(file, "utf8").includes("BEGIN IMMEDIATE"))
    .map((file) => relative(sourceRoot, file))
    .sort();
  assert.deepEqual(rawTransactionOwners, [
    "infrastructure/sqlite/schema/index.ts",
      "infrastructure/sqlite/schema/v44-migration.ts",
      "infrastructure/sqlite/schema/v59-migration.ts",
      "infrastructure/sqlite/schema/v60-migration.ts",
      "infrastructure/sqlite/schema/v61-migration.ts",
      "infrastructure/sqlite/schema/v62-migration.ts",
      "infrastructure/sqlite/transaction.ts"
  ]);
});

function assertLayerImports(layer: string, allowedRoots: ReadonlySet<string>): void {
  for (const file of sourceFiles(resolve(sourceRoot, layer))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      if (!target.startsWith(sourceRoot)) continue;
      const targetRoot = relative(sourceRoot, target).split("/")[0]!;
      assert.ok(
        allowedRoots.has(targetRoot),
        `${relative(sourceRoot, file)} cannot import ${targetRoot} through ${specifier}`
      );
    }
  }
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : path.endsWith(".ts") ? [path] : [];
  }).sort();
}
