import type { DatabaseSync } from "node:sqlite";

import { openInitializedRuntimeDatabase } from "./database.js";
import { migrateLocalDatabase } from "./schema/index.js";
import { normalizeLegacyVikunjaRunResultDestination } from
  "../../integrations/vikunja/task-destination.js";
import {
  isTerminal,
  requireAgentRunId,
  requireAgentRunCycleId,
  type AgentRunCycleProjection,
  type AgentRunCycleStatus,
  type AgentRunProjection,
  type AgentRunStatus,
  type RunMandateSnapshot
} from "../../modules/steward/state-machine.js";
import type { ExternalWorkspaceGrant } from "../../core/runtime/model.js";
import {
  parseAgentRunCheckpoint,
  parseAgentRunDecisionReceipt,
  parseCallerOrchestratorBinding,
  parseRunDecision,
  type AgentRunCheckpoint,
  type AgentRunDecisionReceipt,
  type AnyRunDecision,
  type CallerOrchestratorBinding
} from "../../modules/steward/caller-contract.js";

interface AgentRunRow {
  run_id: string;
  root_event_id: string;
  owner_request_id: string;
  owner_principal_id: string;
  steward_agent_id: string;
  series_key: string | null;
  active_cycle_id: string | null;
  mandate_snapshot_json: string;
  workspace_grant_json: string | null;
  orchestration_mode: "autonomous" | "caller";
  orchestrator_binding_json: string | null;
  status: AgentRunStatus;
  active_step_id: string | null;
  active_execution_id: string | null;
  step_count: number;
  max_steps: number;
  max_depth: number;
  deadline_at: string | null;
  checkpoint_json: string | null;
  terminal_summary: string | null;
  cancelled_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface AgentRunCycleRow {
  cycle_id: string;
  run_id: string;
  request_id: string;
  source_revision: string;
  mandate_snapshot_json: string;
  workspace_grant_json: string | null;
  status: AgentRunCycleStatus;
  step_count: number;
  terminal_summary: string | null;
  created_at: string;
  completed_at: string | null;
  updated_at: string;
}

interface AgentRunDecisionRow {
  run_id: string;
  request_id: string;
  expected_run_version: number;
  resulting_run_version: number;
  decision_json: string;
  receipt_json: string;
  accepted_at: string;
}

export interface CreateAgentRunRecord {
  readonly runId: string;
  readonly rootEventId: string;
  readonly rootExecutionId: string;
  readonly ownerRequestId: string;
  readonly ownerPrincipalId: string;
  readonly stewardAgentId: string;
  readonly seriesKey?: string;
  readonly activeCycleId?: string;
  readonly mandate: RunMandateSnapshot;
  readonly workspaceGrant?: ExternalWorkspaceGrant;
  readonly orchestratorBinding?: CallerOrchestratorBinding;
  readonly rootStepId: string;
  readonly initialStepCount?: number;
  readonly maxSteps: number;
  readonly maxDepth: number;
  readonly deadlineAt?: string;
  readonly createdAt: string;
}

export interface ActiveAgentRunTarget {
  readonly agentId: string;
  readonly handle: string;
  readonly client: string;
}

export interface AgentRunDecisionRecord {
  readonly decision: AnyRunDecision;
  readonly receipt: AgentRunDecisionReceipt;
}

export class AgentRunStore {
  readonly #database: DatabaseSync;
  readonly #ownsDatabase: boolean;

