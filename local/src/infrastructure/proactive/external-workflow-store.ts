import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  EXTERNAL_WORKFLOW_RECEIPT_SCHEMA,
  externalWorkflowExecutionId,
  parseExternalWorkflowExecutionReceipt,
  parseProactiveTarget,
  proactiveTargetDigest,
  type ExternalWorkflowExecution,
  type ExternalWorkflowExecutionReceipt,
  type ExternalWorkflowProactiveTarget,
  type TriggerSourceRef
} from "../../modules/proactive/target.js";
import {
  boundedContractValue,
  stableContractJson
} from "../../modules/steward/contract-codec.js";
import { withImmediateTransaction } from "../sqlite/transaction.js";

interface ExecutionRow {
  readonly execution_id: string;
  readonly source_kind: TriggerSourceRef["kind"];
  readonly source_id: string;
  readonly definition_revision: string;
  readonly occurrence_key: string;
  readonly target_json: string;
  readonly observation_json: string;
  readonly status: ExternalWorkflowExecution["status"];
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly next_attempt_at: string;
  readonly lease_owner: string | null;
  readonly lease_token: string | null;
  readonly lease_expires_at: string | null;
  readonly effect_started_at: string | null;
  readonly receipt_json: string | null;
  readonly resolution_receipt_json: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly updated_at: string;
}

export interface ClaimedExternalWorkflowExecution {
  readonly execution: ExternalWorkflowExecution;
  readonly leaseToken: string;
}

export class ExternalWorkflowStore {
  readonly #database: DatabaseSync;

  public constructor(database: DatabaseSync) {
    this.#database = database;
  }

