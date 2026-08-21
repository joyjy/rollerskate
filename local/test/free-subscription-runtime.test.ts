import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { registerSubscription } from "../src/application/subscription/control.js";
import { inspectSubscriptionView } from "../src/application/subscription/query.js";
import type {
  FreeSubscriptionCallback,
  FreeSubscriptionDefinition
} from "../src/capabilities/subscription/model.js";
import { ProactiveCallbackRuntime } from "../src/application/callback/proactive-runtime.js";
import { proactiveCallbackOwnerAdapters } from "../src/application/callback/proactive.js";
import { CallbackStore } from "../src/infrastructure/callback/store.js";
import { SubscriptionStore } from "../src/capabilities/subscription/store.js";
import { PollProbeExecutor } from "../src/capabilities/subscription/plugin-runner.js";
import { SubscriptionRuntime } from "../src/capabilities/subscription/runtime.js";
import { LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { ScheduledTaskStore } from "../src/capabilities/scheduled-task/store.js";
import { parseSubscriptionAgentResult, subscriptionAgentPrompt } from
  "../src/capabilities/subscription/agent-result.js";
import { runSubscriptionCommand } from "../src/entrypoints/cli/subscription.js";

test("Subscription Agent prompt grants bounded correction without ambiguous retries", () => {
  const prompt = subscriptionAgentPrompt("Add the reviewer and verify it.");
  assert.match(prompt, /Own the requested outcome/);
  assert.match(prompt, /readback proves the failed attempt did not mutate external state/);
  assert.match(prompt, /repeating the same request is not a correction/);
  assert.match(prompt, /target or revision is ambiguous/);
  assert.match(prompt, /side effect has an ambiguous outcome/);
  assert.match(prompt, /expand the granted scope/);
});

test("SubscriptionAgentResult@1 extracts one bounded JSON envelope", () => {
  const result = {
    schemaVersion: "SubscriptionAgentResult@1",
    status: "succeeded",
    summary: "done",
    artifactRefs: []
  } as const;
  assert.deepEqual(
    parseSubscriptionAgentResult(`Result:\n${JSON.stringify(result)}`),
    result
  );
  assert.throws(
    () => parseSubscriptionAgentResult(`${JSON.stringify(result)}\n${JSON.stringify(result)}`),
    /must be one JSON object/
  );
});

test("subscription add accepts a strict SubscriptionDefinition@3 file", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-free-subscription-cli-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-free-subscription-cli-runtime-"));
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    const foundation = new LocalFoundationStore(paths.database);
    const owner = foundation.addAgent("cli-owner", "codex");
    foundation.close();
    const workspace = realpathSync(repo);
    const pluginPath = join(workspace, "probe.mjs");
    writeFileSync(pluginPath, `export default {
      kind: "subscription.probe", id: "cli-probe", schemaVersion: 1,
      plan() { return { kind: "http", url: "https://probe.example/status" }; },
      evaluate() { return { version: "v1", facts: {}, terminal: "success" }; }
    };`);
    const file = join(workspace, "subscription.json");
    writeFileSync(file, JSON.stringify({
      schemaVersion: 3,
      revision: "cli-v1",
      title: "CLI free subscription",
      ownerAgentId: owner.principalId,
      probe: {
        plugin: { path: pluginPath, id: "cli-probe", config: {} },
        artifactRevision: "cli-source-v1",
        artifactDigest: `sha256:${createHash("sha256").update(readFileSync(pluginPath)).digest("hex")}`,
        policy: {
          workspaceRoot: workspace,
          allowedHttpOrigins: ["https://probe.example"],
          allowedExecutables: [],
          allowedEnvironment: [],
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096
        }
      },
      callbacks: [],
      schedule: {
        intervalMilliseconds: 100,
        maxWaitMilliseconds: 60_000,
        maxAttempts: 10
      },
      approvedGrantDigest: digest([])
    }));
    let output = "";
    assert.equal(runSubscriptionCommand(
      repo,
      ["add", file],
      { write(text) { output += text; } },
      runtimeDirectory,
      workspace
    ), 0);
    const receipt = JSON.parse(output) as {
      subscription: { definitionSchema: string; definitionRevision: string };
      callbackDefinitions: unknown[];
      callbacks: unknown[];
    };
    assert.equal(receipt.subscription.definitionSchema, "SubscriptionDefinition@3");
    assert.equal(receipt.subscription.definitionRevision, "cli-v1");
    assert.deepEqual(receipt.callbackDefinitions, []);
    assert.deepEqual(receipt.callbacks, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("SubscriptionDefinition@3 runs shared exact-grant callbacks in order", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-free-subscription-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-free-subscription-runtime-"));
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    const foundation = new LocalFoundationStore(paths.database);
    const owner = foundation.addAgent("alice", "codex");
    foundation.close();
    const pluginPath = join(repo, "probe.mjs");
    writeFileSync(pluginPath, `
export default {
  kind: "subscription.probe",
  id: "free-probe",
  schemaVersion: 1,
  plan() { return { kind: "http", url: "https://probe.example/status" }; },
  evaluate() {
    return {
      version: "observation-v1",
      facts: { pipelineId: 42 },
      terminal: "success"
    };
  }
};
`);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "subscription@test.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Subscription Test"], { cwd: repo });
    const callbackScript = join(repo, "callback.mjs");
    writeFileSync(callbackScript, "process.stdout.write('command callback');\n");
    execFileSync("git", ["add", "probe.mjs", "callback.mjs"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
    const workspace = realpathSync(repo);
    const callbacks = callbackDefinitions(
      owner.principalId,
      workspace,
      realpathSync(callbackScript)
    );
    const definition: FreeSubscriptionDefinition = {
      schemaVersion: 3,
      revision: "fixture-v1",
      title: "Free callback fixture",
      ownerAgentId: owner.principalId,
      probe: {
        plugin: { path: pluginPath, id: "free-probe", schemaVersion: 1, config: {} },
        artifactRevision: "fixture-source-v1",
        artifactDigest: `sha256:${createHash("sha256")
          .update(writeAndRead(pluginPath)).digest("hex")}`,
        policy: {
          workspaceRoot: workspace,
          allowedHttpOrigins: ["https://probe.example"],
          allowedExecutables: [],
          allowedEnvironment: [],
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096
        }
      },
      intervalMilliseconds: 100,
      maxWaitMilliseconds: 60_000,
      maxAttempts: 10,
      callbacks,
      approvedGrantDigest: digest(callbacks.map(({ grant }) => grant))
    };
    const registered = registerSubscription(
      repo,
      definition,
      runtimeDirectory,
      "2026-07-27T10:00:00.000Z"
    );
    assert.equal(registered.callbackDefinitions.length, 2);
    assert.deepEqual(registered.callbacks, []);
    const terminalKey = `subscription:${registered.subscription.subscriptionId}:terminal`;

    const polling = new SubscriptionRuntime({
      databasePath: paths.database,
      probeExecutor: new PollProbeExecutor({ fetch: async () => Response.json({ done: true }) })
    });
    const pollResult = await polling.runCycle(
      new AbortController().signal,
      "2026-07-27T10:00:00.100Z"
    );
    assert.deepEqual(pollResult.polled, [registered.subscription.subscriptionId]);

    const runtime = new RuntimeStore(paths.database);
    const callbackRuntime = new ProactiveCallbackRuntime(paths.database, {
      ownerAdapters: proactiveCallbackOwnerAdapters(paths.database)
    });
    const first = await callbackRuntime.tick(
      new AbortController().signal,
      "2026-07-27T10:00:01.000Z"
    );
    const firstCallbacks = new CallbackStore(paths.database);
    const firstErrors = firstCallbacks.list({
      ownerKind: "subscription",
      ownerId: registered.subscription.subscriptionId,
      triggerOccurrenceKey: terminalKey
    }).flatMap(({ lastError }) => lastError === undefined ? [] : [lastError]);
    firstCallbacks.close();
    assert.equal(first.failed.length, 0, firstErrors.join("\n"));
    assert.equal(first.succeeded.length, 1);
    assert.equal(first.admitted.length, 1);

    const execution = runtime.claimDueExecutions(1, "2026-07-27T10:00:02.000Z")[0]!;
    assert.equal(execution.maxAttempts, 1);
    runtime.completeExecution(execution.executionId, {
      adapterId: "codex-runtime-app-server-v1",
      workspace,
      providerSessionId: "provider-free-v1",
      output: JSON.stringify({
        schemaVersion: "SubscriptionAgentResult@1",
        status: "blocked",
        summary: "Missing GitLab credential",
        artifactRefs: []
      })
    }, "2026-07-27T10:00:03.000Z");
    const schedules = new ScheduledTaskStore(paths.database);
    try {
      assert.equal(schedules.reconcileCallbacks("2026-07-27T10:00:03.500Z"), 0);
    } finally {
      schedules.close();
    }
    const isolatedCallbacks = new CallbackStore(paths.database);
    try {
      assert.equal(isolatedCallbacks.list({
        ownerKind: "subscription",
        ownerId: registered.subscription.subscriptionId,
        triggerOccurrenceKey: terminalKey
      }).find(({ kind }) => kind === "agent.invoke")?.status, "started");
    } finally {
      isolatedCallbacks.close();
    }
    const consoleView = inspectSubscriptionView(
      repo,
      registered.subscription.subscriptionId,
      runtimeDirectory
    );
    assert.equal(consoleView.kind, "free");
    if (consoleView.kind === "free") {
      const agentOccurrence = consoleView.callbacks.find(
        ({ kind }) => kind === "agent.invoke"
      );
      assert.equal(agentOccurrence?.status, "started");
      assert.equal(agentOccurrence?.invocationStatus, "succeeded");
      assert.equal(agentOccurrence?.agentResult?.status, "blocked");
    }
    const second = await callbackRuntime.tick(
      new AbortController().signal,
      "2026-07-27T10:00:04.000Z"
    );
    assert.equal(second.reconciled, 1);
    runtime.close();

    const callbackStore = new CallbackStore(paths.database);
    try {
      assert.deepEqual(callbackStore.list({
        ownerKind: "subscription",
        ownerId: registered.subscription.subscriptionId,
        triggerOccurrenceKey: terminalKey
      })
        .map(({ kind, status }) => ({ kind, status })), [
        { kind: "command.exec", status: "succeeded" },
        { kind: "agent.invoke", status: "blocked" }
      ]);
      const freeStore = new SubscriptionStore(paths.database);
      try {
        freeStore.reconcileCallbacks("2026-07-27T10:00:04.000Z");
        const blocked = freeStore.require(registered.subscription.subscriptionId);
        assert.equal(blocked.status, "blocked");
        assert.equal(blocked.callbackPhaseStatus, "blocked");
      } finally {
        freeStore.close();
      }
    } finally {
      callbackStore.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

function callbackDefinitions(
  agentId: string,
  workspace: string,
  executable: string
): FreeSubscriptionCallback[] {
  const commandId = "scb_019f0000-0000-7000-8000-000000000101";
  const agentCallbackId = "scb_019f0000-0000-7000-8000-000000000102";
  return [
    {
      callbackId: commandId,
      kind: "command.exec",
      definition: {
        schemaVersion: "ProactiveCallbackDefinition@1",
        callbackId: commandId,
        kind: "command.exec",
        runtime: "host",
        executable: realpathSync(process.execPath),
        argv: [executable],
        cwd: workspace,
        environment: {},
        timeoutMilliseconds: 1_000,
        maxOutputBytes: 4_096
      },
      grant: {
        schemaVersion: "ProactiveCallbackGrant@1",
        kind: "command.exec",
        runtime: "host",
        executable: realpathSync(process.execPath),
        argv: [executable],
        cwd: workspace,
        environment: {},
        filesystemRoots: [dirname(realpathSync(process.execPath)), workspace],
        networkAccess: true,
        timeoutMilliseconds: 1_000,
        maxOutputBytes: 4_096,
        secretReferences: []
      }
    },
    {
      callbackId: agentCallbackId,
      kind: "agent.invoke",
      definition: {
        schemaVersion: "ProactiveCallbackDefinition@1",
        callbackId: agentCallbackId,
        kind: "agent.invoke",
        agentId,
        workspace,
        prompt: "Continue from the terminal observation."
      },
      grant: {
        schemaVersion: "ProactiveCallbackGrant@1",
        kind: "agent.invoke",
        agentId,
        workspace,
        workspaceAccess: "write",
        networkAccess: true
      }
    }
  ];
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("base64url");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function writeAndRead(path: string): Buffer {
  return readFileSync(path);
}
