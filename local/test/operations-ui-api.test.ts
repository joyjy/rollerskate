import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listRuntimeFailures } from "../src/application/runtime/failure-query.js";
import {
  createSchedule
} from "../src/application/schedule/control.js";
import { pageScheduleViews } from "../src/application/schedule/query.js";
import {
  cancelStewardRun,
  startStewardRun
} from "../src/application/steward/control.js";
import { latestStewardRunView } from "../src/application/steward/query.js";
import { ScheduledTaskStore } from "../src/capabilities/scheduled-task/store.js";
import { startUiServer } from "../src/entrypoints/console/launcher.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("Steward and Schedule Console controls remain guarded", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-operations-ui-repo-"));
  const runtimeDirectory = mkdtempSync(
    join(tmpdir(), "rollerskate-operations-ui-runtime-")
  );
  const paths = runtimePaths(repo, runtimeDirectory);
  const controller = new AbortController();
  try {
    initializeRuntimeSchema(paths.database);
    bootstrapLocalFoundation(paths, "2026-07-25T00:00:00.000Z");
    git(paths.workspace, ["init"]);
    git(paths.workspace, ["config", "user.name", "Rollerskate Test"]);
    git(paths.workspace, ["config", "user.email", "test@example.invalid"]);
    const subject = join(paths.workspace, "acceptance.md");
    writeFileSync(subject, "# Acceptance\n");
    git(paths.workspace, ["add", "acceptance.md"]);
    git(paths.workspace, ["commit", "-m", "acceptance"]);

    const foundation = new LocalFoundationStore(paths.database);
    foundation.addAgent("scheduler", "codex", "2026-07-25T00:00:00.000Z");
    foundation.addAgent("codex", "codex", "2026-07-25T00:00:00.000Z");
    foundation.addAgent("steward", "codex", "2026-07-25T00:00:00.000Z");
    foundation.addAgent("reviewer", "codex", "2026-07-25T00:00:00.000Z");
    foundation.addAgent("implementer", "codex", "2026-07-25T00:00:00.000Z");
    foundation.close();
    const agentRun = startStewardRun(repo, {
      objective: `Review ${subject}`,
      steward: "steward",
      requestId: "operations-ui-run",
      workspace: {
        root: paths.workspace,
        access: "read"
      }
    }, runtimeDirectory, "2026-07-25T00:01:00.000Z");

    const schedule = createSchedule(repo, {
      agent: "scheduler",
      kind: "once",
      expression: "2099-07-25T01:00:00.000Z",
      misfirePolicy: "run_once",
      overlapPolicy: "queue",
      misfireGraceMilliseconds: 60_000,
      sessionPolicy: "new_each_run",
      prompt: "Run fixture"
    }, runtimeDirectory, "2026-07-25T00:02:00.000Z");
    const scheduleId = schedule.schedule.definition.scheduleId;
    for (let index = 0; index < 21; index += 1) {
      createSchedule(repo, {
        agent: "scheduler",
        kind: "once",
        expression: `2099-08-${String(index + 1).padStart(2, "0")}T01:00:00.000Z`,
        misfirePolicy: "run_once",
        overlapPolicy: "queue",
        misfireGraceMilliseconds: 60_000,
        sessionPolicy: "new_each_run",
        prompt: `Paged fixture ${index}`
      }, runtimeDirectory, `2026-07-25T00:00:${String(index).padStart(2, "0")}.000Z`);
    }
    const schedules = new ScheduledTaskStore(paths.database);
    const run = schedules.insertRun({
      scheduleId,
      occurrenceKey: "manual:legacy-diagnostics",
      scheduledFor: "2026-07-25T00:03:00.000Z",
      scheduleRevision: schedule.schedule.definition.currentRevision,
      status: "queued",
      decisionReason: "legacy-diagnostics-fixture",
      createdAt: "2026-07-25T00:03:00.000Z"
    }).run;
    schedules.patchRun(run.runId, {
      status: "unknown",
      decisionReason: "provider-outcome-unknown"
    }, "2026-07-25T00:04:00.000Z");
    schedules.close();

    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const server = await startUiServer({
      repoRoot,
      runtimeDirectory,
      port: 0,
      signal: controller.signal
    });
    try {
      const origin = new URL(server.url).origin;
      const latestRunResponse = await fetch(`${origin}/api/runs/latest`);
      assert.equal(latestRunResponse.status, 200);
      assert.deepEqual(
        await latestRunResponse.json(),
        latestStewardRunView(repo, runtimeDirectory)
      );
      const runResponse = await fetch(
        `${origin}/api/runs/${agentRun.run.runId}`
      );
      assert.equal(runResponse.status, 200);
      assert.equal((await runResponse.json() as {
        summary: { runId: string; status: string };
      }).summary.runId, agentRun.run.runId);
      cancelStewardRun(repo, agentRun.run.runId, runtimeDirectory);
      const rejectedArchive = await fetch(
        `${origin}/api/runs/${agentRun.run.runId}/archive`,
        { method: "POST" }
      );
      assert.equal(rejectedArchive.status, 403);
      const archived = await fetch(
        `${origin}/api/runs/${agentRun.run.runId}/archive`,
        {
          method: "POST",
          headers: { "X-Rollerskate-Request": "console" }
        }
      );
      assert.equal(archived.status, 200);
      assert.equal((await archived.json() as { status: string }).status, "archived");
      assert.deepEqual(await (await fetch(`${origin}/api/runs`)).json(), {
        items: [], total: 0, page: 1, pageSize: 20
      });
      assert.equal((await (await fetch(
        `${origin}/api/runs?archive=archived`
      )).json() as { items: Array<{ runId: string }> }).items[0]?.runId, agentRun.run.runId);
      assert.equal((await (await fetch(
        `${origin}/api/runs?archive=archived&q=${encodeURIComponent("acceptance.md")}`
      )).json() as { total: number }).total, 1);
      const rejectedCallerAuthority = await fetch(`${origin}/api/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Rollerskate-Request": "console"
        },
        body: JSON.stringify({
          requestId: "operations-ui-caller-invalid",
          steward: "steward",
          objective: "inspect safely",
          orchestration: { mode: "caller", networkAccess: true }
        })
      });
      assert.equal(rejectedCallerAuthority.status, 400);
      const admittedIntent = await fetch(`${origin}/api/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Rollerskate-Request": "console"
        },
        body: JSON.stringify({
          schemaVersion: "RunIntent@1",
          requestId: "operations-ui-intent",
          objective: "Inspect the Console admission boundary",
          acceptance: ["Return exact evidence"],
          contextRefs: ["console:test"],
          terminalEvidence: ["Run receipt"]
        })
      });
      assert.equal(admittedIntent.status, 200);
      assert.equal((await admittedIntent.json() as {
        run: { orchestratorBinding?: { schemaVersion: string } };
      }).run.orchestratorBinding?.schemaVersion, "OrchestratorBinding@3");
      const rejectedDecision = await fetch(
        `${origin}/api/runs/${agentRun.run.runId}/decide`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: "unauthorized", decision: {} })
        }
      );
      assert.equal(rejectedDecision.status, 403);
      const scheduleResponse = await fetch(`${origin}/api/schedules`);
      assert.equal(scheduleResponse.status, 200);
      assert.deepEqual(
        await scheduleResponse.json(),
        pageScheduleViews(repo, {}, runtimeDirectory)
      );
      const schedulePageTwo = await (await fetch(
        `${origin}/api/schedules?page=2&pageSize=20`
      )).json() as { items: unknown[]; total: number; page: number };
      assert.equal(schedulePageTwo.total, 22);
      assert.equal(schedulePageTwo.items.length, 2);
      assert.equal(schedulePageTwo.page, 2);
      const scheduleDetail = await fetch(`${origin}/api/schedules/${scheduleId}`);
      assert.equal(scheduleDetail.status, 200);
      const scheduleView = await scheduleDetail.json() as {
        summary: {
          status: string;
          runCounts: { unknown: number };
          availableActions: { pause: boolean; resume: boolean };
        };
        runs: Array<{
          runId: string;
          availableActions: { resolveSucceeded: boolean };
          failure: {
            failureRef: string;
            consoleRoute: string;
          };
        }>;
      };
      assert.equal(scheduleView.summary.status, "active");
      assert.equal(scheduleView.summary.runCounts.unknown, 1);
      assert.equal(scheduleView.summary.availableActions.pause, true);
      assert.equal(scheduleView.runs[0]?.runId, run.runId);
      assert.equal(scheduleView.runs[0]?.availableActions.resolveSucceeded, true);
      assert.deepEqual(scheduleView.runs[0]?.failure, {
        failureRef: `failure:schedule:${run.runId}`,
        consoleRoute:
          `/console/runtime?failureRef=${encodeURIComponent(`failure:schedule:${run.runId}`)}`
      });
      const scheduleFailure = listRuntimeFailures(repo, runtimeDirectory)
        .find((candidate) => candidate.failureRef === `failure:schedule:${run.runId}`);
      assert.equal(
        scheduleFailure?.action.consoleRoute,
        `/console/schedules?scheduleId=${scheduleId}`
      );

      const rejectedPause = await fetch(
        `${origin}/api/schedules/${scheduleId}/pause`,
        { method: "POST" }
      );
      assert.equal(rejectedPause.status, 403);
      const paused = await fetch(`${origin}/api/schedules/${scheduleId}/pause`, {
        method: "POST",
        headers: { "X-Rollerskate-Request": "console" }
      });
      assert.equal(paused.status, 200);
      assert.equal((await paused.json() as {
        summary: { status: string; availableActions: { resume: boolean } };
      }).summary.availableActions.resume, true);

      const resolved = await fetch(
        `${origin}/api/schedules/${scheduleId}/runs/${run.runId}/resolve`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Rollerskate-Request": "console"
          },
          body: JSON.stringify({ outcome: "succeeded" })
        }
      );
      assert.equal(resolved.status, 200);
      assert.equal((await resolved.json() as {
        run: { status: string; availableActions: { resolveFailed: boolean } };
      }).run.status, "succeeded");

      const cancelled = await fetch(`${origin}/api/schedules/${scheduleId}/cancel`, {
        method: "POST",
        headers: { "X-Rollerskate-Request": "console" }
      });
      assert.equal(cancelled.status, 200);
      const archivedSchedule = await fetch(
        `${origin}/api/schedules/${scheduleId}/archive`,
        { method: "POST", headers: { "X-Rollerskate-Request": "console" } }
      );
      assert.equal(archivedSchedule.status, 200);
      assert.equal((await archivedSchedule.json() as { status: string }).status, "archive");
      const archivedSchedules = await (await fetch(
        `${origin}/api/schedules?archive=archived&q=scheduler`
      )).json() as { total: number; items: Array<{ scheduleId: string }> };
      assert.equal(archivedSchedules.total, 1);
      assert.equal(archivedSchedules.items[0]?.scheduleId, scheduleId);
    } finally {
      controller.abort();
      await server.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

function git(cwd: string, arguments_: readonly string[]): void {
  const result = spawnSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) throw new Error(result.stderr);
}
