import type {
  AgentInvocationDiagnostics,
  AgentInvocationFailure
} from
  "../../core/runtime/agent-invocation.js";
import type {
  AgentRequestEvent,
  AgentResultEvent
} from "../../core/event/model.js";
import type { RuntimeAgentResultContinuation } from
  "../../core/runtime/handlers.js";
import type { RuntimeExecution } from "../../core/runtime/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import {
  workspaceRevision,
  type WorkspaceRevision
} from "../../infrastructure/workspace/revision.js";
import {
  parseAgentTurnAdjudication,
  type AgentTurnAdjudication
} from "../../modules/steward/result-adjudication.js";
import {
  parseAgentTurnResult,
  type AgentTurnResult
} from "../../modules/steward/result-contract.js";
import type { AgentRunProjection } from "../../modules/steward/state-machine.js";
import { workspaceEffectFailure } from
  "../../modules/steward/workspace-effect.js";
import {
  agentTurnAdjudicationPrompt,
  agentTurnRetryPrompt
} from "./prompt.js";

interface RecoveryOptions {
  readonly runs: AgentRunStore;
  readonly runtime: RuntimeStore;
  readonly continueAcceptedTurn: (
    execution: RuntimeExecution,
    result: AgentResultEvent,
    request: AgentRequestEvent,
    at: string
  ) => boolean;
}

export function agentTurnRecoveryContinuations(
  options: RecoveryOptions
): readonly RuntimeAgentResultContinuation[] {
  return [
    new AgentTurnAdjudicationContinuation(options),
    new AgentTurnRetryContinuation(options)
  ];
}

export function requestAgentTurnAdjudicationInTransaction(input: {
  readonly runs: AgentRunStore;
  readonly runtime: RuntimeStore;
  readonly execution: RuntimeExecution;
  readonly result: AgentResultEvent;
  readonly request: AgentRequestEvent;
  readonly run: AgentRunProjection;
  readonly contractError: string;
  readonly observedWorkspace?: WorkspaceRevision;
  readonly at: string;
}): void {
  const context = input.request.runContext!;
  input.runs.requireActiveAgent(input.run.stewardAgentId);
  const stewardSession = input.runtime.sessionForRunAgent(
    input.run.runId,
    input.run.stewardAgentId,
    input.run.activeCycleId
  );
  const originalAudit = input.runtime.audit(input.request.eventId);
  const recovery = input.runtime.appendEventInTransaction({
    type: "agent.request",
    source: {
      kind: "handler",
      externalId: `agent-run:${input.run.runId}:adjudicate:${context.stepId}`
    },
    agentId: input.run.stewardAgentId,
    ...(stewardSession === undefined ? {} : { sessionId: stewardSession.sessionId }),
    prompt: agentTurnAdjudicationPrompt({
      runId: input.run.runId,
      stepId: context.stepId,
      originalAgentId: input.request.agentId,
      contractError: input.contractError,
      terminalEvidence: terminalEvidence(
        input.result,
        originalAudit?.execution,
        originalAudit?.invocation,
        originalAudit?.invocationFailure
      ),
      ...(input.run.workspaceGrant === undefined || input.observedWorkspace === undefined
        ? {}
        : {
            workspaceEvidence: workspaceEvidence(
              input.run.workspaceGrant.revision,
              input.observedWorkspace
            )
          })
    }),
    runContext: {
      ...context,
      resultContractId: "agent-turn-adjudication@1"
    },
    parent: {
      eventId: input.result.eventId,
      rootEventId: input.result.causality.rootEventId,
      hop: input.result.causality.hop
    },
    maxAttempts: 1,
    createdAt: input.at
  });
  if (recovery.status !== "accepted") {
    throw new Error("Agent turn adjudication Event unexpectedly duplicated");
  }
  input.runs.advanceInTransaction({
    runId: input.run.runId,
    expectedVersion: input.run.version,
    status: "active",
    activeStepId: context.stepId,
    activeExecutionId: recovery.execution.executionId,
    stepCount: input.run.stepCount,
    updatedAt: input.at
  });
  input.runtime.recordExecutionReceiptInTransaction(input.execution.executionId, {
    schema: "AgentRunContinuationReceipt@1",
    runId: input.run.runId,
    stepId: context.stepId,
    outcome: "adjudication_requested",
    error: input.contractError,
    nextEventId: recovery.event.eventId,
    nextExecutionId: recovery.execution.executionId,
    ...(input.observedWorkspace === undefined
      ? {}
      : { observedWorkspaceRevision: input.observedWorkspace.revision })
  });
  input.runtime.completeResultExecutionInTransaction(input.execution.executionId, input.at);
}

