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
import { runReviewCommand } from "../src/entrypoints/cli/review.js";

test("Review CLI creates idempotently and provides list, inspect, trace and recover", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-review-cli-repo-"));
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-review-cli-runtime-"));
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    initializeRuntimeSchema(paths.database);
    bootstrapLocalFoundation(paths, "2026-07-24T00:00:00.000Z");
    git(paths.workspace, ["init"]);
    git(paths.workspace, ["config", "user.name", "Rollerskate Test"]);
    git(paths.workspace, ["config", "user.email", "test@example.invalid"]);
    const subject = join(paths.workspace, "plan.md");
    writeFileSync(subject, "# Acceptance\n");
    git(paths.workspace, ["add", "plan.md"]);
    git(paths.workspace, ["commit", "-m", "initial"]);
    const foundation = new LocalFoundationStore(paths.database);
    foundation.addAgent("reviewer", "codex", "2026-07-24T00:00:00.000Z");
    foundation.addAgent("implementer", "claude-code", "2026-07-24T00:00:00.000Z");
    foundation.close();
    const config = join(repo, "review.json");
    writeFileSync(config, JSON.stringify({
      schemaVersion: 1,
      subject,
      reviewer: "reviewer",
      implementer: "implementer",
      reworkLimit: 2
    }));

    const created = command(repo, runtimeDirectory, [
      "create", config, "--request-id", "acceptance-1"
    ]) as {
      status: string;
      rootEventId: string;
      review: { summary: { phase: string }; artifact: unknown | null };
    };
    const duplicate = command(repo, runtimeDirectory, [
      "create", config, "--request-id", " acceptance-1 "
    ]) as { status: string; rootEventId: string };
    assert.equal(created.status, "accepted");
    assert.equal(created.review.summary.phase, "reviewing");
    assert.equal(created.review.artifact, null);
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.rootEventId, created.rootEventId);
    assert.throws(
      () => command(repo, runtimeDirectory, [
        "create", config, "--request-id", "acceptance-2"
      ]),
      /active Review already owns/
    );

    writeFileSync(`${subject}.review.yaml`, "not-json\n");
    const listed = command(repo, runtimeDirectory, ["list"]) as unknown[];
    const inspected = command(repo, runtimeDirectory, [
      "inspect", created.rootEventId
    ]) as {
      summary: { subject: { ref: string } };
      artifactError: string;
      audit: unknown[];
    };
    const traced = command(repo, runtimeDirectory, [
      "trace", created.rootEventId
    ]) as { summary: { rootEventId: string } };
    const recovered = command(repo, runtimeDirectory, [
      "recover", created.rootEventId
    ]) as { summary: { phase: string } };
    assert.equal(listed.length, 1);
    assert.equal(inspected.summary.subject.ref, subject);
    assert.match(inspected.artifactError, /JSON-compatible YAML/);
    assert.equal(inspected.audit.length, 1);
    assert.equal(traced.summary.rootEventId, created.rootEventId);
    assert.equal(recovered.summary.phase, "reviewing");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("Review CLI rejects one Agent occupying both independent roles", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-review-cli-validation-"));
  const config = join(repo, "review.json");
  try {
    writeFileSync(config, JSON.stringify({
      schemaVersion: 1,
      subject: repo,
      reviewer: "same",
      implementer: "same",
      reworkLimit: 1
    }));
    assert.throws(
      () => runReviewCommand(repo, ["create", config], { write() {} }, repo),
      /--request-id/
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function command(
  repo: string,
  runtimeDirectory: string,
  arguments_: readonly string[]
): unknown {
  let output = "";
  assert.equal(runReviewCommand(
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
