import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectReview } from "../src/application/review/control.js";
import { listReviewViews } from "../src/application/review/query.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("terminal schema-v43 Review history remains inspectable and read-only", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-legacy-review-repo-"));
  const runtimeDirectory = mkdtempSync(
    join(tmpdir(), "rollerskate-legacy-review-runtime-")
  );
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    initializeRuntimeSchema(paths.database);
    bootstrapLocalFoundation(paths, "2026-07-26T00:00:00.000Z");
    const subject = join(paths.workspace, "plan.md");
    writeFileSync(subject, "# Legacy acceptance\n");
    const foundation = new LocalFoundationStore(paths.database);
    const reviewer = foundation.addAgent(
      "reviewer",
      "codex",
      "2026-07-26T00:00:00.000Z"
    );
    const implementer = foundation.addAgent(
      "implementer",
      "kimi-code",
      "2026-07-26T00:00:00.000Z"
    );
    foundation.close();
    const rootEventId = "evt_019f92c9-0000-7000-8000-000000000041";
    const executionId = "exe_019f92c9-0000-7000-8000-000000000041";
    const database = openRuntimeDatabase(paths.database);
    database.prepare(`
      INSERT INTO events (
        event_id, type, source_kind, source_external_id, agent_id, prompt,
        outcome, output, error, payload_json, session_id, destination_ids_json,
        destination_snapshots_json, root_event_id, parent_event_id, causal_hop,
        created_at
      ) VALUES (
        ?, 'review.requested', 'cli', 'legacy-review-1', NULL, NULL,
        NULL, NULL, NULL, ?, NULL, '[]', '[]', ?, NULL, 0, ?
      )
    `).run(rootEventId, JSON.stringify({
      cycleIndex: 0,
      subject: { kind: "acceptance", ref: subject, revision: "file_legacy" },
      artifactRef: `${subject}.review.yaml`,
      evidence: [{
        kind: "workspace",
        ref: paths.workspace,
        revision: "wrk1_legacy"
      }],
      implementationRevision: "wrk1_legacy",
      reviewerAgentId: reviewer.principalId,
      implementerAgentId: implementer.principalId,
      reworkLimit: 1
    }), rootEventId, "2026-07-26T00:01:00.000Z");
    database.prepare(`
      INSERT INTO executions (
        execution_id, event_id, handler, status, attempt_count, max_attempts,
        next_attempt_at, created_at, completed_at, updated_at
      ) VALUES (?, ?, 'review', 'succeeded', 1, 3, ?, ?, ?, ?)
    `).run(
      executionId,
      rootEventId,
      "2026-07-26T00:01:00.000Z",
      "2026-07-26T00:01:00.000Z",
      "2026-07-26T00:02:00.000Z",
      "2026-07-26T00:02:00.000Z"
    );
    database.prepare(`
      INSERT INTO reviews (
        root_event_id, subject_ref, workspace_ref, phase, cycle_index,
        expected_event_id, active_execution_id, subject_revision,
        artifact_revision, implementation_revision, rework_count,
        rework_limit, terminal_decision, terminal_reason, transitions_json,
        updated_at
      ) VALUES (?, ?, ?, 'terminal', 0, ?, NULL, ?, NULL, ?, 0, 1,
        'passed', 'legacy complete', '[]', ?)
    `).run(
      rootEventId,
      subject,
      paths.workspace,
      rootEventId,
      "file_legacy",
      "wrk1_legacy",
      "2026-07-26T00:02:00.000Z"
    );
    database.close();

    const inspection = inspectReview(repo, rootEventId, runtimeDirectory);
    assert.equal(inspection.projection.terminalDecision, "passed");
    assert.equal(inspection.reviewer.principalId, reviewer.principalId);
    const views = listReviewViews(repo, runtimeDirectory);
    assert.equal(views.length, 1);
    assert.equal(views[0]?.availableActions.recover, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});