class AgentTurnAdjudicationContinuation implements RuntimeAgentResultContinuation {
  public readonly resultContractId = "agent-turn-adjudication@1";
  readonly #continueAcceptedTurn: RecoveryOptions["continueAcceptedTurn"];
  readonly #runs: AgentRunStore;
  readonly #runtime: RuntimeStore;

  public constructor(options: RecoveryOptions) {
    this.#continueAcceptedTurn = options.continueAcceptedTurn;
    this.#runs = options.runs;
    this.#runtime = options.runtime;
  }

  public handleAgentResult(
    execution: RuntimeExecution,
    result: AgentResultEvent,
    request: AgentRequestEvent,
    at: string
  ): boolean {
    const context = request.runContext;
    if (context?.resultContractId !== this.resultContractId) return false;
    const original = originalAgentTurn(this.#runtime, request);
    let adjudication: AgentTurnAdjudication;
    try {
      if (result.outcome !== "succeeded") {
        throw new Error(result.error ?? "Adjudication provider failed without an error");
      }
      adjudication = parseAgentTurnAdjudication(result.output ?? "");
    } catch (error) {
      this.#settleNeedsHuman(execution, context.runId, context.stepId, errorMessage(error), at);
      return true;
    }
    if (adjudication.decision === "accept") {
      const failure = effectFailure(
        original.request,
        adjudication.normalizedResult
      );
      if (failure !== undefined) {
        this.#settleNeedsHuman(
          execution,
          context.runId,
          context.stepId,
          `acceptance rejected: ${failure}`,
          at
        );
        return true;
      }
      return this.#continueAcceptedTurn(
        execution,
        normalizedTurnResultEvent(original.result, adjudication),
        original.request,
        at
      );
    }
    this.#runtime.withImmediateTransaction(() => {
      const run = this.#runs.requireProjection(context.runId);
      if (run.status === "cancelled") {
        recordRecoveryReceipt(this.#runtime, execution, run.runId, context.stepId, {
          outcome: "ignored_cancelled"
        }, at);
        return;
      }
      if (adjudication.decision === "needs_human") {
        this.#runs.terminalizeInTransaction({
          runId: run.runId,
          expectedVersion: run.version,
          status: "needs_human",
          summary: adjudication.rationale,
          updatedAt: at
        });
        recordRecoveryReceipt(this.#runtime, execution, run.runId, context.stepId, {
          outcome: "needs_human",
          rationale: adjudication.rationale
        }, at);
        return;
      }
      const safetyBlocker = retrySafetyBlocker(original.request, this.#runtime);
      if (safetyBlocker !== undefined) {
        const summary = `Retry rejected by Runtime safety gate: ${safetyBlocker}`;
        this.#runs.terminalizeInTransaction({
          runId: run.runId,
          expectedVersion: run.version,
          status: "needs_human",
          summary,
          updatedAt: at
        });
        recordRecoveryReceipt(this.#runtime, execution, run.runId, context.stepId, {
          outcome: "retry_rejected",
          error: summary,
          rationale: adjudication.rationale,
          safeToRetryEvidence: adjudication.safeToRetryEvidence
        }, at);
        return;
      }
      const retrySessionId = original.result.sessionId ??
        original.request.sessionId ??
        (() => {
          const originalExecution = this.#runtime.executionForEvent(original.request.eventId);
          return originalExecution === undefined
            ? undefined
            : this.#runtime.recoverReadOnlySessionInTransaction(
                originalExecution.executionId,
                at
              )?.sessionId;
        })() ??
        (request.agentId === original.request.agentId ? result.sessionId : undefined);
      const retry = this.#runtime.appendEventInTransaction({
        type: "agent.request",
        source: {
          kind: "handler",
          externalId: `agent-run:${run.runId}:retry:${context.stepId}`
        },
        agentId: original.request.agentId,
        ...(retrySessionId === undefined ? {} : { sessionId: retrySessionId }),
        prompt: agentTurnRetryPrompt({
          originalPrompt: original.request.prompt,
          rationale: adjudication.rationale,
          safeToRetryEvidence: adjudication.safeToRetryEvidence
        }),
        runContext: {
          ...original.request.runContext!,
          resultContractId: "agent-turn-retry-result@1"
        },
        parent: {
          eventId: result.eventId,
          rootEventId: result.causality.rootEventId,
          hop: result.causality.hop
        },
        maxAttempts: 1,
        createdAt: at
      });
      if (retry.status !== "accepted") {
        throw new Error("Agent turn retry Event unexpectedly duplicated");
      }
      this.#runs.advanceInTransaction({
        runId: run.runId,
        expectedVersion: run.version,
        status: original.request.runContext!.completionBinding === undefined
          ? "active"
          : "waiting",
        activeStepId: context.stepId,
        activeExecutionId: retry.execution.executionId,
        stepCount: run.stepCount,
        updatedAt: at
      });
      recordRecoveryReceipt(this.#runtime, execution, run.runId, context.stepId, {
        outcome: "retry_queued",
        rationale: adjudication.rationale,
        safeToRetryEvidence: adjudication.safeToRetryEvidence,
        nextEventId: retry.event.eventId,
        nextExecutionId: retry.execution.executionId
      }, at);
    });
    return true;
  }

  #settleNeedsHuman(
    execution: RuntimeExecution,
    runId: string,
    stepId: string,
    failure: string,
    at: string
  ): void {
    this.#runtime.withImmediateTransaction(() => {
      const run = this.#runs.requireProjection(runId);
      if (run.status === "cancelled") {
        recordRecoveryReceipt(this.#runtime, execution, run.runId, stepId, {
          outcome: "ignored_cancelled"
        }, at);
        return;
      }
      const summary = `Agent turn adjudication failed: ${failure}`.slice(0, 4_096);
      this.#runs.terminalizeInTransaction({
        runId: run.runId,
        expectedVersion: run.version,
        status: "needs_human",
        summary,
        updatedAt: at
      });
      recordRecoveryReceipt(this.#runtime, execution, run.runId, stepId, {
        outcome: "adjudication_failed",
        error: summary
      }, at);
    });
  }
}

