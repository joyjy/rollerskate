import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { listSubscriptionViews } from "../src/application/subscription/control.js";
import { runSubscriptionCommand } from "../src/entrypoints/cli/subscription.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";

test("Subscription CLI uses v3 for add, list, inspect and control", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-subscription-cli-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-subscription-cli-runtime-"));
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    const agents = new LocalFoundationStore(paths.database);
    const owner = agents.addAgent("alice", "codex");
    agents.close();
    const workspace = realpathSync(repo);
    const plugin = join(workspace, "plugin.mjs");
    writeFileSync(plugin, "export default {};\n");
    const definition = join(workspace, "subscription.json");
    writeFileSync(definition, JSON.stringify({
      schemaVersion: 3,
      revision: "cli-v1",
      title: "One-shot subscription",
      ownerAgentId: owner.principalId,
      probe: {
        plugin: { path: plugin, id: "fixture", config: {} },
        artifactRevision: "fixture-v1",
        artifactDigest: `sha256:${createHash("sha256")
          .update(readFileSync(plugin)).digest("hex")}`,
        policy: {
          workspaceRoot: workspace,
          allowedHttpOrigins: [],
          allowedExecutables: [],
          allowedEnvironment: [],
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096
        }
      },
      callbacks: [],
      schedule: {
        intervalMilliseconds: 1_000,
        maxWaitMilliseconds: 60_000,
        maxAttempts: 60
      },
      approvedGrantDigest: createHash("sha256").update("[]").digest("base64url")
    }));

    let output = "";
    assert.equal(runSubscriptionCommand(
      repo,
      ["add", definition],
      { write(text) { output += text; } },
      runtimeDirectory,
      workspace
    ), 0);
    const created = JSON.parse(output) as {
      subscription: { subscriptionId: string; definitionSchema: string };
    };
    assert.equal(created.subscription.definitionSchema, "SubscriptionDefinition@3");

    output = "";
    runSubscriptionCommand(repo, ["list"], { write(text) { output += text; } }, runtimeDirectory);
    const listed = JSON.parse(output) as Array<{ id: string; kind: string }>;
    assert.deepEqual(listed.map(({ id, kind }) => ({ id, kind })), [{
      id: created.subscription.subscriptionId,
      kind: "free"
    }]);

    output = "";
    runSubscriptionCommand(
      repo,
      ["inspect", created.subscription.subscriptionId],
      { write(text) { output += text; } },
      runtimeDirectory
    );
    assert.equal((JSON.parse(output) as { definition: { schema: string } })
      .definition.schema, "SubscriptionDefinition@3");

    output = "";
    runSubscriptionCommand(
      repo,
      ["pause", created.subscription.subscriptionId],
      { write(text) { output += text; } },
      runtimeDirectory
    );
    assert.equal((JSON.parse(output) as { status: string }).status, "paused");

    const legacy = join(workspace, "legacy.json");
    writeFileSync(legacy, JSON.stringify({ schemaVersion: 2 }));
    assert.throws(
      () => runSubscriptionCommand(
        repo,
        ["add", legacy],
        { write() {} },
        runtimeDirectory,
        workspace
      ),
      /schemaVersion must be 3 or ContinuousSubscriptionDefinition@1/
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("Subscription add help exposes the trusted host command boundary", () => {
  let output = "";
  assert.equal(runSubscriptionCommand(
    "/unused",
    ["add", "--help"],
    { write: (text) => { output += text; } }
  ), 0);
  assert.match(output, /runtime must be "host"/);
  assert.match(output, /may start transitive child processes/);
  assert.match(output, /legacy runtime: "node" callbacks remain readable but cannot be added/);
});

test("Subscription CLI creates and controls a ContinuousSubscriptionDefinition@1", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-continuous-cli-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-continuous-cli-runtime-"));
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    const agents = new LocalFoundationStore(paths.database);
    const owner = agents.addAgent("continuous", "codex");
    agents.close();
    const plugin = join(repo, "continuous-plugin.mjs");
    writeFileSync(plugin, "export default {};\n");
    const definition = join(repo, "continuous.json");
    const workspace = realpathSync(repo);
    const callbackScript = join(workspace, "refresh.mjs");
    writeFileSync(callbackScript, "process.stdout.write('refresh');\n");
    writeFileSync(definition, JSON.stringify({
      schemaVersion: "ContinuousSubscriptionDefinition@1",
      revision: 1,
      title: "Continuous data refresh",
      ownerAgentId: owner.principalId,
      probe: {
        plugin: { path: plugin, id: "continuous-probe", config: {} },
        policy: {
          workspaceRoot: workspace,
          allowedHttpOrigins: [],
          allowedExecutables: [],
          allowedEnvironment: [],
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096
        }
      },
      callbacks: [{
        callbackId: "refresh",
        kind: "command.exec",
        definition: {
          schemaVersion: "ProactiveCallbackDefinition@1",
          callbackId: "refresh",
          kind: "command.exec",
          runtime: "host",
          executable: realpathSync(process.execPath),
          argv: [callbackScript],
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
          argv: [callbackScript],
          cwd: workspace,
          environment: {},
          filesystemRoots: [dirname(realpathSync(process.execPath)), workspace],
          networkAccess: true,
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096,
          secretReferences: []
        }
      }],
      schedule: { intervalMilliseconds: 1_000 }
    }));
    let output = "";
    assert.equal(runSubscriptionCommand(
      repo,
      ["add", definition],
      { write(value) { output += value; } },
      runtimeDirectory,
      workspace
    ), 0);
    const created = JSON.parse(output) as { kind: string; id: string; status: string };
    assert.deepEqual({ kind: created.kind, status: created.status }, {
      kind: "continuous",
      status: "active"
    });
    assert.equal(
      listSubscriptionViews(repo, runtimeDirectory).find(({ id }) => id === created.id)?.kind,
      "continuous"
    );
    output = "";
    runSubscriptionCommand(
      repo,
      ["pause", created.id],
      { write(value) { output += value; } },
      runtimeDirectory
    );
    assert.equal((JSON.parse(output) as { status: string }).status, "paused");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});
