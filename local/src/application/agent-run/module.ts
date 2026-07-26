import type {
  AgentRequestEvent,
  AgentResultEvent
} from "../../core/event/model.js";
import type {
  RuntimeAgentExecutionGuard,
  RuntimeAgentResultContinuation
} from "../../core/runtime/handlers.js";
import type {
  AgentStepCompletion,
  RuntimeExecution
} from "../../core/runtime/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import {
  inlineMandateSnapshot,
  workflowMandateSnapshot
} from "../../infrastructure/resources/workflow-resource.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import {
  parseAgentTurnResult,
  type AgentTurnMandate,
  type AgentTurnResult
} from "../../modules/agent-run/result-contract.js";
import {
  newAgentStepId,
  planAgentRunContinuation
} from "../../modules/agent-run/state-machine.js";
import { workspaceRevision } from "../../infrastructure/workspace/revision.js";
import { agentRunTurnPrompt } from "./prompt.js";

export interface RuntimeApplicationModule {
  readonly moduleId: string;
  readonly resultContinuations: readonly RuntimeAgentResultContinuation[];
  readonly executionGuards: readonly RuntimeAgentExecutionGuard[];
}

export class AgentRunModule implements
  RuntimeAgentResultContinuation,
  RuntimeAgentExecutionGuard {
  public readonly moduleId = "agent-run";
  public readonly resultContractId = "agent-turn-result@1";
  readonly #runs: AgentRunStore;
  readonly #runtime: RuntimeStore;

  public constructor(options: {
    readonly runs: AgentRunStore;
    readonly runtime: RuntimeStore;
  }) {
    this.#runs = options.runs;
    this.#runtime = options.runtime;
  }

  public manifest(): RuntimeApplicationModule {
    return {
      moduleId: this.moduleId,
      resultContinuations: [this],
      executionGuards: [this]
    };
  }

  public canInvoke(event: AgentRequestEvent): boolean {
    return event.runContext === undefined ||
      this.#runs.isContinuable(event.runContext.runId);
  }

  public handleAgentResult(
    execution: RuntimeExecution,
    result: AgentResultEvent,
    request: AgentRequestEvent,
    at: string
  ): boolean {
    const context = request.runContext;
    if (context?.resultContractId !== this.resultContractId) return false;
    this.#runtime.withImmediateTransaction(() => {
      const run = this.#runs.requireProjection(context.runId);
      const observedWorkspaceRevision = run.workspaceGrant === undefined
        ? undefined
        : workspaceRevision(run.workspaceGrant.root).revision;
      if (run.status === "cancelled") {
        this.#runtime.recordExecutionReceiptInTransaction(execution.executionId, {
          schema: "AgentRunContinuationReceipt@1",
          runId: run.runId,
          stepId: context.stepId,
          outcome: "ignored_cancelled",
          ...(observedWorkspaceRevision === undefined
            ? {}
            : { observedWorkspaceRevision })
        });
        this.#runtime.completeResultExecutionInTransaction(execution.executionId, at);
        return;
      }
      let turnResult: AgentTurnResult;
      try {
        turnResult = result.outcome === "succeeded"
          ? parseAgentTurnResult(result.output ?? "")
          : failedTurnResult(result);
      } catch (error) {
        const failure = errorMessage(error);
        this.#runs.terminalizeInTransaction({
          runId: run.runId,
          expectedVersion: run.version,
          status: "failed",
          summary: failure,
          updatedAt: at
        });
        this.#runtime.recordExecutionReceiptInTransaction(execution.executionId, {
          schema: "AgentRunContinuationReceipt@1",
          runId: run.runId,
          stepId: context.stepId,
          outcome: "invalid_result",
          error: failure,
          ...(observedWorkspaceRevision === undefined
            ? {}
            : { observedWorkspaceRevision })
        });
        this.#runtime.completeResultExecutionInTransaction(execution.executionId, at);
        return;
      }
      const plan = planAgentRunContinuation({
        run,
        context,
        result: turnResult,
        now: at
      });
      if (plan.kind === "ignore_cancelled") {
        throw new Error("Agent Run cancellation changed inside one immediate transaction");
      }
      if (plan.kind === "terminal") {
        this.#runs.terminalizeInTransaction({
          runId: run.runId,
          expectedVersion: run.version,
          status: plan.status,
          summary: plan.summary,
          updatedAt: at
        });
        this.#runtime.recordExecutionReceiptInTransaction(execution.executionId, {
          schema: "AgentRunContinuationReceipt@1",
          runId: run.runId,
          stepId: context.stepId,
          outcome: "terminal",
          status: plan.status,
          ...(observedWorkspaceRevision === undefined
            ? {}
            : { observedWorkspaceRevision })
        });
        this.#runtime.completeResultExecutionInTransaction(execution.executionId, at);
        return;
      }
      if (plan.kind === "delegate") {
        if (turnResult.action !== "delegate") {
          throw new Error("Agent Run delegate plan requires delegate result");
        }
        if (turnResult.targetAgentId === request.agentId) {
          throw new Error("Agent Run child must be a different Agent");
        }
        if (result.sessionId === undefined) {
          throw new Error("Agent Run delegate requires a caller Session");
        }
        this.#runs.requireActiveAgent(turnResult.targetAgentId);
        const callerSession = this.#runtime.session(result.sessionId);
        if (callerSession?.runId !== run.runId ||
          callerSession.agentId !== request.agentId) {
          throw new Error("Agent Run caller Session does not match the current Run");
        }
        const childStepId = newAgentStepId();
        const childMandate = snapshot(turnResult.mandate);
        const childSession = this.#runtime.sessionForRunAgent(
          run.runId,
          turnResult.targetAgentId
        );
        const admission = this.#runtime.appendEventInTransaction({
          type: "agent.request",
          source: {
            kind: "handler",
            externalId: `agent-run:${run.runId}:delegate:${context.stepId}`
          },
          agentId: turnResult.targetAgentId,
          prompt: agentRunTurnPrompt(
            childMandate.renderedInstruction,
            this.#runs.activeDelegateTargets(turnResult.targetAgentId)
          ),
          ...(childSession === undefined ? {} : { sessionId: childSession.sessionId }),
          runContext: {
            schemaVersion: "AgentRunContext@1",
            resultContractId: "agent-turn-result@1",
            runId: run.runId,
            stepId: childStepId,
            parentStepId: context.stepId,
            depth: context.depth + 1,
            ...(run.workspaceGrant === undefined
              ? {}
              : { workspaceGrant: run.workspaceGrant }),
            completionBinding: {
              schemaVersion: "AgentCompletionBinding@1",
              callerAgentId: request.agentId,
              callerSessionId: result.sessionId,
              callerStepId: context.stepId,
              callerRequestEventId: request.eventId
            }
          },
          parent: {
            eventId: result.eventId,
            rootEventId: result.causality.rootEventId,
            hop: result.causality.hop
          },
          createdAt: at
        });
        this.#runs.advanceInTransaction({
          runId: run.runId,
          expectedVersion: run.version,
          status: plan.nextStatus,
          activeStepId: childStepId,
          activeExecutionId: admission.execution.executionId,
          stepCount: plan.nextStepCount,
          updatedAt: at
        });
        this.#runtime.recordExecutionReceiptInTransaction(execution.executionId, {
          schema: "AgentRunContinuationReceipt@1",
          runId: run.runId,
          stepId: context.stepId,
          outcome: "delegated",
          nextEventId: admission.event.eventId,
          nextExecutionId: admission.execution.executionId,
          ...(observedWorkspaceRevision === undefined
            ? {}
            : { observedWorkspaceRevision })
        });
        this.#runtime.completeResultExecutionInTransaction(execution.executionId, at);
        return;
      }
      const binding = context.completionBinding;
      if (binding === undefined) {
        throw new Error("Agent Run callback plan requires a completion binding");
      }
      const callerRequest = this.#runtime.event(binding.callerRequestEventId);
      if (callerRequest?.type !== "agent.request" ||
        callerRequest.agentId !== binding.callerAgentId ||
        callerRequest.runContext?.runId !== run.runId ||
        callerRequest.runContext.stepId !== binding.callerStepId) {
        throw new Error("Agent Run completion binding does not match caller request");
      }
      const callerSession = this.#runtime.session(binding.callerSessionId);
      if (callerSession?.runId !== run.runId ||
        callerSession.agentId !== binding.callerAgentId) {
        throw new Error("Agent Run completion binding Session is invalid");
      }
      const callbackStepId = newAgentStepId();
      const childExecution = this.#runtime.executionForEvent(request.eventId);
      if (childExecution === undefined) {
        throw new Error("Agent Run child request Execution is missing");
      }
      const completion = stepCompletion(
        childExecution.executionId,
        request,
        result,
        turnResult,
        observedWorkspaceRevision
      );
      const callback = this.#runtime.appendEventInTransaction({
        type: "agent.request",
        source: {
          kind: "handler",
          externalId: `agent-run:${run.runId}:callback:${context.stepId}`
        },
        agentId: binding.callerAgentId,
        sessionId: binding.callerSessionId,
        prompt: agentRunTurnPrompt(
          callbackPrompt(completion),
          this.#runs.activeDelegateTargets(binding.callerAgentId)
        ),
        runContext: {
          schemaVersion: "AgentRunContext@1",
          resultContractId: "agent-turn-result@1",
          runId: run.runId,
          stepId: callbackStepId,
          parentStepId: context.stepId,
          depth: callerRequest.runContext.depth,
          ...(run.workspaceGrant === undefined
            ? {}
            : { workspaceGrant: run.workspaceGrant }),
          ...(callerRequest.runContext.completionBinding === undefined
            ? {}
            : {
                completionBinding: callerRequest.runContext.completionBinding
              }),
          stepCompletion: completion
        },
        parent: {
          eventId: result.eventId,
          rootEventId: result.causality.rootEventId,
          hop: result.causality.hop
        },
        createdAt: at
      });
      this.#runs.advanceInTransaction({
        runId: run.runId,
        expectedVersion: run.version,
        status: plan.nextStatus,
        activeStepId: callbackStepId,
        activeExecutionId: callback.execution.executionId,
        stepCount: plan.nextStepCount,
        updatedAt: at
      });
      this.#runtime.recordExecutionReceiptInTransaction(execution.executionId, {
        schema: "AgentRunContinuationReceipt@1",
        runId: run.runId,
        stepId: context.stepId,
        outcome: "callback",
        nextEventId: callback.event.eventId,
        nextExecutionId: callback.execution.executionId,
        ...(observedWorkspaceRevision === undefined
          ? {}
          : { observedWorkspaceRevision })
      });
      this.#runtime.completeResultExecutionInTransaction(execution.executionId, at);
    });
    return true;
  }
}