class AgentTurnRetryContinuation implements RuntimeAgentResultContinuation {
  public readonly resultContractId = "agent-turn-retry-result@1";
  readonly #continueAcceptedTurn: RecoveryOptions["continueAcceptedTurn"];
  readonly #runs: AgentRunStore;
  readonly #runtime: RuntimeStore;

  public constructor(options: RecoveryOptions) {
    this.#continueAcceptedTurn = options.continueAcceptedTurn;
    this.#runs = options.runs;
    this.#runtime = options.runtime;
  }

  public handleAgentResult(
    execution: RuntimeExecution,
    result: AgentResultEvent,
    request: AgentRequestEvent,
    at: string
  ): boolean {
    const context = request.runContext;
    if (context?.resultContractId !== this.resultContractId) return false;
    let turnResult: AgentTurnResult;
    try {
      if (result.outcome !== "succeeded") {
        throw new Error(result.error ?? "Retry provider failed without an error");
      }
      turnResult = parseAgentTurnResult(result.output ?? "");
      const failure = effectFailure(request, turnResult);
      if (failure !== undefined) throw new Error(failure);
    } catch (error) {
      this.#runtime.withImmediateTransaction(() => {
        const run = this.#runs.requireProjection(context.runId);
        if (run.status === "cancelled") {
          recordRecoveryReceipt(this.#runtime, execution, run.runId, context.stepId, {
            outcome: "ignored_cancelled"
          }, at);
          return;
        }
        const summary = `Agent turn retry failed: ${errorMessage(error)}`.slice(0, 4_096);
        this.#runs.terminalizeInTransaction({
          runId: run.runId,
          expectedVersion: run.version,
          status: "needs_human",
          summary,
          updatedAt: at
        });
        recordRecoveryReceipt(this.#runtime, execution, run.runId, context.stepId, {
          outcome: "retry_failed",
          error: summary
        }, at);
      });
      return true;
    }
    return this.#continueAcceptedTurn(
      execution,
      { ...result, output: JSON.stringify(turnResult) },
      {
        ...request,
        runContext: { ...context, resultContractId: "agent-turn-result@1" }
      },
      at
    );
  }
}

