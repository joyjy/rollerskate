import type {
  AgentInputEvent,
  AgentRequestEvent,
  AgentResultEvent,
  ChatDispatchEvent
} from "../../core/event/model.js";
import type {
  RuntimeAgentExecutionGuard,
  RuntimeAgentExecutionGuardDecision,
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
import { vikunjaRunResultDelivery } from
  "../../integrations/vikunja/task-destination.js";
import {
  isStewardOrchestrated,
  latestOrchestratorState,
  parseAgentStepResult,
  parseRunDecision,
  type AgentRunCheckpoint,
  type AgentStepResult,
  type StewardRunDecision
} from "../../modules/steward/caller-contract.js";
import {
  parseAgentTurnResult,
  type AgentTurnMandate,
  type AgentTurnResult
} from "../../modules/steward/result-contract.js";
import { workspaceEffectFailure } from
  "../../modules/steward/workspace-effect.js";
import {
  newAgentStepId,
  planAgentRunContinuation,
  planCallerRunDecision,
  type AgentRunProjection
} from "../../modules/steward/state-machine.js";
import { workspaceRevision } from "../../infrastructure/workspace/revision.js";
import {
  stewardOrchestratorPrompt,
  stewardTurnPrompt
} from "./prompt.js";
import {
  applyRunDecisionInTransaction,
  assertWorkspaceEffectSatisfied
} from "./decision.js";
import { stepMandateSnapshot } from "./control-support.js";
import {
  agentTurnRecoveryContinuations,
  requestAgentTurnAdjudicationInTransaction
} from "./result-recovery.js";

export interface RuntimeApplicationModule {
  readonly moduleId: string;
  readonly resultContinuations: readonly RuntimeAgentResultContinuation[];
  readonly executionGuards: readonly RuntimeAgentExecutionGuard[];
}

export class StewardModule implements
  RuntimeAgentResultContinuation,
  RuntimeAgentExecutionGuard {
  public readonly moduleId = "steward";
  public readonly resultContractId = "agent-turn-result@1";
  readonly #runs: AgentRunStore;
  readonly #runtime: RuntimeStore;
  readonly #recoveryContinuations: readonly RuntimeAgentResultContinuation[];
  readonly #callerContinuation: CallerAgentStepContinuation;
  readonly #orchestratorContinuation: StewardDecisionContinuation;

  public constructor(options: {
    readonly runs: AgentRunStore;
    readonly runtime: RuntimeStore;
  }) {
    this.#runs = options.runs;
    this.#runtime = options.runtime;
    this.#recoveryContinuations = agentTurnRecoveryContinuations({
      ...options,
      continueAcceptedTurn: (execution, result, request, at) =>
        this.handleAgentResult(execution, result, request, at)
    });
    this.#callerContinuation = new CallerAgentStepContinuation(options);
    this.#orchestratorContinuation = new StewardDecisionContinuation(options);
  }

  public manifest(): RuntimeApplicationModule {
    return {
      moduleId: this.moduleId,
      resultContinuations: [
        this,
        ...this.#recoveryContinuations,
        this.#callerContinuation,
        this.#orchestratorContinuation
      ],
      executionGuards: [this]
    };
  }

  public canInvoke(
    event: AgentInputEvent | ChatDispatchEvent,
    _at: string
  ): RuntimeAgentExecutionGuardDecision {
    if (event.type !== "agent.request" || event.runContext === undefined ||
      this.#runs.isContinuable(event.runContext.runId)) {
      return { outcome: "allow" };
    }
    return { outcome: "skip", reason: "agent_run_cancelled" };
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
      const observedWorkspace = run.workspaceGrant === undefined
        ? undefined
        : workspaceRevision(run.workspaceGrant.root);
      const observedWorkspaceRevision = observedWorkspace?.revision;
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
        if (result.outcome !== "succeeded") {
          throw new Error(result.error ?? "Agent provider failed without an error");
        }
        turnResult = parseAgentTurnResult(result.output ?? "");
        const completionFailure = workspaceEffectFailure(
          run.workspaceGrant,
          turnResult,
          observedWorkspaceRevision
        );
        if (completionFailure !== undefined) throw new Error(completionFailure);
      } catch (error) {
        requestAgentTurnAdjudicationInTransaction({
          runs: this.#runs,
          runtime: this.#runtime,
          execution,
          result,
          request,
          run,
          contractError: errorMessage(error),
          ...(observedWorkspace === undefined ? {} : { observedWorkspace }),
          at
        });
        return;
      }
      const plan = planAgentRunContinuation({
        run,
        context,
        result: turnResult,
        now: at
      });
      if (plan.kind === "ignore_cancelled") {
        throw new Error("Steward Run cancellation changed inside one immediate transaction");
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
          throw new Error("Steward Run delegate plan requires delegate result");
        }
        if (turnResult.targetAgentId === request.agentId) {
          throw new Error("Steward Run child must be a different Agent");
        }
        if (run.mandate.participantAgentIds !== undefined &&
          !run.mandate.participantAgentIds.includes(turnResult.targetAgentId)) {
          throw new Error("Steward Run delegate is outside the admitted participant roster");
        }
        if (result.sessionId === undefined) {
          throw new Error("Steward Run delegate requires a caller Session");
        }
        this.#runs.requireActiveAgent(turnResult.targetAgentId);
        const callerSession = this.#runtime.session(result.sessionId);
        if (callerSession?.runId !== run.runId ||
          callerSession.agentId !== request.agentId) {
          throw new Error("Steward Run caller Session does not match the current Run");
        }
        const childStepId = newAgentStepId();
        const childMandate = snapshot(turnResult.mandate);
        const childSession = this.#runtime.sessionForRunAgent(
          run.runId,
          turnResult.targetAgentId,
          run.activeCycleId
        );
        const admission = this.#runtime.appendEventInTransaction({
          type: "agent.request",
          source: {
            kind: "handler",
            externalId: `agent-run:${run.runId}:delegate:${context.stepId}`
          },
          agentId: turnResult.targetAgentId,
          prompt: stewardTurnPrompt(
            childMandate.renderedInstruction,
            this.#runs.activeDelegateTargets(
              turnResult.targetAgentId,
              run.mandate.participantAgentIds
            ),
            run.workspaceGrant?.effect
          ),
          ...(childSession === undefined ? {} : { sessionId: childSession.sessionId }),
          runContext: {
            schemaVersion: "AgentRunContext@1",
            resultContractId: "agent-turn-result@1",
            runId: run.runId,
            ...(run.activeCycleId === undefined ? {} : { cycleId: run.activeCycleId }),
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
          maxAttempts: 1,
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
        throw new Error("Steward Run callback plan requires a completion binding");
      }
      const callerRequest = this.#runtime.event(binding.callerRequestEventId);
      if (callerRequest?.type !== "agent.request" ||
        callerRequest.agentId !== binding.callerAgentId ||
        callerRequest.runContext?.runId !== run.runId ||
        callerRequest.runContext.stepId !== binding.callerStepId) {
        throw new Error("Steward Run completion binding does not match caller request");
      }
      const callerSession = this.#runtime.session(binding.callerSessionId);
      if (callerSession?.runId !== run.runId ||
        callerSession.agentId !== binding.callerAgentId) {
        throw new Error("Steward Run completion binding Session is invalid");
      }
      const callbackStepId = newAgentStepId();
      const childExecution = this.#runtime.executionForEvent(request.eventId);
      if (childExecution === undefined) {
        throw new Error("Steward Run child request Execution is missing");
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
        prompt: stewardTurnPrompt(
          callbackPrompt(completion),
          this.#runs.activeDelegateTargets(
            binding.callerAgentId,
            run.mandate.participantAgentIds
          ),
          run.workspaceGrant?.effect
        ),
          runContext: {
            schemaVersion: "AgentRunContext@1",
            resultContractId: "agent-turn-result@1",
            runId: run.runId,
            ...(context.cycleId === undefined ? {} : { cycleId: context.cycleId }),
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
        maxAttempts: 1,
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

class CallerAgentStepContinuation implements RuntimeAgentResultContinuation {
  public readonly resultContractId = "agent-step-result@1";
  readonly #runs: AgentRunStore;
  readonly #runtime: RuntimeStore;

  public constructor(options: {
    readonly runs: AgentRunStore;
    readonly runtime: RuntimeStore;
  }) {
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
    this.#runtime.withImmediateTransaction(() => {
      const run = this.#runs.requireProjection(context.runId);
      const observedWorkspaceRevision = run.workspaceGrant === undefined
        ? undefined
        : workspaceRevision(run.workspaceGrant.root).revision;
      if (run.status === "cancelled") {
        this.#runtime.recordExecutionReceiptInTransaction(execution.executionId, {
          schema: "AgentRunCheckpointReceipt@1",
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
      if (run.orchestrationMode !== "caller") {
        throw new Error("AgentStepResult@1 requires a caller-orchestrated Run");
      }
      if (run.deadlineAt !== undefined && Date.parse(at) >= Date.parse(run.deadlineAt)) {
        this.#runs.terminalizeInTransaction({
          runId: run.runId,
          expectedVersion: run.version,
          status: "failed",
          summary: "Agent Run deadline exhausted",
          updatedAt: at
        });
        this.#runtime.recordExecutionReceiptInTransaction(execution.executionId, {
          schema: "AgentRunCheckpointReceipt@1",
          runId: run.runId,
          stepId: context.stepId,
          outcome: "deadline_exhausted",
          ...(observedWorkspaceRevision === undefined
            ? {}
            : { observedWorkspaceRevision })
        });
        this.#runtime.completeResultExecutionInTransaction(execution.executionId, at);
        return;
      }
      const stepResult = callerStepResult(result);
      const agentExecution = this.#runtime.executionForEvent(request.eventId);
      if (agentExecution === undefined) {
        throw new Error("Caller-orchestrated Worker Execution is missing");
      }
      const checkpoint: AgentRunCheckpoint = {
        schemaVersion: "AgentRunCheckpoint@1",
        stepId: context.stepId,
        agentId: request.agentId,
        requestEventId: request.eventId,
        resultEventId: result.eventId,
        executionId: agentExecution.executionId,
        result: stepResult,
        ...(observedWorkspaceRevision === undefined
          ? {}
          : { observedWorkspaceRevision }),
        recordedAt: at
      };
      const checkpointed = this.#runs.checkpointInTransaction({
        runId: run.runId,
        expectedVersion: run.version,
        expectedStepId: context.stepId,
        expectedExecutionId: agentExecution.executionId,
        checkpoint,
        updatedAt: at
      });
      let orchestratorEventId: string | undefined;
      let orchestratorExecutionId: string | undefined;
      if (isStewardOrchestrated(checkpointed.orchestratorBinding)) {
        const participantIds = checkpointed.mandate.participantAgentIds;
        if (participantIds === undefined) {
          throw new Error("Steward orchestration requires a fixed participant roster");
        }
        const binding = checkpointed.orchestratorBinding;
        const resultDelivery = binding.resultDestination === undefined
          ? undefined
          : vikunjaRunResultDelivery(binding.resultDestination);
        const session = this.#runtime.sessionForRunAgent(
          checkpointed.runId,
          binding.orchestratorRef.agentId,
          checkpointed.activeCycleId
        );
        const orchestrationStepId = newAgentStepId();
        const priorState = latestOrchestratorState(
          this.#runs.decisions(checkpointed.runId)
        );
        const orchestration = this.#runtime.appendEventInTransaction({
          type: "agent.request",
          source: {
            kind: "handler",
            externalId: `agent-run:${checkpointed.runId}:orchestrate:${checkpoint.stepId}`
          },
          agentId: binding.orchestratorRef.agentId,
          ...(session === undefined ? {} : { sessionId: session.sessionId }),
          prompt: stewardOrchestratorPrompt({
            objective: checkpointed.mandate.kind === "objective"
              ? checkpointed.mandate.objective
              : checkpointed.mandate.renderedInstruction,
            runVersion: checkpointed.version,
            maxSteps: checkpointed.maxSteps,
            completedWorkerSteps: checkpointed.stepCount,
            checkpoint,
            ...(priorState === undefined ? {} : { priorState }),
            participants: this.#runs.activeParticipantTargets(participantIds),
            ...(checkpointed.workspaceGrant?.effect === undefined
              ? {}
              : { workspaceEffect: checkpointed.workspaceGrant.effect }),
            ...(resultDelivery === undefined
              ? {}
              : { taskUrl: resultDelivery.taskUrl })
          }),
          runContext: {
            schemaVersion: "AgentRunContext@1",
            resultContractId: "run-decision@2",
            runId: checkpointed.runId,
            ...(checkpointed.activeCycleId === undefined
              ? {}
              : { cycleId: checkpointed.activeCycleId }),
            stepId: orchestrationStepId,
            parentStepId: checkpoint.stepId,
            depth: 0,
            ...(checkpointed.workspaceGrant === undefined
              ? {}
              : { workspaceGrant: checkpointed.workspaceGrant })
          },
          parent: {
            eventId: result.eventId,
            rootEventId: result.causality.rootEventId,
            hop: result.causality.hop
          },
          maxAttempts: 1,
          createdAt: at
        });
        if (orchestration.status !== "accepted") {
          throw new Error("Steward orchestration Event unexpectedly duplicated");
        }
        orchestratorEventId = orchestration.event.eventId;
        orchestratorExecutionId = orchestration.execution.executionId;
      }
      this.#runtime.recordExecutionReceiptInTransaction(execution.executionId, {
        schema: "AgentRunCheckpointReceipt@1",
        runId: run.runId,
        stepId: context.stepId,
        outcome: orchestratorEventId === undefined
          ? "checkpointed"
          : "checkpointed_and_orchestrator_queued",
        runVersion: checkpointed.version,
        stepOutcome: stepResult.outcome,
        ...(orchestratorEventId === undefined
          ? {}
          : { orchestratorEventId, orchestratorExecutionId }),
        ...(observedWorkspaceRevision === undefined
          ? {}
          : { observedWorkspaceRevision })
      });
      this.#runtime.completeResultExecutionInTransaction(execution.executionId, at);
    });
    return true;
  }
}