  public constructor(database: string | DatabaseSync) {
    if (typeof database === "string") {
      this.#database = openInitializedRuntimeDatabase(database, migrateLocalDatabase);
      this.#ownsDatabase = true;
    } else {
      this.#database = database;
      this.#ownsDatabase = false;
      migrateLocalDatabase(this.#database);
    }
  }

  public close(): void {
    if (this.#ownsDatabase) this.#database.close();
  }

  public createInTransaction(input: CreateAgentRunRecord): AgentRunProjection {
    requireAgentRunId(input.runId);
    const existing = this.projectionByOwnerRequest(input.ownerRequestId);
    if (existing !== undefined) return existing;
    this.#database.prepare(`
      INSERT INTO agent_runs (
        run_id, root_event_id, owner_request_id, owner_principal_id,
        steward_agent_id, series_key, active_cycle_id,
        mandate_snapshot_json, workspace_grant_json,
        orchestration_mode, orchestrator_binding_json,
        status, active_step_id, active_execution_id, step_count,
        max_steps, max_depth, deadline_at, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      input.runId,
      input.rootEventId,
      text(input.ownerRequestId, "ownerRequestId", 256),
      text(input.ownerPrincipalId, "ownerPrincipalId", 256),
      text(input.stewardAgentId, "stewardAgentId", 256),
      input.seriesKey === undefined ? null : text(input.seriesKey, "seriesKey", 512),
      input.activeCycleId === undefined
        ? null
        : requireAgentRunCycleId(input.activeCycleId),
      boundedJson(input.mandate, "mandate", 65_536),
      input.workspaceGrant === undefined
        ? null
        : boundedJson(input.workspaceGrant, "workspaceGrant", 16_384),
      input.orchestratorBinding === undefined ? "autonomous" : "caller",
      input.orchestratorBinding === undefined
        ? null
        : boundedJson(input.orchestratorBinding, "orchestratorBinding", 16_384),
      text(input.rootStepId, "rootStepId", 256),
      input.rootExecutionId,
      bounded(input.initialStepCount ?? 1, 0, 1_000, "initialStepCount"),
      bounded(input.maxSteps, 1, 1_000, "maxSteps"),
      bounded(input.maxDepth, 0, 100, "maxDepth"),
      input.deadlineAt === undefined ? null : iso(input.deadlineAt),
      iso(input.createdAt),
      iso(input.createdAt)
    );
    return this.requireProjection(input.runId);
  }

  public projection(runId: string): AgentRunProjection | undefined {
    requireAgentRunId(runId);
    const row = this.#database.prepare(`
      SELECT * FROM agent_runs WHERE run_id = ?
    `).get(runId) as AgentRunRow | undefined;
    return row === undefined ? undefined : mapProjection(row);
  }

  public projectionByOwnerRequest(
    ownerRequestId: string
  ): AgentRunProjection | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM agent_runs WHERE owner_request_id = ?
    `).get(text(ownerRequestId, "ownerRequestId", 256)) as AgentRunRow | undefined;
    return row === undefined ? undefined : mapProjection(row);
  }

  public projectionBySeriesKey(seriesKey: string): AgentRunProjection | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM agent_runs WHERE series_key = ?
    `).get(text(seriesKey, "seriesKey", 512)) as AgentRunRow | undefined;
    return row === undefined ? undefined : mapProjection(row);
  }

  public cycle(cycleId: string): AgentRunCycleProjection | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM agent_run_cycles WHERE cycle_id = ?
    `).get(requireAgentRunCycleId(cycleId)) as AgentRunCycleRow | undefined;
    return row === undefined ? undefined : mapCycle(row);
  }