function originalAgentTurn(
  runtime: RuntimeStore,
  adjudicationRequest: AgentRequestEvent
): { readonly request: AgentRequestEvent; readonly result: AgentResultEvent } {
  const originalResult = adjudicationRequest.causality.parentEventId === undefined
    ? undefined
    : runtime.event(adjudicationRequest.causality.parentEventId);
  if (originalResult?.type !== "agent.result") {
    throw new Error("Agent turn adjudication has no original result");
  }
  const originalRequest = originalResult.causality.parentEventId === undefined
    ? undefined
    : runtime.event(originalResult.causality.parentEventId);
  const adjudicationContext = adjudicationRequest.runContext!;
  if (originalRequest?.type !== "agent.request" ||
    originalRequest.runContext?.resultContractId !== "agent-turn-result@1" ||
    originalRequest.runContext.runId !== adjudicationContext.runId ||
    originalRequest.runContext.stepId !== adjudicationContext.stepId ||
    originalResult.causality.rootEventId !== adjudicationRequest.causality.rootEventId) {
    throw new Error("Agent turn adjudication original turn is invalid");
  }
  return { request: originalRequest, result: originalResult };
}

function normalizedTurnResultEvent(
  originalResult: AgentResultEvent,
  adjudication: { readonly normalizedResult: AgentTurnResult }
): AgentResultEvent {
  return {
    eventId: originalResult.eventId,
    type: "agent.result",
    source: originalResult.source,
    agentId: originalResult.agentId,
    ...(originalResult.sessionId === undefined
      ? {}
      : { sessionId: originalResult.sessionId }),
    destinationIds: originalResult.destinationIds,
    causality: originalResult.causality,
    createdAt: originalResult.createdAt,
    outcome: "succeeded",
    output: JSON.stringify(adjudication.normalizedResult)
  };
}

function terminalEvidence(
  result: AgentResultEvent,
  execution: RuntimeExecution | undefined,
  invocation: AgentInvocationDiagnostics | undefined,
  invocationFailure: AgentInvocationFailure | undefined
): Readonly<Record<string, unknown>> {
  const output = result.output ?? "";
  return {
    outcome: result.outcome,
    ...(result.error === undefined ? {} : { error: result.error }),
    outputBytes: Buffer.byteLength(output, "utf8"),
    ...(output === "" ? {} : boundedOutputPreview(output)),
    ...(execution === undefined
      ? {}
      : {
          execution: {
            status: execution.status,
            attemptCount: execution.attemptCount,
            maxAttempts: execution.maxAttempts,
            ...(execution.lastError === undefined ? {} : { lastError: execution.lastError })
          }
        }),
    ...(invocation === undefined
      ? {}
      : {
          invocation: {
            startedAt: invocation.startedAt,
            completedAt: invocation.completedAt,
            durationMilliseconds: invocation.durationMilliseconds,
            ...(invocation.tokenUsage === undefined
              ? {}
              : { tokenUsage: invocation.tokenUsage }),
            ...(invocation.toolUsage === undefined
              ? {}
              : { toolUsage: invocation.toolUsage }),
            ...(invocation.turnCount === undefined
              ? {}
              : { turnCount: invocation.turnCount })
          }
        }),
    ...(invocationFailure === undefined
      ? {}
      : {
          invocationFailure: {
            reason: invocationFailure.reason,
            startedAt: invocationFailure.startedAt,
            failedAt: invocationFailure.failedAt,
            lastMeaningfulAt: invocationFailure.lastMeaningfulAt,
            phase: invocationFailure.phase,
            updateCount: invocationFailure.updateCount,
            meaningfulUpdateCount: invocationFailure.meaningfulUpdateCount,
            ...(invocationFailure.lastProgress === undefined
              ? {}
              : { lastProgress: invocationFailure.lastProgress }),
            totalTimeoutMilliseconds: invocationFailure.totalTimeoutMilliseconds,
            meaningfulOutputTimeoutMilliseconds:
              invocationFailure.meaningfulOutputTimeoutMilliseconds,
            protocolStop: invocationFailure.protocolStop,
            recovery: invocationFailure.recovery,
            providerSessionAvailable: invocationFailure.providerSessionId !== undefined
          }
        })
  };
}

