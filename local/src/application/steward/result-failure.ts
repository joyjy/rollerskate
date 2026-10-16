import type { RuntimeAgentResultContinuation } from "../../core/runtime/handlers.js";
import type { RuntimeStore } from "../../core/runtime/store.js";
import type { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { enqueueTerminalRunDelivery } from "./result-destination.js";
import { isTerminal, type AgentRunProjection } from "../../modules/steward/state-machine.js";

/** Steward owns its Run failure; core still owns the failed Execution and retry budget. */
export function guardStewardResultContinuation(continuation: RuntimeAgentResultContinuation,
  runs: AgentRunStore, runtime: RuntimeStore): RuntimeAgentResultContinuation {
  return {resultContractId: continuation.resultContractId,
    handleAgentResult(execution, result, request, at) {
      try { return continuation.handleAgentResult(execution, result, request, at); }
      catch (error) {
        if (execution.attemptCount >= execution.maxAttempts && request.runContext) {
          const context = request.runContext;
          let terminal: {readonly run: AgentRunProjection; readonly summary: string} | undefined;
          runtime.withImmediateTransaction(() => {
            const run = runs.requireProjection(context.runId);
            if (isTerminal(run.status) || run.activeCycleId !== context.cycleId) return;
            const summary = `Result processing exhausted for ${execution.executionId}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 4096);
            runs.terminalizeInTransaction({runId: run.runId, expectedVersion: run.version, status: "failed", summary, updatedAt: at});
            terminal = {run, summary};
            runtime.cancelQueuedExecutionsForRootInTransaction(run.rootEventId, at);
            runtime.recordExecutionReceiptInTransaction(execution.executionId, {
              schema: "StewardResultProcessingFailure@1", runId: run.runId, stepId: context.stepId,
              requestEventId: request.eventId, resultEventId: result.eventId, error: summary
            });
          });
          if (terminal) {
            const failed = terminal;
            try {
              runtime.withImmediateTransaction(() => enqueueTerminalRunDelivery(runtime, failed.run, "failed", failed.summary, at));
            } catch (deliveryError) {
              // Outbox compilation must not roll back the already committed failure state.
              runtime.withImmediateTransaction(() => runtime.recordExecutionReceiptInTransaction(execution.executionId, {
                schema: "StewardResultProcessingFailure@1", runId: failed.run.runId, stepId: context.stepId,
                requestEventId: request.eventId, resultEventId: result.eventId, error: failed.summary,
                terminalDeliveryError: (deliveryError instanceof Error ? deliveryError.message : String(deliveryError)).slice(0, 4096)
              }));
            }
          }
        }
        throw error;
      }
    }
  };
}
