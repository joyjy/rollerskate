import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  applyImplementerResult,
  applyReviewerResult,
  createReviewArtifact,
  readReviewArtifact,
  reviewArtifactRef,
  writeReviewArtifact,
  type LegacyImplementerResult,
  type LegacyReviewerResult
} from "../src/capabilities/review/artifact-schema.js";
import { workspaceRevision } from "../src/capabilities/review/workspace-revision.js";
import { workspaceRevision as genericWorkspaceRevision } from "../src/infrastructure/workspace/revision.js";

test("mrsf.review@1 applies Reviewer and Implementer mutations under capability ownership", () => {
  const root = mkdtempSync(join(tmpdir(), "rollerskate-review-artifact-"));
  const subject = join(root, "plan.md");
  writeFileSync(subject, "# Plan\n");
  const artifactPath = reviewArtifactRef(subject);
  const initial = createReviewArtifact({
    subjectRef: subject,
    subjectRevision: "sub_1",
    rootReviewId: "evt_root"
  });
  const reviewer = {
    boundedSummary: "One release gate is missing.",
    revisionsRead: {
      subject: "sub_1",
      evidence: [{ revision: "wrk1_a" }]
    },
    artifactMutation: {
      addFindings: [{
        anchor: { ref: subject, line: 1 },
        severity: "high",
        summary: "Add a release gate."
      }],
      resolveFindingIds: []
    }
  } satisfies LegacyReviewerResult;
  const reviewed = applyReviewerResult(initial, reviewer, "prn_reviewer", 0);
  assert.equal(reviewed.findings.length, 1);
  assert.equal(reviewed.findings[0]!.status, "open");
  writeReviewArtifact(artifactPath, reviewed);
  assert.deepEqual(readReviewArtifact(artifactPath), reviewed);

  const implementer = {
    findingReplies: [{
      findingId: reviewed.findings[0]!.findingId,
      summary: "The verification now runs in CI.",
      evidenceRefs: ["ci.yml"]
    }]
  } satisfies LegacyImplementerResult;
  const implemented = applyImplementerResult(reviewed, implementer, "prn_implementer");
  assert.equal(implemented.findings[0]!.status, "open");
  assert.equal(implemented.findings[0]!.implementerReplies.length, 1);
  assert.notEqual(implemented.artifactRevision, reviewed.artifactRevision);
});

test("review artifact refuses symlink indirection", () => {
  const root = mkdtempSync(join(tmpdir(), "rollerskate-review-artifact-link-"));
  const target = join(root, "target.json");
  const link = join(root, "plan.md.review.yaml");
  writeFileSync(target, "{}\n");
  symlinkSync(target, link);
  assert.throws(() => readReviewArtifact(link), /non-symlink/);
});

test("workspace-revision-v1 distinguishes clean, tracked dirty and untracked state", () => {
  const root = mkdtempSync(join(tmpdir(), "rollerskate-workspace-revision-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "Rollerskate Test"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(root, "tracked.txt"), "one\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "initial"]);

  const clean = workspaceRevision(root);
  assert.equal(clean.clean, true);
  assert.match(clean.revision, /^wrk1_[0-9a-f]{64}$/);
  writeFileSync(join(root, "plan.md.review.yaml"), "{}\n");
  writeFileSync(join(root, "plan.md.review.yaml.tmp-crash"), "{}\n");
  assert.equal(workspaceRevision(root).revision, clean.revision);
  assert.notEqual(genericWorkspaceRevision(root).revision, clean.revision);

  writeFileSync(join(root, "tracked.txt"), "two\n");
  const tracked = workspaceRevision(root);
  assert.equal(tracked.clean, false);
  assert.notEqual(tracked.revision, clean.revision);
  assert.match(tracked.trackedDiffHash ?? "", /^[0-9a-f]{64}$/);

  writeFileSync(join(root, "new.txt"), "evidence\n");
  const untracked = workspaceRevision(root);
  assert.equal(untracked.untrackedManifest?.[0]?.path, "new.txt");
  assert.notEqual(untracked.revision, tracked.revision);
  assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "evidence\n");
});

function git(cwd: string, arguments_: readonly string[]): void {
  const result = spawnSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) throw new Error(result.stderr);
}
