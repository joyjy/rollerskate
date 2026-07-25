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

import { createReview } from "../src/application/review/control.js";
import { listReviewViews } from "../src/application/review/query.js";
import { listRuntimeFailures } from "../src/application/runtime/failure-query.js";
import {
  createSchedule,
  runScheduleNow
} from "../src/application/schedule/control.js";
import { listScheduleViews } from "../src/application/schedule/query.js";
import { ScheduledTaskStore } from "../src/capabilities/scheduled-task/store.js";
import { startUiServer } from "../src/entrypoints/console/launcher.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("Review and Schedule Console APIs reuse application views and guarded controls", async () => {
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
    foundation.addAgent("reviewer", "codex", "2026-07-25T00:00:00.000Z");
    foundation.addAgent("implementer", "kimi-code", "2026-07-25T00:00:00.000Z");
    foundation.addAgent("scheduler", "codex", "2026-07-25T00:00:00.000Z");
    foundation.close();

    const review = createReview(repo, {
      subjectRef: subject,
      reviewer: "reviewer",
      implementer: "implementer",
      reworkLimit: 2,
      requestId: "operations-ui-review"
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
    const run = runScheduleNow(
      repo,
      scheduleId,
      "operations-ui-run",
      runtimeDirectory,
      "2026-07-25T00:03:00.000Z"
    ).run;
    const schedules = new ScheduledTaskStore(paths.database);
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
      const reviewResponse = await fetch(`${origin}/api/reviews`);
      assert.equal(reviewResponse.status, 200);
      assert.deepEqual(
        await reviewResponse.json(),
        listReviewViews(repo, runtimeDirectory)
      );
      const reviewDetail = await fetch(
        `${origin}/api/reviews/${review.rootEventId}`
      );
      assert.equal(reviewDetail.status, 200);
      const reviewView = await reviewDetail.json() as {
        summary: {
          phase: string;
          findings: { open: number };
          availableActions: { recover: boolean };
          failure: null | { failureRef: string };
        };
        audit: Array<{
          execution: {
            firstStartedAt: string | null;
            lastAttemptAt: string | null;
            completedAt: string | null;
          } | null;
          lifecycleChangedAt: string;
          reasonForIntervention: string | null;
          directChildren: unknown[];
          causalityBoundary: string | null;
        }>;
      };
      assert.equal(reviewView.summary.phase, "reviewing");
      assert.equal(reviewView.summary.findings.open, 0);
      assert.equal(reviewView.summary.availableActions.recover, false);
      assert.equal(reviewView.summary.failure, null);
      assert.equal(reviewView.audit[0]?.execution?.firstStartedAt, null);
      assert.equal(reviewView.audit[0]?.execution?.lastAttemptAt, null);
      assert.equal(reviewView.audit[0]?.execution?.completedAt, null);
      assert.equal(
        reviewView.audit[0]?.lifecycleChangedAt,
        "2026-07-25T00:01:00.000Z"
      );
      const rejectedReviewRecover = await fetch(
        `${origin}/api/reviews/${review.rootEventId}/recover`,
        { method: "POST" }
      );
      assert.equal(rejectedReviewRecover.status, 403);

      const scheduleResponse = await fetch(`${origin}/api/schedules`);
      assert.equal(scheduleResponse.status, 200);
      assert.deepEqual(
        await scheduleResponse.json(),
        listScheduleViews(repo, runtimeDirectory)
      );
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
