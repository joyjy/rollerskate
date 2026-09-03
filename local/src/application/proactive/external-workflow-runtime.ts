import { randomUUID } from "node:crypto";

import { HostCommandExecutionError } from "../../integrations/host-command.js";
import type { HostCommandExecutor } from "../../integrations/host-command.js";
import type { ExternalWorkflowExecution } from "../../modules/proactive/target.js";
import { stableContractJson } from "../../modules/steward/contract-codec.js";
import type { ExternalWorkflowStore } from
  "../../infrastructure/proactive/external-workflow-store.js";
import type { OwnerExternalWorkflowRegistry } from "./external-workflow-registry.js";

export interface ExternalWorkflowCycleResult {
  readonly claimed: readonly string[];
  readonly succeeded: readonly string[];
  readonly failed: readonly string[];
  readonly unknown: readonly string[];
  readonly errors: readonly { readonly executionId: string; readonly error: string }[];
}

export class ExternalWorkflowRuntime {
  readonly #store: ExternalWorkflowStore;
  readonly #registry: OwnerExternalWorkflowRegistry;
  readonly #executor: HostCommandExecutor;
  readonly #leaseOwner = `external-workflow:${process.pid}:${randomUUID()}`;
  readonly #active = new Map<string, {
    readonly leaseToken: string;
    readonly promise: Promise<void>;
  }>();
  readonly #completed: {
    succeeded: string[];
    failed: string[];
    unknown: string[];
    errors: Array<{ executionId: string; error: string }>;
  } = { succeeded: [], failed: [], unknown: [], errors: [] };

  public constructor(input: {
    readonly store: ExternalWorkflowStore;
    readonly registry: OwnerExternalWorkflowRegistry;
    readonly executor: HostCommandExecutor;
  }) {
    this.#store = input.store;
    this.#registry = input.registry;
    this.#executor = input.executor;
  }

  public poll(signal: AbortSignal, at = new Date().toISOString()): ExternalWorkflowCycleResult {
    const completed = this.#takeCompleted();
    for (const [executionId, active] of this.#active) {
      try {
        this.#store.renewLease(executionId, this.#leaseOwner, active.leaseToken, at);
      } catch (error) {
        this.#completed.errors.push({ executionId, error: message(error) });
      }
    }
    if (signal.aborted || this.#active.size >= 1) return completed;
    const claimed = this.#store.claimDue(this.#leaseOwner, at, 1);
    for (const item of claimed) {
      const executionId = item.execution.executionId;
      const promise = this.#execute(item.execution, item.leaseToken, signal)
        .catch((error) => {
          this.#completed.errors.push({ executionId, error: message(error) });
        })
        .finally(() => {
          this.#active.delete(executionId);
        });
      this.#active.set(executionId, { leaseToken: item.leaseToken, promise });
    }
    return { ...completed, claimed: claimed.map(({ execution }) => execution.executionId) };
  }

  public async settle(): Promise<ExternalWorkflowCycleResult> {
    await Promise.all([...this.#active.values()].map(({ promise }) => promise));
    return this.#takeCompleted();
  }

  async #execute(
    execution: ExternalWorkflowExecution,
    leaseToken: string,
    signal: AbortSignal
  ): Promise<void> {
    let registration;
    try {
      registration = this.#registry.resolve(execution.target);
    } catch (error) {
      const current = this.#store.failBeforeEffect(
        execution.executionId,
        this.#leaseOwner,
        leaseToken,
        message(error),
        execution.target.workflow.executionPolicy.retryBackoffMilliseconds
      );
      if (current.status === "failed") this.#completed.failed.push(execution.executionId);
      return;
    }
    this.#store.markEffectStarted(
      execution.executionId,
      this.#leaseOwner,
      leaseToken
    );
    try {
      const result = await this.#executor.executeHostCommand({
        executable: registration.executable,
        arguments: registration.arguments,
        cwd: registration.cwd,
        environment: {
          ...registration.environment,
          ROLLERSKATE_WORKFLOW_REQUEST_ID: execution.executionId,
          ROLLERSKATE_WORKFLOW_ATTEMPT: String(execution.attemptCount)
        },
        timeoutMilliseconds: registration.timeoutMilliseconds,
        maxOutputBytes: registration.maxOutputBytes,
        signal,
        stdin: `${stableContractJson({
          schemaVersion: "ExternalWorkflowInput@1",
          requestId: execution.executionId,
          source: execution.source,
          occurrenceKey: execution.occurrenceKey,
          workflowRef: execution.target.workflow.workflowRef,
          input: execution.target.workflow.input,
          observation: execution.observation
        })}\n`
      });
      this.#store.succeed(execution.executionId, this.#leaseOwner, leaseToken, {
        stdout: result.stdout,
        stderr: result.stderr,
        summary: lastNonEmptyLine(result.stdout) ?? "External workflow completed"
      });
      this.#completed.succeeded.push(execution.executionId);
    } catch (error) {
      const failure = error instanceof HostCommandExecutionError
        ? {
            outcome: error.outcome,
            error: error.message,
            ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
            stdout: error.stdout,
            stderr: error.stderr
          }
        : {
            outcome: "unknown" as const,
            error: message(error)
          };
      const terminal = this.#store.failAfterEffect(
        execution.executionId,
        this.#leaseOwner,
        leaseToken,
        failure
      );
      (terminal.status === "unknown" ? this.#completed.unknown : this.#completed.failed)
        .push(execution.executionId);
    }
  }

  #takeCompleted(): ExternalWorkflowCycleResult {
    return {
      claimed: [],
      succeeded: this.#completed.succeeded.splice(0),
      failed: this.#completed.failed.splice(0),
      unknown: this.#completed.unknown.splice(0),
      errors: this.#completed.errors.splice(0)
    };
  }
}

function lastNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1);
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}