function failedTurnResult(result: AgentResultEvent): AgentTurnResult {
  return {
    schemaVersion: "AgentTurnResult@1",
    action: "complete",
    outcome: "failed",
    summary: result.error ?? "Agent provider failed without an error",
    artifactRefs: []
  };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}

function snapshot(mandate: AgentTurnMandate) {
  return mandate.kind === "objective"
    ? inlineMandateSnapshot(mandate.objective)
    : workflowMandateSnapshot(mandate.workflowRef, mandate.inputs);
}

function stepCompletion(
  childExecutionId: string,
  request: AgentRequestEvent,
  result: AgentResultEvent,
  turnResult: AgentTurnResult,
  observedWorkspaceRevision: string | undefined
): AgentStepCompletion {
  const outcome = turnResult.action === "complete"
    ? turnResult.outcome
    : "failed";
  return {
    schemaVersion: "AgentStepCompletion@1",
    childAgentId: request.agentId,
    childStepId: request.runContext!.stepId,
    childRequestEventId: request.eventId,
    childResultEventId: result.eventId,
    childExecutionId,
    outcome,
    summary: turnResult.summary,
    artifactRefs: turnResult.artifactRefs,
    ...(observedWorkspaceRevision === undefined
      ? {}
      : { observedWorkspaceRevision })
  };
}

function callbackPrompt(completion: AgentStepCompletion): string {
  return [
    "The delegated child step reached a terminal result.",
    "Continue the same Agent Run in this resumed Session.",
    "Complete the objective or delegate exactly one next child.",
    "",
    "AgentStepCompletion@1:",
    JSON.stringify(completion, null, 2)
  ].join("\n");
}
