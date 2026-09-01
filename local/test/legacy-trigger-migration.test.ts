import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  applyLegacyTriggerMigration,
  legacyTriggerMigrationPlan
} from "../src/application/steward/legacy-migration.js";
import { ScheduledTaskStore } from "../src/capabilities/scheduled-task/store.js";
import { ContinuousSubscriptionStore } from
  "../src/capabilities/subscription/continuous-store.js";
import { SubscriptionStore } from "../src/capabilities/subscription/store.js";
import { localId } from "../src/core/id.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("legacy migration plans and atomically pauses exact definitions behind Steward Runs", () => {
  const repo = gitFixture();
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-legacy-migrate-runtime-"));
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    initializeRuntimeSchema(paths.database);
    bootstrapLocalFoundation(paths, "2026-08-26T05:00:00.000Z");
    const foundation = new LocalFoundationStore(paths.database);
    foundation.addAgent("codex", "codex", "2026-08-26T05:00:00.000Z");
    const worker = foundation.addAgent("worker", "codex", "2026-08-26T05:00:00.000Z");
    foundation.close();
    const workspace = realpathSync(repo);
    const pluginPath = realpathSync(join(repo, "probe.mjs"));
    writeFileSync(paths.subscriptionPlugins, JSON.stringify({
      schemaVersion: "SubscriptionPluginRegistry@1",
      plugins: [{
        ref: "plugin:migration-probe@1",
        pluginPath: pathToFileURL(pluginPath).href,
        pluginId: "migration-probe",
        workspaceRef: pathToFileURL(workspace).href,
        triggerKinds: ["until", "continuous"],
        allowedHttpOrigins: [],
        allowedExecutables: []
      }]
    }));
    const scheduleStore = new ScheduledTaskStore(paths.database);
    const schedule = scheduleStore.create({
      ownerPrincipalId: worker.principalId,
      agentId: worker.principalId,
      kind: "cron",
      expression: "0 9 * * *",
      timezone: "Asia/Shanghai",
      misfirePolicy: "skip",
      overlapPolicy: "queue",
      misfireGraceMilliseconds: 60_000,
      sessionPolicy: "new_each_run",
      prompt: "Legacy cron",
      workspace,
      callbacks: [agentCallback(worker.principalId, workspace, "read", "Migrate cron")]
    }, "2026-08-26T05:00:00.000Z");
    scheduleStore.close();
    const pluginDigest = `sha256:${createHash("sha256")
      .update(readFileSync(pluginPath)).digest("hex")}`;
    const subscriptionStore = new SubscriptionStore(paths.database);
    const oneShotCallback = agentCallback(
      worker.principalId,
      workspace,
      "read",
      "Migrate one-shot"
    );
    const oneShot = subscriptionStore.create({
      schemaVersion: 3,
      revision: "legacy-one-shot-v1",
      title: "Legacy one-shot",
      ownerAgentId: worker.principalId,
      probe: {
        plugin: {
          path: pluginPath,
          id: "migration-probe",
          schemaVersion: 1,
          config: { mode: "until" }
        },
        artifactRevision: pluginDigest,
        artifactDigest: pluginDigest,
        policy: probePolicy(workspace)
      },
      intervalMilliseconds: 1_000,
      maxWaitMilliseconds: 60_000,
      maxAttempts: 60,
      callbacks: [oneShotCallback],
      approvedGrantDigest: grantDigest([oneShotCallback.grant])
    }, "2026-08-26T05:00:00.000Z");
    subscriptionStore.close();
    const continuousStore = new ContinuousSubscriptionStore(paths.database);
    const continuous = continuousStore.create({
      schemaVersion: "ContinuousSubscriptionDefinition@1",
      revision: 1,
      title: "Legacy continuous",
      ownerAgentId: worker.principalId,
      probe: {
        plugin: {
          path: pluginPath,
          id: "migration-probe",
          config: { mode: "continuous" }
        },
        policy: probePolicy(workspace)
      },
      intervalMilliseconds: 1_000,
      callbacks: [agentCallback(
        worker.principalId,
        workspace,
        "write",
        "Migrate continuous"
      )]
    }, "2026-08-26T05:00:00.000Z");
    continuousStore.close();

    const plan = legacyTriggerMigrationPlan(
      repo,
      runtimeDirectory,
      "2026-08-26T05:01:00.000Z"
    );
    assert.deepEqual(plan.summary, {
      ready: 3,
      owner_decision: 0,
      blocked_reconcile: 0,
      already_applied: 0
    }, JSON.stringify(plan.proposals.map(({ source, reasons }) => ({ source, reasons }))));
    assert.deepEqual(
      plan.proposals.map(({ candidate }) => candidate?.intent.triggerIntent).sort(),
      ["continuous", "cron", "until"]
    );
    assert.ok(plan.proposals.every(({ candidate }) =>
      candidate?.authorityDelta.newNetworkAccess === false
    ));
    const dryRunRead = openRuntimeDatabase(paths.database);
    try {
      const row = dryRunRead.prepare(`
        SELECT count(*) AS count FROM agent_runs
      `).get() as { count: number };
      assert.equal(row.count, 0);
    } finally {
      dryRunRead.close();
    }
    const receipts = plan.proposals.map((proposal) => applyLegacyTriggerMigration(
      repo,
      approval(proposal),
      runtimeDirectory,
      "2026-08-26T05:02:00.000Z"
    ));
    assert.deepEqual(receipts.map(({ status }) => status), ["applied", "applied", "applied"]);
    const pausedSchedules = new ScheduledTaskStore(paths.database);
    const pausedOneShot = new SubscriptionStore(paths.database);
    const pausedContinuous = new ContinuousSubscriptionStore(paths.database);
    assert.equal(pausedSchedules.require(schedule.definition.scheduleId).definition.status, "paused");
    assert.equal(pausedOneShot.require(oneShot.subscriptionId).status, "paused");
    assert.equal(pausedContinuous.require(continuous.subscriptionId).status, "paused");
    pausedSchedules.close();
    pausedOneShot.close();
    pausedContinuous.close();
    const database = openRuntimeDatabase(paths.database);
    try {
      const runs = database.prepare(`
        SELECT owner_request_id, orchestrator_binding_json FROM agent_runs
        WHERE owner_request_id LIKE 'legacy-migration:%'
      `).all() as unknown as Array<{
        owner_request_id: string;
        orchestrator_binding_json: string;
      }>;
      assert.equal(runs.length, 3);
      assert.ok(runs.every(({ orchestrator_binding_json }) =>
        JSON.parse(orchestrator_binding_json).schemaVersion === "OrchestratorBinding@3"
      ));
      const durableReceipts = database.prepare(`
        SELECT count(*) AS count FROM legacy_trigger_migration_receipts
      `).get() as { count: number };
      assert.equal(durableReceipts.count, 3);
    } finally {
      database.close();
    }
    writeFileSync(paths.subscriptionPlugins, "{malformed-registry");
    const after = legacyTriggerMigrationPlan(repo, runtimeDirectory);
    assert.equal(after.summary.already_applied, 3);
    const replay = applyLegacyTriggerMigration(
      repo,
      approval(after.proposals[0]!),
      runtimeDirectory
    );
    assert.equal(replay.status, "duplicate");
    assert.equal(replay.runId, receipts.find(
      ({ source }) => source.id === replay.source.id
    )?.runId);

    const rollbackStore = new ScheduledTaskStore(paths.database);
    const rollbackSchedule = rollbackStore.create({
      ownerPrincipalId: worker.principalId,
      agentId: worker.principalId,
      kind: "cron",
      expression: "30 9 * * *",
      timezone: "Asia/Shanghai",
      misfirePolicy: "skip",
      overlapPolicy: "queue",
      misfireGraceMilliseconds: 60_000,
      sessionPolicy: "new_each_run",
      prompt: "Rollback fixture",
      workspace,
      callbacks: [agentCallback(worker.principalId, workspace, "read", "Rollback")]
    }, "2026-08-26T05:03:00.000Z");
    rollbackStore.close();
    const rollbackProposal = legacyTriggerMigrationPlan(repo, runtimeDirectory).proposals.find(
      ({ source }) => source.id === rollbackSchedule.definition.scheduleId
    )!;
    const guarded = openRuntimeDatabase(paths.database);
    try {
      guarded.exec(`
        CREATE TRIGGER reject_test_migration_pause
        BEFORE UPDATE OF status ON schedules
        WHEN OLD.schedule_id = '${rollbackSchedule.definition.scheduleId}'
        BEGIN SELECT RAISE(ABORT, 'test-pause-rejected'); END;
      `);
    } finally {
      guarded.close();
    }
    assert.throws(() => applyLegacyTriggerMigration(
      repo,
      approval(rollbackProposal),
      runtimeDirectory,
      "2026-08-26T05:04:00.000Z"
    ), /test-pause-rejected/);
    const rollbackRead = openRuntimeDatabase(paths.database);
    try {
      const sourceRow = rollbackRead.prepare(`
        SELECT status FROM schedules WHERE schedule_id = ?
      `).get(rollbackSchedule.definition.scheduleId) as { status: string };
      const runRow = rollbackRead.prepare(`
        SELECT count(*) AS count FROM agent_runs WHERE owner_request_id = ?
      `).get(rollbackProposal.migrationRequestId) as { count: number };
      const receiptRows = rollbackRead.prepare(`
        SELECT count(*) AS count FROM legacy_trigger_migration_receipts
      `).get() as { count: number };
      assert.equal(sourceRow.status, "active");
      assert.equal(runRow.count, 0);
      assert.equal(receiptRows.count, 3);
    } finally {
      rollbackRead.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("legacy command callback requires an exact Owner workflow mapping", () => {
  const repo = gitFixture();
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-command-migrate-runtime-"));
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    initializeRuntimeSchema(paths.database);
    bootstrapLocalFoundation(paths, "2026-08-27T08:00:00.000Z");
    const foundation = new LocalFoundationStore(paths.database);
    foundation.addAgent("codex", "codex", "2026-08-27T08:00:00.000Z");
    const owner = foundation.addAgent("owner", "codex", "2026-08-27T08:00:00.000Z");
    foundation.close();
    const workspace = realpathSync(repo);
    const pluginPath = realpathSync(join(repo, "probe.mjs"));
    writeFileSync(paths.subscriptionPlugins, JSON.stringify({
      schemaVersion: "SubscriptionPluginRegistry@1",
      plugins: [{
        ref: "plugin:migration-probe@1",
        pluginPath: pathToFileURL(pluginPath).href,
        pluginId: "migration-probe",
        workspaceRef: pathToFileURL(workspace).href,
        triggerKinds: ["continuous"],
        allowedHttpOrigins: [],
        allowedExecutables: [process.execPath]
      }]
    }));
    const callbackId = "monitor-notify";
    const callback = commandCallback(callbackId, workspace);
    const store = new ContinuousSubscriptionStore(paths.database);
    const legacy = store.create({
      schemaVersion: "ContinuousSubscriptionDefinition@1",
      revision: 1,
      title: "Legacy monitor",
      ownerAgentId: owner.principalId,
      probe: {
        plugin: {
          path: pluginPath,
          id: "migration-probe",
          config: { mode: "continuous" }
        },
        policy: {
          ...probePolicy(workspace),
          allowedExecutables: [process.execPath]
        }
      },
      intervalMilliseconds: 1_000,
      callbacks: [callback]
    }, "2026-08-27T08:00:02.000Z");
    store.close();

    const blocked = legacyTriggerMigrationPlan(repo, runtimeDirectory);
    assert.equal(blocked.summary.owner_decision, 1);
    assert.match(blocked.proposals[0]!.reasons[0]!, /Owner-approved versioned workflow/);

    writeFileSync(paths.legacyTriggerWorkflows, JSON.stringify({
      schemaVersion: "LegacyTriggerWorkflowRegistry@1",
      mappings: [{
        source: {
          kind: "continuous_subscription",
          id: legacy.subscriptionId,
          definitionRevision: "1"
        },
        callbackId,
        workflowRef: "continuous-observation-monitor@1",
        participantRef: `principal:${owner.principalId}`,
        terminalResultPolicy: "deliver"
      }]
    }));
    const missingDestination = legacyTriggerMigrationPlan(repo, runtimeDirectory);
    assert.equal(missingDestination.summary.owner_decision, 1);
    assert.match(
      missingDestination.proposals[0]!.reasons[0]!,
      /resultDestinationRef is required only/
    );

    writeFileSync(paths.legacyTriggerWorkflows, JSON.stringify({
      schemaVersion: "LegacyTriggerWorkflowRegistry@1",
      mappings: [{
        source: {
          kind: "continuous_subscription",
          id: legacy.subscriptionId,
          definitionRevision: "1"
        },
        callbackId,
        workflowRef: "continuous-observation-monitor@1",
        participantRef: `principal:${owner.principalId}`,
        terminalResultPolicy: "retain"
      }]
    }));
    const ready = legacyTriggerMigrationPlan(repo, runtimeDirectory);
    assert.equal(ready.summary.ready, 1, JSON.stringify(ready.proposals));
    assert.equal(ready.proposals[0]!.candidate?.mandate?.kind, "workflow");
    assert.match(
      ready.proposals[0]!.candidate?.workflowArtifactDigest ?? "",
      /^sha256:[0-9a-f]{64}$/
    );
    assert.equal(ready.proposals[0]!.candidate?.intent.resultDestinationRef, undefined);
    assert.equal(
      Object.hasOwn(ready.proposals[0]!.candidate?.authorityDelta ?? {}, "resultDestinationRef"),
      false
    );
    const receipt = applyLegacyTriggerMigration(
      repo,
      approval(ready.proposals[0]!),
      runtimeDirectory,
      "2026-08-27T08:00:03.000Z"
    );
    assert.equal(receipt.status, "applied");
    const read = openRuntimeDatabase(paths.database);
    try {
      const source = read.prepare(`
        SELECT status FROM continuous_subscriptions WHERE subscription_id = ?
      `).get(legacy.subscriptionId) as { status: string };
      const run = read.prepare(`
        SELECT mandate_snapshot_json FROM agent_runs WHERE run_id = ?
      `).get(receipt.runId) as { mandate_snapshot_json: string };
      assert.equal(source.status, "paused");
      const mandate = JSON.parse(run.mandate_snapshot_json) as {
        kind: string;
        workflowRef: string;
      };
      assert.equal(mandate.kind, "workflow");
      assert.equal(mandate.workflowRef, "continuous-observation-monitor@1");
    } finally {
      read.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

function approval(proposal: {
  readonly proposalDigest: string;
  readonly source: {
    readonly kind: "schedule" | "subscription" | "continuous_subscription";
    readonly id: string;
    readonly definitionRevision: string;
  };
}) {
  return {
    schemaVersion: "LegacyTriggerMigrationApproval@1",
    proposalDigest: proposal.proposalDigest,
    source: {
      kind: proposal.source.kind,
      id: proposal.source.id,
      definitionRevision: proposal.source.definitionRevision
    }
  };
}

function agentCallback(
  agentId: string,
  workspace: string,
  access: "read" | "write",
  prompt: string
) {
  const callbackId = localId("scb");
  return {
    callbackId,
    kind: "agent.invoke" as const,
    definition: {
      schemaVersion: "ProactiveCallbackDefinition@1",
      callbackId,
      kind: "agent.invoke",
      agentId,
      workspace,
      prompt
    },
    grant: {
      schemaVersion: "ProactiveCallbackGrant@1",
      kind: "agent.invoke",
      agentId,
      workspace,
      workspaceAccess: access,
      networkAccess: false
    }
  };
}

function commandCallback(callbackId: string, workspace: string) {
  return {
    callbackId,
    kind: "command.exec" as const,
    definition: {
      schemaVersion: "ProactiveCallbackDefinition@1",
      callbackId,
      kind: "command.exec",
      runtime: "host",
      executable: process.execPath,
      argv: ["--version"],
      cwd: workspace,
      environment: {},
      timeoutMilliseconds: 1_000,
      maxOutputBytes: 4_096
    },
    grant: {
      schemaVersion: "ProactiveCallbackGrant@1",
      kind: "command.exec",
      runtime: "host",
      executable: process.execPath,
      argv: ["--version"],
      cwd: workspace,
      environment: {},
      filesystemRoots: [workspace],
      networkAccess: true,
      timeoutMilliseconds: 1_000,
      maxOutputBytes: 4_096,
      secretReferences: []
    }
  };
}

function probePolicy(workspaceRoot: string) {
  return {
    workspaceRoot,
    allowedHttpOrigins: [] as string[],
    allowedExecutables: [] as string[],
    allowedEnvironment: [] as string[],
    timeoutMilliseconds: 1_000,
    maxOutputBytes: 4_096
  };
}

function grantDigest(value: unknown): string {
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

function gitFixture(): string {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-legacy-migrate-repo-"));
  writeFileSync(join(repo, "README.md"), "fixture\n");
  writeFileSync(join(repo, "probe.mjs"), [
    "export default {",
    "kind: 'subscription.probe', id: 'migration-probe', schemaVersion: 1,",
    "plan() { return { kind: 'exec', executable: '/usr/bin/true', argv: [] }; },",
    "evaluate() { return { version: '1', facts: {}, terminal: 'success' }; }",
    "};"
  ].join("\n"));
  git(repo, ["init"]);
  git(repo, ["add", "README.md", "probe.mjs"]);
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
