import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { runAgentRunCommand } from "../src/entrypoints/cli/run.js";

test("Run CLI starts idempotently, lists, inspects, traces and cancels", () => {
  const fixture = setup();
  try {
    const config = join(fixture.repo, "run.json");
    writeFileSync(config, JSON.stringify({
      schemaVersion: 1,
      steward: "steward",
      objective: "Review the current implementation.",
      workspace: {
        root: fixture.workspace,
        access: "read"
      },
      maxSteps: 8,
      maxDepth: 3
    }));
    const created = command(fixture.repo, fixture.runtimeDirectory, [
      "start", config, "--request-id", "run-cli-1"
    ]) as {
      status: string;
      run: { runId: string; status: string };
      rootEventId: string;
    };
    const duplicate = command(fixture.repo, fixture.runtimeDirectory, [
      "start", config, "--request-id", "run-cli-1"
    ]) as {
      status: string;
      run: { runId: string };
    };
    assert.equal(created.status, "accepted");
    assert.equal(created.run.status, "active");
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.run.runId, created.run.runId);

    const listed = command(
      fixture.repo,
      fixture.runtimeDirectory,
      ["list"]
    ) as Array<{ runId: string }>;
    const inspected = command(fixture.repo, fixture.runtimeDirectory, [
      "inspect", created.run.runId
    ]) as {
      summary: { runId: string; status: string };
      timeline: Array<{ event: { prompt?: string } }>;
      exchanges: unknown[];
    };
    const traced = command(fixture.repo, fixture.runtimeDirectory, [
      "trace", created.run.runId
    ]) as { summary: { runId: string } };
    assert.equal(listed.length, 1);
    assert.equal(inspected.summary.runId, created.run.runId);
    assert.equal(inspected.timeline.length, 1);
    assert.match(
      inspected.timeline[0]?.event.prompt ?? "",
      new RegExp(fixture.childAgentId)
    );
    assert.match(inspected.timeline[0]?.event.prompt ?? "", /"handle": "child"/);
    assert.deepEqual(inspected.exchanges, []);
    assert.equal(traced.summary.runId, created.run.runId);

    const cancelled = command(fixture.repo, fixture.runtimeDirectory, [
      "cancel", created.run.runId
    ]) as {
      status: string;
      run: {
        status: string;
        activeStepId?: string;
        activeExecutionId?: string;
      };
      cancelledExecutions: number;
    };
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.run.status, "cancelled");
    assert.equal(cancelled.run.activeStepId, undefined);
    assert.equal(cancelled.run.activeExecutionId, undefined);
    assert.equal(cancelled.cancelledExecutions, 1);
    assert.equal((command(fixture.repo, fixture.runtimeDirectory, [
      "cancel", created.run.runId
    ]) as { status: string }).status, "already_terminal");
  } finally {
    fixture.close();
  }
});

test("Run admission allows concurrent reads but only one write per canonical workspace", () => {
  const fixture = setup();
  try {
    const read = join(fixture.repo, "read.json");
    const write = join(fixture.repo, "write.json");
    writeFileSync(read, JSON.stringify({
      schemaVersion: 1,
      steward: "steward",
      objective: "read",
      workspace: { root: fixture.workspace, access: "read" }
    }));
    writeFileSync(write, JSON.stringify({
      schemaVersion: 1,
      steward: "steward",
      workflowRef: "review@1",
      inputs: { plan: "plan.md" },
      workspace: { root: fixture.workspace, access: "write" }
    }));
    command(fixture.repo, fixture.runtimeDirectory, [
      "start", read, "--request-id", "read-1"
    ]);
    command(fixture.repo, fixture.runtimeDirectory, [
      "start", read, "--request-id", "read-2"
    ]);
    command(fixture.repo, fixture.runtimeDirectory, [
      "start", write, "--request-id", "write-1"
    ]);
    assert.throws(() => command(fixture.repo, fixture.runtimeDirectory, [
      "start", write, "--request-id", "write-2"
    ]), /UNIQUE constraint failed/);
  } finally {
    fixture.close();
  }
});

test("Run CLI requires an idempotency key before reading input", () => {
  assert.throws(
    () => runAgentRunCommand(
      "/missing",
      ["start", "/missing/run.json"],
      { write() {} },
      "/missing/runtime"
    ),
    /--request-id/
  );
});

function setup(): {
  readonly repo: string;
  readonly runtimeDirectory: string;
  readonly workspace: string;
  readonly childAgentId: string;
  readonly close: () => void;
} {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-run-cli-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-run-cli-runtime-"));
  const paths = runtimePaths(repo, runtimeDirectory);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths, "2026-07-26T00:00:00.000Z");
  git(paths.workspace, ["init"]);
  git(paths.workspace, ["config", "user.name", "Rollerskate Test"]);
  git(paths.workspace, ["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(paths.workspace, "plan.md"), "# Plan\n");
  git(paths.workspace, ["add", "plan.md"]);
  git(paths.workspace, ["commit", "-m", "initial"]);
  const foundation = new LocalFoundationStore(paths.database);
  foundation.addAgent("steward", "codex", "2026-07-26T00:00:00.000Z");
  const child = foundation.addAgent(
    "child",
    "kimi-code",
    "2026-07-26T00:00:00.000Z"
  );
  foundation.close();
  return {
    repo,
    runtimeDirectory,
    workspace: paths.workspace,
    childAgentId: child.principalId,
    close() {
      rmSync(repo, { recursive: true, force: true });
      rmSync(runtimeDirectory, { recursive: true, force: true });
    }
  };
}

function command(
  repo: string,
  runtimeDirectory: string,
  arguments_: readonly string[]
): unknown {
  let output = "";
  assert.equal(runAgentRunCommand(
    repo,
    arguments_,
    { write(text) { output += text; } },
    runtimeDirectory
  ), 0);
  return JSON.parse(output) as unknown;
}

function git(cwd: string, arguments_: readonly string[]): void {
  const result = spawnSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) throw new Error(result.stderr);
}
