import type { DatabaseSync } from "node:sqlite";

import { openRuntimeDatabase } from "./database.js";
import { migrateLocalDatabase } from "./local-schema.js";
import {
  isTerminal,
  requireAgentRunId,
  type AgentRunProjection,
  type AgentRunStatus,
  type RunMandateSnapshot
} from "../../modules/agent-run/state-machine.js";
import type { ExternalWorkspaceGrant } from "../../core/runtime/model.js";

interface AgentRunRow {
  run_id: string;
  root_event_id: string;
  owner_request_id: string;
  owner_principal_id: string;
  steward_agent_id: string;
  mandate_snapshot_json: string;
  workspace_grant_json: string | null;
  status: AgentRunStatus;
  active_step_id: string | null;
  active_execution_id: string | null;
  step_count: number;
  max_steps: number;
  max_depth: number;
  deadline_at: string | null;
  terminal_summary: string | null;
  cancelled_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CreateAgentRunRecord {
  readonly runId: string;
  readonly rootEventId: string;
  readonly rootExecutionId: string;
  readonly ownerRequestId: string;
  readonly ownerPrincipalId: string;
  readonly stewardAgentId: string;
  readonly mandate: RunMandateSnapshot;
  readonly workspaceGrant?: ExternalWorkspaceGrant;
  readonly rootStepId: string;
  readonly maxSteps: number;
  readonly maxDepth: number;
  readonly deadlineAt?: string;
  readonly createdAt: string;
}

export interface ActiveAgentRunTarget {
  readonly agentId: string;
  readonly handle: string;
}

export class AgentRunStore {
  readonly #database: DatabaseSync;
  readonly #ownsDatabase: boolean;

  public constructor(database: string | DatabaseSync) {
    if (typeof database === "string") {
      this.#database = openRuntimeDatabase(database);
      this.#ownsDatabase = true;
    } else {
      this.#database = database;
      this.#ownsDatabase = false;
    }
    migrateLocalDatabase(this.#database);
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
        steward_agent_id, mandate_snapshot_json, workspace_grant_json,
        status, active_step_id, active_execution_id, step_count,
        max_steps, max_depth, deadline_at, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1, ?, ?, ?, 1, ?, ?)
    `).run(
      input.runId,
      input.rootEventId,
      text(input.ownerRequestId, "ownerRequestId", 256),
      text(input.ownerPrincipalId, "ownerPrincipalId", 256),
      text(input.stewardAgentId, "stewardAgentId", 256),
      boundedJson(input.mandate, "mandate", 65_536),
      input.workspaceGrant === undefined
        ? null
        : boundedJson(input.workspaceGrant, "workspaceGrant", 16_384),
      text(input.rootStepId, "rootStepId", 256),
      input.rootExecutionId,
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
    currentAgentId: string
  ): readonly ActiveAgentRunTarget[] {
    return (this.#database.prepare(`
      SELECT principal_id, handle
      FROM agents
      WHERE status = 'active' AND principal_id <> ?
      ORDER BY handle_key, principal_id
    `).all(text(currentAgentId, "currentAgentId", 256)) as unknown as Array<{
      principal_id: string;
      handle: string;
    }>).map((row) => ({
      agentId: row.principal_id,
      handle: row.handle
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
        step_count = ?, version = version + 1, updated_at = ?
      WHERE run_id = ? AND version = ?
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

  public terminalizeInTransaction(input: {
    readonly runId: string;
    readonly expectedVersion: number;
    readonly status: "succeeded" | "failed" | "needs_human";
    readonly summary: string;
    readonly updatedAt: string;
  }): AgentRunProjection {
    const changed = this.#database.prepare(`
      UPDATE agent_runs
      SET status = ?, active_step_id = NULL, active_execution_id = NULL,
        terminal_summary = ?, version = version + 1, updated_at = ?
      WHERE run_id = ? AND version = ?
        AND status IN ('active', 'waiting')
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
    const changed = this.#database.prepare(`
      UPDATE agent_runs
      SET status = 'cancelled', active_step_id = NULL,
        active_execution_id = NULL,
        terminal_summary = 'Cancelled by Owner', cancelled_at = ?,
        version = version + 1, updated_at = ?
      WHERE run_id = ? AND version = ?
        AND status IN ('active', 'waiting')
    `).run(timestamp, timestamp, runId, current.version);
    if (changed.changes !== 1) throw new Error(`Agent Run cancel CAS failed: ${runId}`);
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
    mandate: parseMandate(row.mandate_snapshot_json),
    ...(row.workspace_grant_json === null
      ? {}
      : {
          workspaceGrant: parseWorkspaceGrant(row.workspace_grant_json)
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
    ...(row.terminal_summary === null
      ? {}
      : { terminalSummary: row.terminal_summary }),
    ...(row.cancelled_at === null ? {} : { cancelledAt: row.cancelled_at }),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
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
      "renderedInstruction"
    ], "mandate");
    return {
      schemaVersion: "RunMandateSnapshot@1",
      kind: "objective",
      objective: textValue(parsed.objective, "mandate.objective", 16_384),
      renderedInstruction: textValue(
        parsed.renderedInstruction,
        "mandate.renderedInstruction",
        65_536
      )
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
    "renderedInstruction"
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
    )
  };
}

function parseWorkspaceGrant(value: string): ExternalWorkspaceGrant {
  const parsed = parseJson(value, "workspaceGrant");
  exactKeys(parsed, [
    "schemaVersion",
    "root",
    "access",
    "revision"
  ], "workspaceGrant");
  if (parsed.schemaVersion !== "ExternalWorkspaceGrant@1") {
    throw new Error("Agent Run workspaceGrant schemaVersion is unsupported");
  }
  if (parsed.access !== "read" && parsed.access !== "write") {
    throw new Error("Agent Run workspaceGrant access is unsupported");
  }
  return {
    schemaVersion: "ExternalWorkspaceGrant@1",
    root: textValue(parsed.root, "workspaceGrant.root", 4_096),
    access: parsed.access,
    revision: textValue(parsed.revision, "workspaceGrant.revision", 512)
  };
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new Error(`Agent Run ${field} has unknown field: ${unknown}`);
  }
  const missing = allowed.find((key) => !(key in value));
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