  public cycleByRequest(requestId: string): AgentRunCycleProjection | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM agent_run_cycles WHERE request_id = ?
    `).get(text(requestId, "requestId", 256)) as AgentRunCycleRow | undefined;
    return row === undefined ? undefined : mapCycle(row);
  }

  public cycleByRevision(
    runId: string,
    sourceRevision: string
  ): AgentRunCycleProjection | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM agent_run_cycles
      WHERE run_id = ? AND source_revision = ?
    `).get(
      requireAgentRunId(runId),
      text(sourceRevision, "sourceRevision", 512)
    ) as AgentRunCycleRow | undefined;
    return row === undefined ? undefined : mapCycle(row);
  }

  public cycles(runId: string, limit = 100): readonly AgentRunCycleProjection[] {
    return (this.#database.prepare(`
      SELECT * FROM agent_run_cycles
      WHERE run_id = ?
      ORDER BY created_at DESC, cycle_id DESC
      LIMIT ?
    `).all(
      requireAgentRunId(runId),
      bounded(limit, 1, 1_000, "limit")
    ) as unknown as AgentRunCycleRow[]).map(mapCycle);
  }

  public createCycleInTransaction(input: {
    readonly cycleId: string;
    readonly runId: string;
    readonly requestId: string;
    readonly sourceRevision: string;
    readonly mandate: RunMandateSnapshot;
    readonly workspaceGrant?: ExternalWorkspaceGrant;
    readonly initialStepCount: number;
    readonly createdAt: string;
  }): AgentRunCycleProjection {
    const existing = this.cycleByRequest(input.requestId);
    if (existing !== undefined) return existing;
    this.#database.prepare(`
      INSERT INTO agent_run_cycles (
        cycle_id, run_id, request_id, source_revision,
        mandate_snapshot_json, workspace_grant_json, status, step_count,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      requireAgentRunCycleId(input.cycleId),
      requireAgentRunId(input.runId),
      text(input.requestId, "requestId", 256),
      text(input.sourceRevision, "sourceRevision", 512),
      boundedJson(input.mandate, "cycleMandate", 65_536),
      input.workspaceGrant === undefined
        ? null
        : boundedJson(input.workspaceGrant, "cycleWorkspaceGrant", 16_384),
      bounded(input.initialStepCount, 0, 1_000, "initialStepCount"),
      iso(input.createdAt),
      iso(input.createdAt)
    );
    return this.cycle(input.cycleId)!;
  }

  public projectionByRoot(rootEventId: string): AgentRunProjection | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM agent_runs WHERE root_event_id = ?
    `).get(text(rootEventId, "rootEventId", 256)) as AgentRunRow | undefined;
    return row === undefined ? undefined : mapProjection(row);
  }

  public requireProjection(runId: string): AgentRunProjection {
    const projection = this.projection(runId);
    if (projection === undefined) throw new Error(`Agent Run not found: ${runId}`);
    return projection;
  }

  public list(limit = 100): AgentRunProjection[] {
    return (this.#database.prepare(`
      SELECT * FROM agent_runs
      ORDER BY updated_at DESC, run_id DESC
      LIMIT ?
    `).all(bounded(limit, 1, 1_000, "limit")) as unknown as AgentRunRow[])
      .map(mapProjection);
  }

  public decision(
    runId: string,
    requestId: string
  ): AgentRunDecisionRecord | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM agent_run_decisions
      WHERE run_id = ? AND request_id = ?
    `).get(
      requireAgentRunId(runId),
      text(requestId, "requestId", 256)
    ) as AgentRunDecisionRow | undefined;
    return row === undefined ? undefined : mapDecision(row);
  }

  public decisions(runId: string, limit = 100): readonly AgentRunDecisionRecord[] {
    return (this.#database.prepare(`
      SELECT * FROM agent_run_decisions
      WHERE run_id = ?
      ORDER BY resulting_run_version DESC
      LIMIT ?
    `).all(
      requireAgentRunId(runId),
      bounded(limit, 1, 1_000, "limit")
    ) as unknown as AgentRunDecisionRow[]).map(mapDecision);
  }

  public recordDecisionInTransaction(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly decision: AnyRunDecision;
    readonly receipt: AgentRunDecisionReceipt;
  }): void {
    this.#database.prepare(`
      INSERT INTO agent_run_decisions (
        run_id, request_id, expected_run_version, resulting_run_version,
        decision_json, receipt_json, accepted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      requireAgentRunId(input.runId),
      text(input.requestId, "requestId", 256),
      input.decision.expectedRunVersion,
      input.receipt.resultingRunVersion,
      boundedJson(input.decision, "decision", 65_536),
      boundedJson(input.receipt, "decisionReceipt", 65_536),
      iso(input.receipt.acceptedAt)
    );
  }

  public eventIds(runId: string): string[] {
    const rootEventId = this.requireProjection(runId).rootEventId;
    return (this.#database.prepare(`
      SELECT event_id FROM events WHERE root_event_id = ?
      ORDER BY causal_hop, created_at, event_id
    `).all(rootEventId) as unknown as Array<{ event_id: string }>)
      .map((row) => row.event_id);
  }

  public isContinuable(runId: string): boolean {
    const run = this.projection(runId);
    return run !== undefined && !isTerminal(run.status);
  }

  public requireActiveAgent(agentId: string): void {
    const row = this.#database.prepare(`
      SELECT status FROM agents WHERE principal_id = ?
    `).get(text(agentId, "agentId", 256)) as { status: string } | undefined;
    if (row === undefined) throw new Error(`Local Agent not found: ${agentId}`);
    if (row.status !== "active") throw new Error(`Local Agent is not active: ${agentId}`);
  }

  public activeDelegateTargets(
    currentAgentId: string,
    participantAgentIds?: readonly string[]
  ): readonly ActiveAgentRunTarget[] {
    const targets = (this.#database.prepare(`
      SELECT principal_id, handle, agent_client AS client
      FROM agents
      WHERE status = 'active' AND principal_id <> ?
      ORDER BY handle_key, principal_id
    `).all(text(currentAgentId, "currentAgentId", 256)) as unknown as Array<{
      principal_id: string;
      handle: string;
      client: string;
    }>).map((row) => ({
      agentId: row.principal_id,
      handle: row.handle,
      client: row.client
    }));
    return participantAgentIds === undefined
      ? targets
      : targets.filter((target) => participantAgentIds.includes(target.agentId));
  }

  public activeParticipantTargets(
    participantAgentIds: readonly string[]
  ): readonly ActiveAgentRunTarget[] {
    if (participantAgentIds.length === 0 || participantAgentIds.length > 64) {
      throw new Error("participantAgentIds must contain 1-64 Agent ids");
    }
    const rows = this.#database.prepare(`
      SELECT principal_id, handle, agent_client AS client
      FROM agents
      WHERE status = 'active'
      ORDER BY handle_key, principal_id
    `).all() as unknown as Array<{
      principal_id: string;
      handle: string;
      client: string;
    }>;
    return rows.filter((row) => participantAgentIds.includes(row.principal_id)).map((row) => ({
      agentId: row.principal_id,
      handle: row.handle,
      client: row.client
    }));
  }

  public advanceInTransaction(input: {
    readonly runId: string;
    readonly expectedVersion: number;
    readonly status: "active" | "waiting";
    readonly activeStepId: string;
    readonly activeExecutionId: string;
    readonly stepCount: number;
    readonly updatedAt: string;
  }): AgentRunProjection {
    const changed = this.#database.prepare(`
      UPDATE agent_runs
      SET status = ?, active_step_id = ?, active_execution_id = ?,
        checkpoint_json = NULL, step_count = ?, version = version + 1, updated_at = ?
      WHERE run_id = ? AND version = ?
        AND orchestration_mode = 'autonomous'
        AND status IN ('active', 'waiting')
    `).run(
      input.status,
      input.activeStepId,
      input.activeExecutionId,
      input.stepCount,
      iso(input.updatedAt),
      requireAgentRunId(input.runId),
      input.expectedVersion
    );
    if (changed.changes !== 1) throw new Error(`Agent Run CAS failed: ${input.runId}`);
    return this.requireProjection(input.runId);
  }

  public activateCycleInTransaction(input: {
    readonly runId: string;
    readonly expectedVersion: number;
    readonly cycleId: string;
    readonly mandate: RunMandateSnapshot;
    readonly workspaceGrant?: ExternalWorkspaceGrant;
    readonly rootStepId: string;
    readonly rootExecutionId: string;
    readonly initialStepCount: number;
    readonly maxSteps: number;
    readonly maxDepth: number;
    readonly deadlineAt?: string;
    readonly updatedAt: string;
  }): AgentRunProjection {
    const changed = this.#database.prepare(`
      UPDATE agent_runs
      SET active_cycle_id = ?, mandate_snapshot_json = ?, workspace_grant_json = ?,
        status = 'active', active_step_id = ?, active_execution_id = ?,
        step_count = ?, max_steps = ?, max_depth = ?, deadline_at = ?,
        checkpoint_json = NULL, terminal_summary = NULL, cancelled_at = NULL,
        version = version + 1, updated_at = ?
      WHERE run_id = ? AND version = ? AND series_key IS NOT NULL
        AND status = 'awaiting_source' AND active_cycle_id IS NULL
    `).run(
      requireAgentRunCycleId(input.cycleId),
      boundedJson(input.mandate, "mandate", 65_536),
      input.workspaceGrant === undefined
        ? null
        : boundedJson(input.workspaceGrant, "workspaceGrant", 16_384),
      text(input.rootStepId, "rootStepId", 256),
      input.rootExecutionId,
      bounded(input.initialStepCount, 0, 1_000, "initialStepCount"),
      bounded(input.maxSteps, 1, 1_000, "maxSteps"),
      bounded(input.maxDepth, 0, 100, "maxDepth"),
      input.deadlineAt === undefined ? null : iso(input.deadlineAt),
      iso(input.updatedAt),
      requireAgentRunId(input.runId),
      input.expectedVersion
    );
    if (changed.changes !== 1) {
      throw new Error(`Agent Run cycle admission CAS failed: ${input.runId}`);
    }
    this.#database.prepare(`
      UPDATE agent_run_cycles
      SET status = 'active', terminal_summary = NULL, completed_at = NULL,
        updated_at = ?
      WHERE cycle_id = ? AND run_id = ?
    `).run(
      iso(input.updatedAt),
      requireAgentRunCycleId(input.cycleId),
      requireAgentRunId(input.runId)
    );
    return this.requireProjection(input.runId);
  }

  public checkpointInTransaction(input: {
    readonly runId: string;
    readonly expectedVersion: number;
    readonly expectedStepId: string;
    readonly expectedExecutionId: string;
    readonly checkpoint: AgentRunCheckpoint;
    readonly updatedAt: string;
  }): AgentRunProjection {
    const changed = this.#database.prepare(`
      UPDATE agent_runs
      SET status = 'awaiting_orchestrator', active_execution_id = NULL,
        checkpoint_json = ?, version = version + 1, updated_at = ?
      WHERE run_id = ? AND version = ?
        AND orchestration_mode = 'caller' AND status = 'active'
        AND active_step_id = ? AND active_execution_id = ?
    `).run(
      boundedJson(input.checkpoint, "checkpoint", 65_536),
      iso(input.updatedAt),
      requireAgentRunId(input.runId),
      input.expectedVersion,
      text(input.expectedStepId, "expectedStepId", 256),
      input.expectedExecutionId
    );
    if (changed.changes !== 1) {
      throw new Error(`Agent Run checkpoint CAS failed: ${input.runId}`);
    }
    return this.requireProjection(input.runId);
  }

  public advanceCallerInTransaction(input: {
    readonly runId: string;
    readonly expectedVersion: number;
    readonly activeStepId: string;
    readonly activeExecutionId: string;
    readonly stepCount: number;
    readonly updatedAt: string;
  }): AgentRunProjection {
    const changed = this.#database.prepare(`
      UPDATE agent_runs
      SET status = 'active', active_step_id = ?, active_execution_id = ?,
        checkpoint_json = NULL, step_count = ?, version = version + 1, updated_at = ?
      WHERE run_id = ? AND version = ?
        AND orchestration_mode = 'caller' AND status = 'awaiting_orchestrator'
    `).run(
      input.activeStepId,
      input.activeExecutionId,
      input.stepCount,
      iso(input.updatedAt),
      requireAgentRunId(input.runId),
      input.expectedVersion
    );
    if (changed.changes !== 1) {
      throw new Error(`Agent Run decision CAS failed: ${input.runId}`);
    }
    return this.requireProjection(input.runId);
  }

  public advanceInitialStewardInTransaction(input: {
    readonly runId: string;
    readonly expectedVersion: number;
    readonly expectedStepId: string;
    readonly activeStepId: string;
    readonly activeExecutionId: string;
    readonly stepCount: number;
    readonly updatedAt: string;
  }): AgentRunProjection {
    const changed = this.#database.prepare(`
      UPDATE agent_runs
      SET status = 'active', active_step_id = ?, active_execution_id = ?,
        checkpoint_json = NULL, step_count = ?, version = version + 1, updated_at = ?
      WHERE run_id = ? AND version = ?
        AND orchestration_mode = 'caller'
        AND status IN ('active', 'awaiting_orchestrator')
        AND active_step_id = ? AND checkpoint_json IS NULL AND step_count = 0
    `).run(
      input.activeStepId,
      input.activeExecutionId,
      input.stepCount,
      iso(input.updatedAt),
      requireAgentRunId(input.runId),
      input.expectedVersion,
      text(input.expectedStepId, "expectedStepId", 256)
    );
    if (changed.changes !== 1) {
      throw new Error(`Initial Steward decision CAS failed: ${input.runId}`);
    }
    return this.requireProjection(input.runId);
  }

  public awaitInitialStewardDecisionInTransaction(input: {
    readonly runId: string;
    readonly expectedVersion: number;
    readonly expectedStepId: string;
    readonly expectedExecutionId: string;
    readonly updatedAt: string;
  }): AgentRunProjection {
    const changed = this.#database.prepare(`
      UPDATE agent_runs
      SET status = 'awaiting_orchestrator', active_execution_id = NULL,
        version = version + 1, updated_at = ?
      WHERE run_id = ? AND version = ?
        AND orchestration_mode = 'caller' AND status = 'active'
        AND active_step_id = ? AND active_execution_id = ?
        AND checkpoint_json IS NULL AND step_count = 0
    `).run(
      iso(input.updatedAt),
      requireAgentRunId(input.runId),
      input.expectedVersion,
      text(input.expectedStepId, "expectedStepId", 256),
      input.expectedExecutionId
    );
    if (changed.changes !== 1) {
      throw new Error(`Initial Steward fallback CAS failed: ${input.runId}`);
    }
    return this.requireProjection(input.runId);
  }

  public terminalizeInTransaction(input: {
    readonly runId: string;
    readonly expectedVersion: number;
    readonly status: "succeeded" | "failed" | "needs_human";
    readonly summary: string;
    readonly updatedAt: string;
  }): AgentRunProjection {
    const current = this.requireProjection(input.runId);
    if (current.version !== input.expectedVersion) {
      throw new Error(`Agent Run CAS failed: ${input.runId}`);
    }
    if (current.seriesKey !== undefined && current.activeCycleId !== undefined) {
      const timestamp = iso(input.updatedAt);
      const completed = this.#database.prepare(`
        UPDATE agent_run_cycles
        SET status = ?, step_count = ?, terminal_summary = ?,
          completed_at = ?, updated_at = ?
        WHERE cycle_id = ? AND run_id = ? AND status = 'active'
      `).run(
        input.status,
        current.stepCount,
        text(input.summary, "summary", 4_096),
        timestamp,
        timestamp,
        current.activeCycleId,
        current.runId
      );
      if (completed.changes !== 1) {
        throw new Error(`Agent Run cycle completion CAS failed: ${current.activeCycleId}`);
      }
      const waiting = this.#database.prepare(`
        UPDATE agent_runs
        SET status = 'awaiting_source', active_cycle_id = NULL,
          active_step_id = NULL, active_execution_id = NULL,
          checkpoint_json = NULL, terminal_summary = NULL,
          version = version + 1, updated_at = ?
        WHERE run_id = ? AND version = ?
          AND status IN ('active', 'waiting', 'awaiting_orchestrator')
      `).run(timestamp, current.runId, current.version);
      if (waiting.changes !== 1) {
        throw new Error(`Agent Run CAS failed: ${input.runId}`);
      }
      return this.requireProjection(input.runId);
    }
    const changed = this.#database.prepare(`
      UPDATE agent_runs
      SET status = ?, active_step_id = NULL, active_execution_id = NULL,
        checkpoint_json = NULL, terminal_summary = ?,
        version = version + 1, updated_at = ?
      WHERE run_id = ? AND version = ?
        AND status IN ('active', 'waiting', 'awaiting_orchestrator')
    `).run(
      input.status,
      text(input.summary, "summary", 4_096),
      iso(input.updatedAt),
      requireAgentRunId(input.runId),
      input.expectedVersion
    );
    if (changed.changes !== 1) throw new Error(`Agent Run CAS failed: ${input.runId}`);
    return this.requireProjection(input.runId);
  }

  public cancelInTransaction(
    runId: string,
    at: string
  ): { readonly run: AgentRunProjection; readonly changed: boolean } {
    const current = this.requireProjection(runId);
    if (isTerminal(current.status)) return { run: current, changed: false };
    const timestamp = iso(at);
    if (current.activeCycleId !== undefined) {
      this.#database.prepare(`
        UPDATE agent_run_cycles
        SET status = 'cancelled', step_count = ?,
          terminal_summary = 'Cancelled by Owner', completed_at = ?, updated_at = ?
        WHERE cycle_id = ? AND run_id = ? AND status = 'active'
      `).run(
        current.stepCount,
        timestamp,
        timestamp,
        current.activeCycleId,
        current.runId
      );
    }
    const changed = this.#database.prepare(`
      UPDATE agent_runs
      SET status = 'cancelled', active_step_id = NULL,
        active_execution_id = NULL,
        checkpoint_json = NULL, terminal_summary = 'Cancelled by Owner', cancelled_at = ?,
        version = version + 1, updated_at = ?
      WHERE run_id = ? AND version = ?
        AND status IN ('active', 'waiting', 'awaiting_orchestrator', 'awaiting_source')
    `).run(timestamp, timestamp, runId, current.version);
    if (changed.changes !== 1) throw new Error(`Agent Run cancel CAS failed: ${runId}`);
    return { run: this.requireProjection(runId), changed: true };
  }

  public closeSeriesInTransaction(
    runId: string,
    summary: string,
    at: string
  ): { readonly run: AgentRunProjection; readonly changed: boolean } {
    const current = this.requireProjection(runId);
    if (isTerminal(current.status)) return { run: current, changed: false };
    if (current.seriesKey === undefined || current.status !== "awaiting_source" ||
      current.activeCycleId !== undefined) {
      throw new Error(`Agent Run series is not ready to close: ${runId}`);
    }
    const changed = this.#database.prepare(`
      UPDATE agent_runs
      SET status = 'succeeded', terminal_summary = ?,
        version = version + 1, updated_at = ?
      WHERE run_id = ? AND version = ? AND status = 'awaiting_source'
        AND series_key IS NOT NULL AND active_cycle_id IS NULL
    `).run(
      text(summary, "summary", 4_096),
      iso(at),
      current.runId,
      current.version
    );
    if (changed.changes !== 1) {
      throw new Error(`Agent Run series close CAS failed: ${runId}`);
    }
    return { run: this.requireProjection(runId), changed: true };
  }
}

function mapProjection(row: AgentRunRow): AgentRunProjection {
  return {
    runId: row.run_id,
    rootEventId: row.root_event_id,
    ownerRequestId: row.owner_request_id,
    ownerPrincipalId: row.owner_principal_id,
    stewardAgentId: row.steward_agent_id,
    ...(row.series_key === null ? {} : { seriesKey: row.series_key }),
    ...(row.active_cycle_id === null ? {} : { activeCycleId: row.active_cycle_id }),
    mandate: parseMandate(row.mandate_snapshot_json),
    ...(row.workspace_grant_json === null
      ? {}
      : {
          workspaceGrant: parseWorkspaceGrant(row.workspace_grant_json)
        }),
    orchestrationMode: row.orchestration_mode,
    ...(row.orchestrator_binding_json === null
      ? {}
      : {
          orchestratorBinding: parseCallerOrchestratorBinding(
            normalizeLegacyVikunjaRunResultDestination(row.orchestrator_binding_json)
          )
        }),
    status: row.status,
    ...(row.active_step_id === null ? {} : { activeStepId: row.active_step_id }),
    ...(row.active_execution_id === null
      ? {}
      : { activeExecutionId: row.active_execution_id }),
    stepCount: row.step_count,
    maxSteps: row.max_steps,
    maxDepth: row.max_depth,
    ...(row.deadline_at === null ? {} : { deadlineAt: row.deadline_at }),
    ...(row.checkpoint_json === null
      ? {}
      : { checkpoint: parseAgentRunCheckpoint(row.checkpoint_json) }),
    ...(row.terminal_summary === null
      ? {}
      : { terminalSummary: row.terminal_summary }),
    ...(row.cancelled_at === null ? {} : { cancelledAt: row.cancelled_at }),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapCycle(row: AgentRunCycleRow): AgentRunCycleProjection {
  return {
    cycleId: row.cycle_id,
    runId: row.run_id,
    requestId: row.request_id,
    sourceRevision: row.source_revision,
    mandate: parseMandate(row.mandate_snapshot_json),
    ...(row.workspace_grant_json === null
      ? {}
      : { workspaceGrant: parseWorkspaceGrant(row.workspace_grant_json) }),
    status: row.status,
    stepCount: row.step_count,
    ...(row.terminal_summary === null
      ? {}
      : { terminalSummary: row.terminal_summary }),
    createdAt: row.created_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    updatedAt: row.updated_at
  };
}

function mapDecision(row: AgentRunDecisionRow): AgentRunDecisionRecord {
  const decision = parseRunDecision(parseJson(row.decision_json, "decision"));
  const receipt = parseAgentRunDecisionReceipt(row.receipt_json);
  if (decision.expectedRunVersion !== row.expected_run_version ||
    receipt.runId !== row.run_id || receipt.requestId !== row.request_id ||
    receipt.expectedRunVersion !== row.expected_run_version ||
    receipt.resultingRunVersion !== row.resulting_run_version ||
    receipt.acceptedAt !== row.accepted_at) {
    throw new Error("Agent Run decision row is inconsistent");
  }
  return { decision, receipt };
}

function parseJson(value: string, field: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Agent Run ${field} is malformed`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Agent Run ${field} is malformed`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function parseMandate(value: string): RunMandateSnapshot {
  const parsed = parseJson(value, "mandate");
  if (parsed.schemaVersion !== "RunMandateSnapshot@1") {
    throw new Error("Agent Run mandate schemaVersion is unsupported");
  }
  if (parsed.kind === "objective") {
    exactKeys(parsed, [
      "schemaVersion",
      "kind",
      "objective",
      "renderedInstruction",
      ...(parsed.participantAgentIds === undefined ? [] : ["participantAgentIds"])
    ], "mandate");
    return {
      schemaVersion: "RunMandateSnapshot@1",
      kind: "objective",
      objective: textValue(parsed.objective, "mandate.objective", 16_384),
      renderedInstruction: textValue(
        parsed.renderedInstruction,
        "mandate.renderedInstruction",
        65_536
      ),
      ...participantAgentIds(parsed.participantAgentIds)
    };
  }
  if (parsed.kind !== "workflow") {
    throw new Error("Agent Run mandate kind is unsupported");
  }
  exactKeys(parsed, [
    "schemaVersion",
    "kind",
    "workflowRef",
    "workflowId",
    "workflowVersion",
    "inputs",
    "renderedInstruction",
    ...(parsed.participantAgentIds === undefined ? [] : ["participantAgentIds"])
  ], "mandate");
  const inputs = parsed.inputs;
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
    throw new Error("Agent Run mandate inputs are malformed");
  }
  const encodedInputs = JSON.stringify(inputs);
  if (Buffer.byteLength(encodedInputs, "utf8") > 32_768) {
    throw new Error("Agent Run mandate inputs exceed 32768 bytes");
  }
  return {
    schemaVersion: "RunMandateSnapshot@1",
    kind: "workflow",
    workflowRef: textValue(parsed.workflowRef, "mandate.workflowRef", 256),
    workflowId: textValue(parsed.workflowId, "mandate.workflowId", 64),
    workflowVersion: bounded(
      parsed.workflowVersion as number,
      1,
      999_999,
      "mandate.workflowVersion"
    ),
    inputs: inputs as Readonly<Record<string, unknown>>,
    renderedInstruction: textValue(
      parsed.renderedInstruction,
      "mandate.renderedInstruction",
      65_536
    ),
    ...participantAgentIds(parsed.participantAgentIds)
  };
}

function participantAgentIds(
  value: unknown
): { readonly participantAgentIds?: readonly string[] } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length === 0 || value.length > 64 ||
    value.some((item) => typeof item !== "string" || item.trim() === "" || item.length > 256) ||
    new Set(value).size !== value.length) {
    throw new Error("Agent Run participantAgentIds are malformed");
  }
  return { participantAgentIds: value as string[] };
}

function parseWorkspaceGrant(value: string): ExternalWorkspaceGrant {
  const parsed = parseJson(value, "workspaceGrant");
  exactKeys(parsed, [
    "schemaVersion",
    "root",
    "access",
    "effect",
    "revision",
    "networkAccess"
  ], "workspaceGrant", ["effect", "networkAccess"]);
  if (parsed.schemaVersion !== "ExternalWorkspaceGrant@1") {
    throw new Error("Agent Run workspaceGrant schemaVersion is unsupported");
  }
  if (parsed.access !== "read" && parsed.access !== "write") {
    throw new Error("Agent Run workspaceGrant access is unsupported");
  }
  if (parsed.networkAccess !== undefined && typeof parsed.networkAccess !== "boolean") {
    throw new Error("Agent Run workspaceGrant networkAccess is unsupported");
  }
  if (parsed.networkAccess === true && parsed.access !== "write") {
    throw new Error("Agent Run workspaceGrant networkAccess requires write access");
  }
  if (parsed.effect !== undefined && parsed.effect !== "must_change" &&
    parsed.effect !== "may_remain_unchanged") {
    throw new Error("Agent Run workspaceGrant effect is unsupported");
  }
  if (parsed.effect !== undefined && parsed.access !== "write") {
    throw new Error("Agent Run workspaceGrant effect requires write access");
  }
  return {
    schemaVersion: "ExternalWorkspaceGrant@1",
    root: textValue(parsed.root, "workspaceGrant.root", 4_096),
    access: parsed.access,
    ...(parsed.effect === undefined ? {} : { effect: parsed.effect }),
    ...(parsed.networkAccess === undefined
      ? {}
      : { networkAccess: parsed.networkAccess }),
    revision: textValue(parsed.revision, "workspaceGrant.revision", 512)
  };
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string,
  optional: readonly string[] = []
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new Error(`Agent Run ${field} has unknown field: ${unknown}`);
  }
  const missing = allowed.find((key) => !optional.includes(key) && !(key in value));
  if (missing !== undefined) {
    throw new Error(`Agent Run ${field} is missing field: ${missing}`);
  }
}

function textValue(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return text(value, field, maximum);
}

function boundedJson(value: unknown, field: string, maximum: number): string {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > maximum) {
    throw new Error(`${field} exceeds ${maximum} bytes`);
  }
  return encoded;
}

function text(value: string, field: string, maximum: number): string {
  if (value.trim() === "" || value.length > maximum) {
    throw new Error(`${field} must be non-empty and at most ${maximum} characters`);
  }
  return value;
}

function bounded(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function iso(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("timestamp must be RFC3339");
  return new Date(value).toISOString();
}