  public enqueueInTransaction(input: {
    readonly target: ExternalWorkflowProactiveTarget;
    readonly source: TriggerSourceRef;
    readonly occurrenceKey: string;
    readonly observation: unknown;
    readonly at: string;
  }): ExternalWorkflowExecution {
    if (!this.#database.isTransaction) {
      throw new Error("external workflow enqueue requires an owning transaction");
    }
    const target = parseProactiveTarget(input.target, input.source);
    if (target.kind !== "external_workflow") {
      throw new Error("external workflow target is required");
    }
    const timestamp = iso(input.at);
    const occurrenceKey = text(input.occurrenceKey, "occurrenceKey", 512);
    const executionId = externalWorkflowExecutionId({
      source: input.source,
      occurrenceKey
    });
    const targetJson = boundedJson(target, "external workflow target", 65_536);
    const observationJson = boundedJson(
      boundedContractValue(input.observation, "external workflow observation"),
      "external workflow observation",
      65_536
    );
    this.#database.prepare(`
      INSERT INTO external_workflow_executions (
        execution_id, source_kind, source_id, definition_revision, occurrence_key,
        target_digest, workflow_ref, registration_digest, target_json,
        observation_json, status, attempt_count, max_attempts, next_attempt_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
      ON CONFLICT(source_kind, source_id, occurrence_key) DO NOTHING
    `).run(
      executionId,
      input.source.kind,
      input.source.id,
      input.source.definitionRevision,
      occurrenceKey,
      proactiveTargetDigest(target),
      target.workflow.workflowRef,
      target.workflow.registrationDigest,
      targetJson,
      observationJson,
      target.workflow.executionPolicy.maxAttempts,
      timestamp,
      timestamp,
      timestamp
    );
    const execution = this.requireExecution(executionId);
    if (proactiveTargetDigest(execution.target) !== proactiveTargetDigest(target) ||
      stableContractJson(execution.observation) !==
        stableContractJson(JSON.parse(observationJson) as unknown)) {
      throw new Error("external workflow occurrence is already bound to another request");
    }
    return execution;
  }

  public claimDue(
    leaseOwner: string,
    now = new Date().toISOString(),
    limit = 1,
    leaseMilliseconds = 30_000
  ): ClaimedExternalWorkflowExecution[] {
    const timestamp = iso(now);
    const owner = text(leaseOwner, "leaseOwner", 256);
    const expiresAt = addMilliseconds(timestamp, integer(
      leaseMilliseconds,
      "leaseMilliseconds",
      5_000,
      300_000
    ));
    return withImmediateTransaction(this.#database, () => {
      const rows = this.#database.prepare(`
        SELECT execution_id FROM external_workflow_executions
        WHERE status IN ('queued', 'retry_wait')
          AND attempt_count < max_attempts
          AND julianday(next_attempt_at) <= julianday(?)
        ORDER BY next_attempt_at, created_at, execution_id
        LIMIT ?
      `).all(timestamp, integer(limit, "limit", 1, 16)) as unknown as Array<{
        execution_id: string;
      }>;
      const claimed: ClaimedExternalWorkflowExecution[] = [];
      for (const row of rows) {
        const leaseToken = randomUUID();
        const changed = this.#database.prepare(`
          UPDATE external_workflow_executions
          SET status = 'claimed', attempt_count = attempt_count + 1,
            lease_owner = ?, lease_token = ?, lease_expires_at = ?,
            started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE execution_id = ? AND status IN ('queued', 'retry_wait')
            AND attempt_count < max_attempts
        `).run(
          owner,
          leaseToken,
          expiresAt,
          timestamp,
          timestamp,
          row.execution_id
        );
        if (changed.changes === 1) {
          claimed.push({ execution: this.requireExecution(row.execution_id), leaseToken });
        }
      }
      return claimed;
    });
  }

  public renewLease(
    executionId: string,
    leaseOwner: string,
    leaseToken: string,
    at = new Date().toISOString(),
    leaseMilliseconds = 30_000
  ): void {
    const timestamp = iso(at);
    const changed = this.#database.prepare(`
      UPDATE external_workflow_executions
      SET lease_expires_at = ?, updated_at = ?
      WHERE execution_id = ? AND lease_owner = ? AND lease_token = ?
        AND status IN ('claimed', 'running')
    `).run(
      addMilliseconds(timestamp, integer(leaseMilliseconds, "leaseMilliseconds", 5_000, 300_000)),
      timestamp,
      executionId,
      leaseOwner,
      leaseToken
    );
    if (changed.changes !== 1) {
      throw new Error(`external workflow lease was lost: ${executionId}`);
    }
  }

  public markEffectStarted(
    executionId: string,
    leaseOwner: string,
    leaseToken: string,
    at = new Date().toISOString()
  ): ExternalWorkflowExecution {
    const timestamp = iso(at);
    const changed = this.#database.prepare(`
      UPDATE external_workflow_executions
      SET status = 'running', effect_started_at = ?, updated_at = ?
      WHERE execution_id = ? AND lease_owner = ? AND lease_token = ?
        AND status = 'claimed'
    `).run(timestamp, timestamp, executionId, leaseOwner, leaseToken);
    if (changed.changes !== 1) {
      throw new Error(`external workflow cannot start or lease was lost: ${executionId}`);
    }
    return this.requireExecution(executionId);
  }

  public failBeforeEffect(
    executionId: string,
    leaseOwner: string,
    leaseToken: string,
    error: string,
    retryBackoffMilliseconds: number,
    at = new Date().toISOString()
  ): ExternalWorkflowExecution {
    const timestamp = iso(at);
    return withImmediateTransaction(this.#database, () => {
      const execution = this.requireOwned(executionId, leaseOwner, leaseToken, "claimed");
      const failure = text(error, "error", 4_096);
      if (execution.attemptCount < execution.maxAttempts) {
        this.#database.prepare(`
          UPDATE external_workflow_executions
          SET status = 'retry_wait', next_attempt_at = ?, lease_owner = NULL,
            lease_token = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
          WHERE execution_id = ? AND lease_owner = ? AND lease_token = ?
        `).run(
          addMilliseconds(timestamp, integer(
            retryBackoffMilliseconds,
            "retryBackoffMilliseconds",
            1_000,
            3_600_000
          )),
          failure,
          timestamp,
          executionId,
          leaseOwner,
          leaseToken
        );
        return this.requireExecution(executionId);
      }
      return this.#terminalize(execution, leaseOwner, leaseToken, {
        status: "failed",
        error: failure,
        summary: "External workflow failed before an external effect could start"
      }, timestamp);
    });
  }

  public succeed(
    executionId: string,
    leaseOwner: string,
    leaseToken: string,
    result: {
      readonly stdout: string;
      readonly stderr: string;
      readonly summary?: string;
    },
    at = new Date().toISOString()
  ): ExternalWorkflowExecution {
    const timestamp = iso(at);
    return withImmediateTransaction(this.#database, () => this.#terminalize(
      this.requireOwned(executionId, leaseOwner, leaseToken, "running"),
      leaseOwner,
      leaseToken,
      {
        status: "succeeded",
        exitCode: 0,
        stdout: boundedOutput(result.stdout),
        stderr: boundedOutput(result.stderr),
        ...(result.summary === undefined ? {} : { summary: result.summary })
      },
      timestamp
    ));
  }

  public failAfterEffect(
    executionId: string,
    leaseOwner: string,
    leaseToken: string,
    result: {
      readonly outcome: "failed" | "unknown";
      readonly error: string;
      readonly exitCode?: number;
      readonly stdout?: string;
      readonly stderr?: string;
    },
    at = new Date().toISOString()
  ): ExternalWorkflowExecution {
    const timestamp = iso(at);
    return withImmediateTransaction(this.#database, () => this.#terminalize(
      this.requireOwned(executionId, leaseOwner, leaseToken, "running"),
      leaseOwner,
      leaseToken,
      {
        status: result.outcome,
        error: text(result.error, "error", 4_096),
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        ...(result.stdout === undefined ? {} : { stdout: boundedOutput(result.stdout) }),
        ...(result.stderr === undefined ? {} : { stderr: boundedOutput(result.stderr) })
      },
      timestamp
    ));
  }

  public recoverInterrupted(at = new Date().toISOString()): {
    readonly retried: readonly string[];
    readonly failed: readonly string[];
    readonly unknown: readonly string[];
  } {
    const timestamp = iso(at);
    return withImmediateTransaction(this.#database, () => {
      const retried: string[] = [];
      const failed: string[] = [];
      const unknown: string[] = [];
      const rows = this.#database.prepare(`
        SELECT * FROM external_workflow_executions
        WHERE status IN ('claimed', 'running')
        ORDER BY created_at, execution_id
      `).all() as unknown as ExecutionRow[];
      for (const row of rows) {
        const execution = mapExecution(row);
        if (execution.status === "claimed" && execution.attemptCount < execution.maxAttempts) {
          this.#database.prepare(`
            UPDATE external_workflow_executions
            SET status = 'retry_wait', next_attempt_at = ?, lease_owner = NULL,
              lease_token = NULL, lease_expires_at = NULL,
              last_error = 'runtime-interrupted-before-effect', updated_at = ?
            WHERE execution_id = ? AND status = 'claimed'
          `).run(timestamp, timestamp, execution.executionId);
          retried.push(execution.executionId);
          continue;
        }
        const owner = execution.leaseOwner!;
        const token = execution.leaseToken!;
        const outcome = execution.status === "running" ? "unknown" : "failed";
        this.#terminalize(execution, owner, token, {
          status: outcome,
          error: outcome === "unknown"
            ? "runtime interrupted after external effect boundary"
            : "runtime interrupted before effect and attempt budget was exhausted"
        }, timestamp);
        (outcome === "unknown" ? unknown : failed).push(execution.executionId);
      }
      return { retried, failed, unknown };
    });
  }

  public resolveUnknown(
    executionId: string,
    outcome: "succeeded" | "failed",
    summary: string,
    at = new Date().toISOString()
  ): ExternalWorkflowExecution {
    const timestamp = iso(at);
    return withImmediateTransaction(
      this.#database,
      () => this.resolveUnknownInTransaction(executionId, outcome, summary, timestamp)
    );
  }

  public resolveUnknownInTransaction(
    executionId: string,
    outcome: "succeeded" | "failed",
    summary: string,
    at = new Date().toISOString()
  ): ExternalWorkflowExecution {
    if (!this.#database.isTransaction) {
      throw new Error("external workflow unknown resolution requires an owning transaction");
    }
    const timestamp = iso(at);
    const execution = this.requireExecution(executionId);
    if (execution.status !== "unknown" || execution.receipt?.status !== "unknown") {
      throw new Error(`external workflow execution is not unknown: ${executionId}`);
    }
    const receipt = this.#receipt(execution, {
      status: outcome,
      summary: text(summary, "summary", 4_096),
      ...(outcome === "failed" ? { error: "Owner resolved unknown outcome as failed" } : {})
    }, timestamp, "manual");
    const encoded = receiptJson(receipt);
    const changed = this.#database.prepare(`
      UPDATE external_workflow_executions
      SET status = ?, resolution_receipt_json = ?, last_error = ?, completed_at = ?,
        updated_at = ?
      WHERE execution_id = ? AND status = 'unknown'
        AND resolution_receipt_json IS NULL
    `).run(
      outcome,
      encoded,
      outcome === "failed" ? receipt.error ?? null : null,
      timestamp,
      timestamp,
      executionId
    );
    if (changed.changes !== 1) {
      throw new Error(`external workflow unknown resolution conflicted: ${executionId}`);
    }
    return this.requireExecution(executionId);
  }

  public execution(
    source: TriggerSourceRef,
    occurrenceKey: string
  ): ExternalWorkflowExecution | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM external_workflow_executions
      WHERE source_kind = ? AND source_id = ? AND occurrence_key = ?
    `).get(source.kind, source.id, occurrenceKey) as ExecutionRow | undefined;
    return row === undefined ? undefined : mapExecution(row);
  }

