import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { inspectScheduleView } from "../src/application/schedule/query.js";
import { inspectSubscriptionView } from "../src/application/subscription/query.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { temporaryDirectory } from "./support/temp-directory.js";

const AT = "2026-08-24T00:00:00.000Z";
const AGENT = "prn_019f92c9-0000-7000-8000-000000000001";
const SESSION = "ses_019f92c9-0000-7000-8000-000000000002";
const SCHEDULE = "sch_019f92c9-0000-7000-8000-000000000003";
const OCCURRENCE = "srun_019f92c9-0000-7000-8000-000000000004";
const SUBSCRIPTION = "sub_019f92c9-0000-7000-8000-000000000005";
const CONTINUOUS = "sub_019f92c9-0000-7000-8000-000000000006";
const observation = { version: "pipeline:42", facts: { pipelineId: 42, status: "success" }, terminal: "success" };

test("old Schedule history and Subscription observations remain readable after upgrade and reopen", () => {
  const root = temporaryDirectory("rollerskate-legacy-readback-");
  const databasePath = join(root, "runtime.db");
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(readFileSync(new URL("../../test/fixtures/legacy-data-v65.sql", import.meta.url), "utf8"));
    insert(legacy, "schema_meta", { key: "schema_version", value: "65" });
    insert(legacy, "local_foundation", { singleton: 1, device_id: "dev_019f92c9-0000-7000-8000-000000000007",
      device_name: "Historical device", workspace_path: root, topic_id: "top_019f92c9-0000-7000-8000-000000000008",
      topic_handle: "local", owner_principal_id: "prn_019f92c9-0000-7000-8000-000000000009", owner_handle: "owner",
      owner_status: "active", owner_created_at: AT, owner_updated_at: AT, created_at: AT });
    insert(legacy, "agents", { principal_id: AGENT, handle: "alice", handle_key: "alice", status: "active",
      agent_client: "codex", execution_config: '{"launchArgs":[]}', created_at: AT, updated_at: AT });
    insert(legacy, "agent_sessions", { session_id: SESSION, agent_id: AGENT, adapter_id: "codex-app-server-v1",
      provider_session_id: "original-provider-session", workspace: root, created_at: AT, updated_at: AT });
    const revision = { scheduleId: SCHEDULE, revision: 1, agentId: AGENT, kind: "cron", expression: "0 * * * *",
      expressionVersion: "cron-v1", timezone: "UTC", misfirePolicy: "run_once", overlapPolicy: "queue",
      misfireGraceMilliseconds: 60_000, sessionPolicy: "fixed", fixedSessionId: SESSION,
      prompt: "Keep this historical instruction", workspace: root, createdAt: AT };
    insert(legacy, "schedules", { schedule_id: SCHEDULE, owner_principal_id: AGENT, status: "paused", current_revision: 1,
      agent_id: AGENT, kind: "cron", expression: revision.expression, expression_version: "cron-v1", timezone: "UTC",
      misfire_policy: "run_once", overlap_policy: "queue", misfire_grace_ms: 60_000, session_policy: "fixed",
      fixed_session_id: SESSION, prompt: revision.prompt, workspace: root, revision_created_at: AT, created_at: AT, updated_at: AT });
    insert(legacy, "scheduled_runs", { run_id: OCCURRENCE, schedule_id: SCHEDULE, occurrence_key: "cron:historical",
      scheduled_for: AT, schedule_revision: 1, definition_snapshot_json: JSON.stringify(revision), status: "succeeded",
      session_id: SESSION, decision_reason: "historical success", created_at: AT, updated_at: AT, completed_at: AT });
    const policy = JSON.stringify({ workspaceRoot: root, allowedHttpOrigins: [], allowedExecutables: [],
      allowedEnvironment: [], timeoutMilliseconds: 1000, maxOutputBytes: 4096 });
    const common = { owner_agent_id: AGENT, plugin_path: join(root, "historical-plugin.ts"), plugin_id: "pipeline",
      policy_json: policy, interval_ms: 1000, next_poll_at: AT, created_at: AT, updated_at: AT };
    insert(legacy, "subscriptions", { ...common, subscription_id: SUBSCRIPTION, title: "Finished pipeline", plugin_schema_version: 1,
      plugin_config_json: JSON.stringify({ config: { pipelineId: 42 }, artifactRevision: "old-source", artifactDigest: `sha256:${"0".repeat(64)}` }),
      max_wait_ms: 60000, max_attempts: 10, attempt_count: 2, definition_schema: "SubscriptionDefinition@3",
      definition_revision: "old-revision", definition_digest: "old-digest", callback_phase_status: "completed",
      terminal_key: `subscription:${SUBSCRIPTION}:terminal`, terminal_observation_json: JSON.stringify(observation),
      status: "completed", started_at: AT, deadline_at: AT });
    insert(legacy, "continuous_subscriptions", { ...common, subscription_id: CONTINUOUS, title: "Paused pipeline watch",
      current_revision: 2, plugin_config_json: '{"pipelineId":42}', poll_count: 7, status: "paused",
      checkpoint_occurrence_key: "pipeline:41", checkpoint_observation_json: JSON.stringify({ ...observation, version: "pipeline:41" }),
      pending_occurrence_key: "pipeline:42", pending_observation_json: JSON.stringify(observation) });
  } finally { legacy.close(); }

  // A second initialization and fresh query connections must not erase or duplicate old records.
  for (let reopen = 0; reopen < 2; reopen++) {
    initializeRuntimeSchema(databasePath);
    const schedule = inspectScheduleView(root, SCHEDULE, root);
    assert.equal(schedule.summary.status, "paused");
    assert.equal(schedule.summary.owner.principalId, AGENT);
    assert.equal(schedule.summary.fixedSessionId, SESSION);
    assert.equal(schedule.revision.prompt, "Keep this historical instruction");
    assert.equal(schedule.revision.workspace, root);
    assert.deepEqual(schedule.runs.map(run => [run.runId, run.scheduleId, run.status, run.sessionId]),
      [[OCCURRENCE, SCHEDULE, "succeeded", SESSION]]);
    const subscription = inspectSubscriptionView(root, SUBSCRIPTION, root);
    assert.equal(subscription.kind, "free");
    if (subscription.kind !== "free") throw new Error("Expected historical one-shot Subscription");
    assert.equal(subscription.title, "Finished pipeline");
    assert.equal(subscription.status, "completed");
    assert.equal(subscription.owner?.agentId, AGENT);
    assert.equal(subscription.schedule.attemptCount, 2);
    assert.deepEqual(subscription.terminalObservation, observation);
    const continuous = inspectSubscriptionView(root, CONTINUOUS, root);
    assert.equal(continuous.kind, "continuous");
    if (continuous.kind !== "continuous") throw new Error("Expected historical continuous Subscription");
    assert.equal(continuous.status, "paused");
    assert.equal(continuous.owner?.agentId, AGENT);
    assert.equal(continuous.pollCount, 7);
    assert.equal(continuous.checkpointOccurrenceKey, "pipeline:41");
    assert.equal(continuous.pendingOccurrenceKey, "pipeline:42");
    assert.deepEqual(continuous.pendingObservation, observation);
  }
});

function insert(database: DatabaseSync, table: string, row: Record<string, string | number>): void {
  const columns = Object.keys(row);
  database.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...Object.values(row));
}
