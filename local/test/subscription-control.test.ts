import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalFoundationStore } from "../src/application/local-foundation.js";
import { runtimePaths } from "../src/application/runtime-config.js";
import {
  registerPollSubscription,
  type RegisterPollSubscriptionInput
} from "../src/application/subscription-control.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { runSubscriptionCommand } from "../src/entrypoints/cli/subscription.js";

test("Subscription admission accepts a provider Session without pre-registration", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-subscription-control-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-subscription-control-runtime-"));
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    const agents = new LocalFoundationStore(paths.database);
    const alice = agents.addAgent("alice", "codex");
    const bob = agents.addAgent("bob", "codex");
    const suspended = agents.addAgent("paused", "codex");
    agents.setAgentStatus(suspended.principalId, "suspended");
    agents.close();
    mkdirSync(paths.workspace, { recursive: true });

    const aliceSession = seedSession(
      paths.database,
      alice.principalId,
      "codex-runtime-jsonl-v1",
      paths.workspace
    );
    const bobSession = seedSession(
      paths.database,
      bob.principalId,
      "codex-runtime-jsonl-v1",
      paths.workspace
    );
    const plugin = join(runtimeDirectory, "plugin.ts");
    writeFileSync(plugin, "export default {};\n");

    const registered = registerPollSubscription(
      repo,
      input(alice.principalId, aliceSession.providerSessionId, paths.workspace, plugin),
      runtimeDirectory,
      "2026-07-24T00:00:00.000Z"
    );
    assert.equal(registered.subscription.ownerAgentId, alice.principalId);
    assert.equal(registered.subscription.callback.providerSessionId, aliceSession.providerSessionId);
    assert.equal(registered.subscription.callback.localSessionId, aliceSession.sessionId);
    assert.deepEqual({
      principalId: registered.owner.principalId,
      client: registered.owner.client
    }, {
      principalId: alice.principalId,
      client: "codex"
    });

    assert.throws(
      () => registerPollSubscription(
        repo,
        input(alice.principalId, bobSession.providerSessionId, paths.workspace, plugin),
        runtimeDirectory
      ),
      /already bound to another Agent or workspace/
    );
    assert.throws(
      () => registerPollSubscription(
        repo,
        input(suspended.principalId, "not-registered-yet", paths.workspace, plugin),
        runtimeDirectory
      ),
      /Local Agent is not active/
    );

    const oneShot = registerPollSubscription(
      repo,
      input(alice.principalId, "desktop-thread-not-registered", paths.workspace, plugin),
      runtimeDirectory
    );
    assert.equal(oneShot.subscription.callback.providerSessionId, "desktop-thread-not-registered");
    assert.equal(oneShot.subscription.callback.localSessionId, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("Subscription CLI cleanly accepts providerSessionId and rejects sessionId", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-subscription-cli-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-subscription-cli-runtime-"));
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    const agents = new LocalFoundationStore(paths.database);
    const owner = agents.addAgent("alice", "codex");
    agents.close();
    const plugin = join(repo, "plugin.ts");
    writeFileSync(plugin, "export default {};\n");
    const valid = join(repo, "subscription.json");
    writeFileSync(valid, JSON.stringify({
      schemaVersion: 1,
      ownerAgentId: owner.principalId,
      plugin: { path: plugin, id: "fixture", config: {} },
      callback: {
        providerSessionId: "desktop-provider-session",
        prompt: "Report completion."
      },
      schedule: {
        intervalMilliseconds: 1_000,
        maxWaitMilliseconds: 60_000,
        maxAttempts: 60
      }
    }));
    let output = "";
    assert.equal(runSubscriptionCommand(
      repo,
      ["add", valid],
      { write(text) { output += text; } },
      runtimeDirectory,
      repo
    ), 0);
    const receipt = JSON.parse(output) as {
      subscription: {
        callback: {
          providerSessionId: string;
          workspace: string;
          localSessionId?: string;
        };
      };
    };
    assert.deepEqual(receipt.subscription.callback, {
      providerSessionId: "desktop-provider-session",
      adapterId: "codex-runtime-jsonl-v1",
      workspace: realpathSync(repo),
      prompt: "Report completion."
    });

    const legacy = join(repo, "legacy-subscription.json");
    writeFileSync(legacy, JSON.stringify({
      schemaVersion: 1,
      ownerAgentId: owner.principalId,
      plugin: { path: plugin, id: "fixture", config: {} },
      callback: {
        sessionId: "ses_legacy",
        prompt: "Report completion."
      },
      schedule: {
        intervalMilliseconds: 1_000,
        maxWaitMilliseconds: 60_000,
        maxAttempts: 60
      }
    }));
    assert.throws(
      () => runSubscriptionCommand(
        repo,
        ["add", legacy],
        { write() {} },
        runtimeDirectory,
        repo
      ),
      /callback has unknown field: sessionId/
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

function input(
  ownerAgentId: string,
  providerSessionId: string,
  workspace: string,
  pluginPath: string
): RegisterPollSubscriptionInput {
  return {
    ownerAgentId,
    pluginPath,
    pluginId: "fixture",
    pluginConfig: {},
    callback: { providerSessionId, workspace, prompt: "Report completion." },
    intervalMilliseconds: 1_000,
    maxWaitMilliseconds: 60_000,
    maxAttempts: 60,
    allowedHttpOrigins: [],
    allowedExecutables: [],
    allowedEnvironment: [],
    probeTimeoutMilliseconds: 1_000,
    maxOutputBytes: 4_096
  };
}

function seedSession(
  database: string,
  agentId: string,
  adapterId: string,
  workspace: string
): { readonly sessionId: string; readonly providerSessionId: string } {
  const runtime = new RuntimeStore(database);
  try {
    runtime.appendEvent({
      type: "agent.request",
      source: { kind: "cli" },
      agentId,
      prompt: "seed"
    });
    const execution = runtime.claimDueExecutions()[0]!;
    const providerSessionId = `${agentId}-provider-session`;
    const result = runtime.completeExecution(execution.executionId, {
      adapterId,
      providerSessionId,
      workspace,
      output: "seeded"
    });
    assert.equal(result?.type, "agent.result");
    const resultExecution = runtime.claimDueExecutions().find(
      (candidate) => candidate.handler === "result"
    );
    assert.ok(resultExecution);
    runtime.completeResultExecution(resultExecution.executionId);
    return { sessionId: result.sessionId!, providerSessionId };
  } finally {
    runtime.close();
  }
}
