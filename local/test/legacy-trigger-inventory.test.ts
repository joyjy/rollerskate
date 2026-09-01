import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ScheduledTaskStore } from "../src/capabilities/scheduled-task/store.js";
import { runStewardCommand } from "../src/entrypoints/cli/run.js";
import { CallbackStore } from "../src/infrastructure/callback/store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("legacy inventory classifies definitions without advancing callbacks or Runs", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-legacy-inventory-repo-"));
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-legacy-inventory-runtime-"));
  try {
    const paths = runtimePaths(repo, runtime);
    initializeRuntimeSchema(paths.database);
    bootstrapLocalFoundation(paths, "2026-08-26T00:00:00.000Z");
    const foundation = new LocalFoundationStore(paths.database);
    const agent = foundation.addAgent("worker", "codex", "2026-08-26T00:00:00.000Z");
    foundation.close();
    const workspace = realpathSync(repo);
    const executable = realpathSync(process.execPath);
    const schedules = new ScheduledTaskStore(paths.database);
    const schedule = schedules.create({
      ownerPrincipalId: agent.principalId,
      agentId: agent.principalId,
      kind: "once",
      expression: "2099-08-26T09:00:00.000Z",
      misfirePolicy: "run_once",
      overlapPolicy: "queue",
      misfireGraceMilliseconds: 60_000,
      sessionPolicy: "new_each_run",
      prompt: "Inspect inventory",
      workspace,
      callbacks: [
        {
          callbackId: "agent-work",
          kind: "agent.invoke",
          definition: {
            schemaVersion: "ProactiveCallbackDefinition@1",
            callbackId: "agent-work",
            kind: "agent.invoke",
            agentId: agent.principalId,
            workspace,
            prompt: "Inspect inventory"
          },
          grant: {
            schemaVersion: "ProactiveCallbackGrant@1",
            kind: "agent.invoke",
            agentId: agent.principalId,
            workspace,
            workspaceAccess: "read",
            networkAccess: false
          }
        },
        {
          callbackId: "command-work",
          kind: "command.exec",
          definition: {
            schemaVersion: "ProactiveCallbackDefinition@1",
            callbackId: "command-work",
            kind: "command.exec",
            runtime: "host",
            executable,
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
            executable,
            argv: ["--version"],
            cwd: workspace,
            environment: {},
            filesystemRoots: [workspace],
            networkAccess: true,
            timeoutMilliseconds: 1_000,
            maxOutputBytes: 4_096,
            secretReferences: []
          }
        }
      ]
    }, "2026-08-26T00:00:00.000Z");
    schedules.close();
    const callbacks = new CallbackStore(paths.database);
    const occurrences = callbacks.materialize({
      kind: "schedule",
      id: schedule.definition.scheduleId,
      revision: 1
    }, "occurrence-1", "2026-08-26T00:01:00.000Z");
    assert.deepEqual(occurrences.map(({ status }) => status), ["pending", "pending"]);

    let output = "";
    assert.equal(runStewardCommand(
      repo,
      ["legacy-inventory"],
      { write(value) { output += value; } },
      runtime
    ), 0);
    const inventory = JSON.parse(output) as {
      summary: {
        definitionOwners: number;
        callbackDefinitions: number;
        automaticAgentMappings: number;
        ownerDecisions: number;
        unterminatedOccurrences: number;
      };
      definitions: Array<{
        callbacks: Array<{ migration: string; lastOccurrence?: { status: string } }>;
      }>;
    };
    assert.deepEqual(inventory.summary, {
      definitionOwners: 1,
      callbackDefinitions: 2,
      automaticAgentMappings: 1,
      ownerDecisions: 1,
      unterminatedOccurrences: 2
    });
    assert.deepEqual(
      inventory.definitions[0]!.callbacks.map(({ migration }) => migration),
      ["recompile_agent_run", "owner_decision_workflow"]
    );
    assert.deepEqual(
      inventory.definitions[0]!.callbacks.map(({ lastOccurrence }) => lastOccurrence?.status),
      ["pending", "pending"]
    );
    assert.deepEqual(
      callbacks.list({
        ownerKind: "schedule",
        ownerId: schedule.definition.scheduleId,
        triggerOccurrenceKey: "occurrence-1"
      }).map(({ status }) => status),
      ["pending", "pending"]
    );
    callbacks.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});
