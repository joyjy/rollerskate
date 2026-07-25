import assert from "node:assert/strict";
import test from "node:test";

import {
  renderImplementerPrompt,
  renderReviewerPrompt
} from "../src/capabilities/review/prompt-resource.js";
import type { ReviewAgentInvocation } from "../src/core/event/model.js";

const base: ReviewAgentInvocation = {
  schemaVersion: "review-invocation@1",
  role: "reviewer",
  rootEventId: "evt-root",
  cycleIndex: 0,
  subject: {
    kind: "acceptance",
    ref: "/workspace/acceptance.md",
    revision: "subject-revision"
  },
  artifactRef: "/workspace/review.json",
  artifactRevision: "artifact-revision",
  evidence: [{
    kind: "workspace",
    ref: "/workspace",
    revision: "implementation-revision"
  }],
  implementationRevision: "implementation-revision",
  workspaceAccess: "read",
  resultSchema: "ReviewerResult@1"
};

test("Review prompts render from frontmatter-managed resources", () => {
  const reviewer = renderReviewerPrompt(base);
  assert.match(reviewer, /Subject: \/workspace\/acceptance\.md/);
  assert.match(reviewer, /ReviewerResult@1/);
  assert.match(reviewer, /anchor\.ref.*absolute/su);
  assert.match(reviewer, /Workspace evidence: \/workspace/);
  assert.ok(!reviewer.includes("type: Prompt"));
  assert.ok(!reviewer.includes("{{SUBJECT_REF}}"));

  const implementer = renderImplementerPrompt({
    ...base,
    role: "implementer",
    workspaceAccess: "write",
    writableRoot: "/workspace",
    resultSchema: "ImplementerResult@1"
  });
  assert.match(implementer, /Authorized writable root: \/workspace/);
  assert.match(implementer, /ImplementerResult@1/);
  assert.match(implementer, /exact open finding ID/);
  assert.ok(!implementer.includes("resource: prompt.review.implementer"));
  assert.ok(!implementer.includes("{{WRITABLE_ROOT}}"));
});
