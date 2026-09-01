import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { runStewardCommand } from "../src/entrypoints/cli/run.js";

test("Run CLI starts idempotently, lists, inspects, traces and cancels", () => {
  const fixture = setup();
  try {
    const config = join(fixture.repo, "run.json");
    writeFileSync(config, JSON.stringify({
      schemaVersion: "RunIntent@1",
      requestId: "run-cli-1",
      objective: "Review the current implementation.",
      acceptance: ["Report exact evidence"],
      contextRefs: [],
      workspaceRef: pathToFileURL(fixture.workspace).href,
      desiredEffect: "read",
      requestedParticipantRefs: ["agent:child"],
      terminalEvidence: ["review receipt"]
    }));
    const created = command(fixture.repo, fixture.runtimeDirectory, [
      "start", config
    ]) as {
      status: string;
      run: { runId: string; status: string };
      rootEventId: string;
    };
    const duplicate = command(fixture.repo, fixture.runtimeDirectory, [
      "start", config
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
    assert.match(inspected.timeline[0]?.event.prompt ?? "", /participants=2/);
    assert.doesNotMatch(inspected.timeline[0]?.event.prompt ?? "", /workspace.*root/i);
    assert.deepEqual(inspected.exchanges, []);
    assert.equal(traced.summary.runId, created.run.runId);
    assert.throws(() => command(fixture.repo, fixture.runtimeDirectory, [
      "archive", created.run.runId
    ]), /Only terminal Agent Runs can be archived/);

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

    const archived = command(fixture.repo, fixture.runtimeDirectory, [
      "archive", created.run.runId
    ]) as { status: string; run: { archivedAt?: string } };
    assert.equal(archived.status, "archived");
    assert.equal(typeof archived.run.archivedAt, "string");
    assert.deepEqual(command(fixture.repo, fixture.runtimeDirectory, ["list"]), []);
    assert.equal((command(fixture.repo, fixture.runtimeDirectory, [
      "list", "--archived"
    ]) as Array<{ runId: string }>)[0]?.runId, created.run.runId);
    assert.equal((command(fixture.repo, fixture.runtimeDirectory, [
      "unarchive", created.run.runId
    ]) as { status: string }).status, "unarchived");
    assert.equal((command(fixture.repo, fixture.runtimeDirectory, [
      "list"
    ]) as Array<{ runId: string }>)[0]?.runId, created.run.runId);
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
      schemaVersion: "RunIntent@1",
      requestId: "read-1",
      objective: "read",
      acceptance: ["read complete"],
      contextRefs: [],
      workspaceRef: pathToFileURL(fixture.workspace).href,
      desiredEffect: "read",
      terminalEvidence: ["read receipt"]
    }));
    writeFileSync(write, JSON.stringify({
      schemaVersion: "RunIntent@1",
      requestId: "write-1",
      objective: "write",
      acceptance: ["workspace changed"],
      contextRefs: [],
      workspaceRef: pathToFileURL(fixture.workspace).href,
      desiredEffect: "change",
      terminalEvidence: ["changed revision"]
    }));
    command(fixture.repo, fixture.runtimeDirectory, [
      "start", read
    ]);
    writeFileSync(read, JSON.stringify({
      schemaVersion: "RunIntent@1",
      requestId: "read-2",
      objective: "read",
      acceptance: ["read complete"],
      contextRefs: [],
      workspaceRef: pathToFileURL(fixture.workspace).href,
      desiredEffect: "read",
      terminalEvidence: ["read receipt"]
    }));
    command(fixture.repo, fixture.runtimeDirectory, [
      "start", read
    ]);
    command(fixture.repo, fixture.runtimeDirectory, [
      "start", write
    ]);
    writeFileSync(write, JSON.stringify({
      schemaVersion: "RunIntent@1",
      requestId: "write-2",
      objective: "write",
      acceptance: ["workspace changed"],
      contextRefs: [],
      workspaceRef: pathToFileURL(fixture.workspace).href,
      desiredEffect: "change",
      terminalEvidence: ["changed revision"]
    }));
    assert.throws(() => command(fixture.repo, fixture.runtimeDirectory, [
      "start", write
    ]), /UNIQUE constraint failed/);
  } finally {
    fixture.close();
  }
});

test("Run CLI rejects the legacy raw workspace grant contract", () => {
  const fixture = setup();
  try {
    const config = join(fixture.repo, "missing-effect.json");
    writeFileSync(config, JSON.stringify({
      schemaVersion: "RunIntent@1",
      requestId: "legacy-grant",
      objective: "write",
      acceptance: ["changed"],
      contextRefs: [],
      terminalEvidence: ["revision"],
      workspace: { root: fixture.workspace, access: "write" }
    }));
    assert.throws(() => command(fixture.repo, fixture.runtimeDirectory, [
      "start", config
    ]), /unknown field: workspace/);
  } finally {
    fixture.close();
  }
});

test("Run CLI requires exactly one RunIntent file before reading input", () => {
  assert.throws(
    () => runStewardCommand(
      "/missing",
      ["start"],
      { write() {} },
      "/missing/runtime"
    ),
    /requires one RunIntent@1 JSON file/
  );
});

function setup(): {
  readonly repo: string;
  readonly runtimeDirectory: string;
  readonly workspace: string;
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
  foundation.addAgent("codex", "codex", "2026-07-26T00:00:00.000Z");
  foundation.addAgent(
    "child",
    "kimi-code",
    "2026-07-26T00:00:00.000Z"
  );
  foundation.close();
  return {
    repo,
    runtimeDirectory,
    workspace: paths.workspace,
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
  assert.equal(runStewardCommand(
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