  public executionById(executionId: string): ExternalWorkflowExecution | undefined {
    const row = this.#database.prepare(`
      SELECT * FROM external_workflow_executions WHERE execution_id = ?
    `).get(executionId) as ExecutionRow | undefined;
    return row === undefined ? undefined : mapExecution(row);
  }

  public requireExecution(executionId: string): ExternalWorkflowExecution {
    const execution = this.executionById(executionId);
    if (execution === undefined) {
      throw new Error(`External workflow execution not found: ${executionId}`);
    }
    return execution;
  }

  #terminalize(
    execution: ExternalWorkflowExecution,
    leaseOwner: string,
    leaseToken: string,
    outcome: {
      readonly status: "succeeded" | "failed" | "unknown";
      readonly summary?: string;
      readonly exitCode?: number;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly error?: string;
    },
    at: string
  ): ExternalWorkflowExecution {
    const receipt = this.#receipt(execution, outcome, at, "runtime");
    const changed = this.#database.prepare(`
      UPDATE external_workflow_executions
      SET status = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        receipt_json = ?, last_error = ?, completed_at = ?, updated_at = ?
      WHERE execution_id = ? AND lease_owner = ? AND lease_token = ?
        AND status IN ('claimed', 'running')
    `).run(
      outcome.status,
      receiptJson(receipt),
      receipt.error ?? null,
      at,
      at,
      execution.executionId,
      leaseOwner,
      leaseToken
    );
    if (changed.changes !== 1) {
      throw new Error(`external workflow lease was lost before terminal receipt: ${execution.executionId}`);
    }
    return this.requireExecution(execution.executionId);
  }

  #receipt(
    execution: ExternalWorkflowExecution,
    outcome: {
      readonly status: "succeeded" | "failed" | "unknown";
      readonly summary?: string;
      readonly exitCode?: number;
      readonly stdout?: string;
      readonly stderr?: string;
      readonly error?: string;
    },
    at: string,
    resolution: "runtime" | "manual"
  ): ExternalWorkflowExecutionReceipt {
    return parseExternalWorkflowExecutionReceipt({
      schemaVersion: EXTERNAL_WORKFLOW_RECEIPT_SCHEMA,
      executionId: execution.executionId,
      source: execution.source,
      occurrenceKey: execution.occurrenceKey,
      targetDigest: proactiveTargetDigest(execution.target),
      workflowRef: execution.target.workflow.workflowRef,
      registrationDigest: execution.target.workflow.registrationDigest,
      status: outcome.status,
      attemptCount: execution.attemptCount,
      resolution,
      ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
      ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
      ...(outcome.stdout === undefined ? {} : { stdout: outcome.stdout }),
      ...(outcome.stderr === undefined ? {} : { stderr: outcome.stderr }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      completedAt: at
    });
  }

  private requireOwned(
    executionId: string,
    leaseOwner: string,
    leaseToken: string,
    status: "claimed" | "running"
  ): ExternalWorkflowExecution {
    const execution = this.requireExecution(executionId);
    if (execution.status !== status || execution.leaseOwner !== leaseOwner ||
      execution.leaseToken !== leaseToken) {
      throw new Error(`external workflow lease is not owned: ${executionId}`);
    }
    return execution;
  }
}

function mapExecution(row: ExecutionRow): ExternalWorkflowExecution {
  const source: TriggerSourceRef = {
    kind: row.source_kind,
    id: row.source_id,
    definitionRevision: row.definition_revision
  };
  const target = parseProactiveTarget(JSON.parse(row.target_json) as unknown, source);
  if (target.kind !== "external_workflow") {
    throw new Error(`External workflow execution target is invalid: ${row.execution_id}`);
  }
  const runtimeReceipt = row.receipt_json === null
    ? undefined
    : parseExternalWorkflowExecutionReceipt(JSON.parse(row.receipt_json) as unknown);
  const resolutionReceipt = row.resolution_receipt_json === null
    ? undefined
    : parseExternalWorkflowExecutionReceipt(JSON.parse(row.resolution_receipt_json) as unknown);
  return {
    executionId: row.execution_id,
    source,
    occurrenceKey: row.occurrence_key,
    target,
    observation: JSON.parse(row.observation_json) as unknown,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_token === null ? {} : { leaseToken: row.lease_token }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.effect_started_at === null ? {} : { effectStartedAt: row.effect_started_at }),
    ...(resolutionReceipt === undefined && runtimeReceipt === undefined
      ? {}
      : { receipt: resolutionReceipt ?? runtimeReceipt }),
    ...(runtimeReceipt?.status === "unknown" && resolutionReceipt !== undefined
      ? { unknownReceipt: runtimeReceipt }
      : {}),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    createdAt: row.created_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    updatedAt: row.updated_at
  } as ExternalWorkflowExecution;
}

function boundedJson(value: unknown, field: string, maximum: number): string {
  const encoded = stableContractJson(value);
  if (Buffer.byteLength(encoded, "utf8") > maximum) {
    throw new Error(`${field} exceeds ${maximum} bytes`);
  }
  return encoded;
}

function receiptJson(receipt: ExternalWorkflowExecutionReceipt): string {
  return boundedJson(receipt, "external workflow receipt", 131_072);
}

function boundedOutput(value: string): string {
  return value.length <= 65_536 ? value : value.slice(0, 65_536);
}

function text(value: string, field: string, maximum: number): string {
  if (value.trim() === "" || value.length > maximum) {
    throw new Error(`${field} must be a non-empty string up to ${maximum} characters`);
  }
  return value;
}

function iso(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("timestamp must be RFC 3339");
  return new Date(milliseconds).toISOString();
}

function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function integer(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