class StewardDecisionContinuation implements RuntimeAgentResultContinuation {
  public readonly resultContractId = "run-decision@2";
  readonly #runs: AgentRunStore;
  readonly #runtime: RuntimeStore;

  public constructor(options: {
    readonly runs: AgentRunStore;
    readonly runtime: RuntimeStore;
  }) {
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
    this.#runtime.withImmediateTransaction(() => {
      const run = this.#runs.requireProjection(context.runId);
      const binding = run.orchestratorBinding;
      if (!isStewardOrchestrated(binding) ||
        request.agentId !== binding.orchestratorRef.agentId) {
        throw new Error("RunDecision@2 producer is not the admitted Steward Orchestrator");
      }
      const initialDecision = run.status === "active" && run.stepCount === 0 &&
        run.checkpoint === undefined &&
        run.activeStepId === context.stepId && request.eventId === run.rootEventId;
      const checkpointDecision = run.status === "awaiting_orchestrator" &&
        run.checkpoint !== undefined && context.parentStepId === run.checkpoint.stepId;
      if (!initialDecision && !checkpointDecision) {
        this.#runtime.recordExecutionReceiptInTransaction(execution.executionId, {
          schema: "StewardOrchestratorDecisionReceipt@1",
          runId: run.runId,
          stepId: context.stepId,
          outcome: "ignored_stale"
        });
        this.#runtime.completeResultExecutionInTransaction(execution.executionId, at);
        return;
      }
      if (result.outcome !== "succeeded") {
        this.#recordRejected(
          execution,
          run.runId,
          context.stepId,
          `Steward Orchestrator failed: ${result.error ?? "provider failure"}`,
          at,
          initialDecision ? run : undefined
        );
        return;
      }
      let decision: StewardRunDecision;
      try {
        const parsed = parseRunDecision(JSON.parse(result.output ?? "") as unknown);
        if (parsed.schemaVersion !== "RunDecision@2") {
          throw new Error("Steward Orchestrator must return RunDecision@2");
        }
        decision = parsed;
      } catch (error) {
        this.#recordRejected(
          execution,
          run.runId,
          context.stepId,
          `Invalid RunDecision@2: ${errorMessage(error)}`,
          at,
          initialDecision ? run : undefined
        );
        return;
      }
      const sourceStepId = run.checkpoint?.stepId ?? context.stepId;
      const requestId = `orchestrator:${sourceStepId}`;
      try {
        const plan = planCallerRunDecision({ run, decision, now: at });
        assertWorkspaceEffectSatisfied(run, plan);
        if (plan.kind === "next_step") {
          this.#runs.requireActiveAgent(plan.targetAgentId);
          if (decision.action !== "next_step") {
            throw new Error("Steward next-step plan requires a next_step decision");
          }
          stepMandateSnapshot(decision.nextStep.mandate);
        }
      } catch (error) {
        this.#recordRejected(
          execution,
          run.runId,
          context.stepId,
          `RunDecision@2 rejected: ${errorMessage(error)}`,
          at,
          initialDecision ? run : undefined
        );
        return;
      }
      const applied = applyRunDecisionInTransaction({
        runtime: this.#runtime,
        runs: this.#runs,
        run,
        decision,
        requestId,
        sourceKind: "handler",
        parentResult: result,
        at
      });
      this.#runtime.recordExecutionReceiptInTransaction(execution.executionId, {
        schema: "StewardOrchestratorDecisionReceipt@1",
        runId: run.runId,
        stepId: context.stepId,
        outcome: "accepted",
        decision: applied.decision
      });
      this.#runtime.completeResultExecutionInTransaction(execution.executionId, at);
    });
    return true;
  }

  #recordRejected(
    execution: RuntimeExecution,
    runId: string,
    stepId: string,
    error: string,
    at: string,
    initialRun?: AgentRunProjection
  ): void {
    if (initialRun !== undefined) {
      const activeExecutionId = initialRun.activeExecutionId;
      if (activeExecutionId === undefined) {
        throw new Error("Initial Steward Orchestrator Execution is missing");
      }
      this.#runs.awaitInitialStewardDecisionInTransaction({
        runId: initialRun.runId,
        expectedVersion: initialRun.version,
        expectedStepId: stepId,
        expectedExecutionId: activeExecutionId,
        updatedAt: at
      });
    }
    this.#runtime.recordExecutionReceiptInTransaction(execution.executionId, {
      schema: "StewardOrchestratorDecisionReceipt@1",
      runId,
      stepId,
      outcome: "rejected_manual_fallback",
      error: error.slice(0, 4_096)
    });
    this.#runtime.completeResultExecutionInTransaction(execution.executionId, at);
  }
}

function callerStepResult(result: AgentResultEvent): AgentStepResult {
  if (result.outcome !== "succeeded") {
    return {
      schemaVersion: "AgentStepResult@1",
      outcome: "failed",
      summary: result.error ?? "Agent provider failed without an error",
      artifactRefs: []
    };
  }
  try {
    return parseAgentStepResult(result.output ?? "");
  } catch (error) {
    return {
      schemaVersion: "AgentStepResult@1",
      outcome: "failed",
      summary: `Invalid AgentStepResult@1: ${errorMessage(error)}`.slice(0, 4_096),
      artifactRefs: []
    };
  }
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
    "Continue the same Steward Run in this resumed Session.",
    "Complete the objective or delegate exactly one next child.",
    "",
    "AgentStepCompletion@1:",
    JSON.stringify(completion, null, 2)
  ].join("\n");
}