function boundedOutputPreview(output: string): Readonly<Record<string, unknown>> {
  const maximum = 32_768;
  if (Buffer.byteLength(output, "utf8") <= maximum) return { output };
  const bytes = Buffer.from(output, "utf8");
  return {
    outputHead: bytes.subarray(0, 8_192).toString("utf8"),
    outputTail: bytes.subarray(-24_576).toString("utf8"),
    outputTruncated: true
  };
}

function workspaceEvidence(
  baselineRevision: string,
  observed: WorkspaceRevision
): Readonly<Record<string, unknown>> {
  const full = { baselineRevision, observed, unchanged: baselineRevision === observed.revision };
  if (Buffer.byteLength(JSON.stringify(full), "utf8") <= 16_384) return full;
  return {
    baselineRevision,
    observed: {
      schemaVersion: observed.schemaVersion,
      revision: observed.revision,
      repoIdentity: observed.repoIdentity,
      head: observed.head,
      clean: observed.clean,
      ...(observed.trackedDiffHash === undefined
        ? {}
        : { trackedDiffHash: observed.trackedDiffHash }),
      untrackedFileCount: observed.untrackedManifest?.length ?? 0
    },
    unchanged: baselineRevision === observed.revision
  };
}

function retrySafetyBlocker(
  originalRequest: AgentRequestEvent,
  runtime: RuntimeStore
): string | undefined {
  const grant = originalRequest.runContext?.workspaceGrant;
  const failure = runtime.audit(originalRequest.eventId)?.invocationFailure;
  if (failure?.recovery === "unknown_outcome_no_replay") {
    return "the timed-out write-capable turn has an unknown outcome and cannot be replayed";
  }
  if (grant?.networkAccess === true) {
    return "the original turn had external network authority";
  }
  if (grant?.access !== "write") return undefined;
  let observed: WorkspaceRevision;
  try {
    observed = workspaceRevision(grant.root);
  } catch (error) {
    return `workspace revision could not be verified: ${errorMessage(error)}`;
  }
  if (observed.revision !== grant.revision) {
    return "the workspace revision differs from the original request baseline";
  }
  const toolUsage = runtime.audit(originalRequest.eventId)?.invocation?.toolUsage;
  if (toolUsage === undefined) {
    return "write-capable tool usage is unknown";
  }
  const unsafeTool = toolUsage.find((tool) => !isReadOnlyTool(tool.name));
  return unsafeTool === undefined
    ? undefined
    : `the original turn used non-read-only tool ${unsafeTool.name}`;
}

function effectFailure(
  request: AgentRequestEvent,
  result: AgentTurnResult
): string | undefined {
  const grant = request.runContext?.workspaceGrant;
  if (grant === undefined) return undefined;
  let observedRevision: string | undefined;
  try {
    observedRevision = workspaceRevision(grant.root).revision;
  } catch {
    observedRevision = undefined;
  }
  return workspaceEffectFailure(grant, result, observedRevision);
}

function isReadOnlyTool(name: string): boolean {
  return new Set([
    "read",
    "readfile",
    "grep",
    "glob",
    "find",
    "ls",
    "listfiles",
    "search"
  ]).has(name.toLowerCase().replaceAll(/[^a-z]/gu, ""));
}

function recordRecoveryReceipt(
  runtime: RuntimeStore,
  execution: RuntimeExecution,
  runId: string,
  stepId: string,
  detail: Readonly<Record<string, unknown>>,
  at: string
): void {
  runtime.recordExecutionReceiptInTransaction(execution.executionId, {
    schema: "AgentTurnRecoveryReceipt@1",
    runId,
    stepId,
    ...detail
  });
  runtime.completeResultExecutionInTransaction(execution.executionId, at);
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}
