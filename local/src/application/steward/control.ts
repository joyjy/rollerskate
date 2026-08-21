import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { workspaceRevision } from "../../infrastructure/workspace/revision.js";
import {
  runtimeId,
  type ExternalWorkspaceGrant,
  type WorkspaceEffect
} from "../../core/runtime/model.js";
import {
  RuntimeStore,
  type AppendRuntimeEventReceipt
} from "../../core/runtime/store.js";
import {
  inlineMandateSnapshot,
  workflowMandateSnapshot
} from "../../infrastructure/resources/workflow-resource.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { createVikunjaRunResultDestination } from
  "../../integrations/vikunja/task-destination.js";
import {
  newAgentRunId,
  newAgentRunCycleId,
  newAgentStepId,
  isTerminal,
  type AgentRunProjection,
  type RunMandateSnapshot
} from "../../modules/steward/state-machine.js";
import {
  parseRunDecision,
  type AgentRunDecisionReceipt,
  type AnyRunDecision,
  type CallerOrchestratorBinding
} from "../../modules/steward/caller-contract.js";
import {
  callerOrchestratedStepPrompt,
  stewardOrchestratorPrompt,
  stewardTurnPrompt,
  type StewardDelegateTarget
} from "./prompt.js";
import { applyRunDecisionInTransaction } from "./decision.js";

export interface StartStewardRunInput {
  readonly requestId: string;
  readonly series?: {
    readonly key: string;
    readonly sourceRevision: string;
  };
  readonly steward?: string;
  readonly objective?: string;
  readonly workflowRef?: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly workspace?:
    | {
        readonly root: string;
        readonly access: "read";
        readonly networkAccess?: boolean;
      }
    | {
        readonly root: string;
        readonly access: "write";
        readonly effect: WorkspaceEffect;
        readonly networkAccess?: boolean;
      };
  readonly maxSteps?: number;
  readonly maxDepth?: number;
  readonly deadlineAt?: string;
  readonly taskUrl?: string;
  readonly participantAgentIds?: readonly string[];
  readonly orchestration?: {
    readonly mode: "autonomous" | "caller" | "steward";
  };
}

export interface StartStewardRunReceipt {
  readonly status: AppendRuntimeEventReceipt["status"];
  readonly run: AgentRunProjection;
  readonly rootEventId: string;
  readonly executionId: string;
}

export interface CancelStewardRunReceipt {
  readonly run: AgentRunProjection;
  readonly status: "cancelled" | "already_terminal";
  readonly cancelledExecutions: number;
}

export interface CloseStewardRunSeriesReceipt {
  readonly run: AgentRunProjection;
  readonly status: "closed" | "already_terminal";
}

export interface SubmitCallerRunDecisionInput {
  readonly requestId: string;
  readonly decision: AnyRunDecision | Readonly<Record<string, unknown>>;
}

export interface SubmitCallerRunDecisionReceipt {
  readonly status: "accepted" | "duplicate";
  readonly run: AgentRunProjection;
  readonly decision: AgentRunDecisionReceipt;
}

export function startStewardRun(
  repoRoot: string,
  input: StartStewardRunInput,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): StartStewardRunReceipt {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const foundation = new LocalFoundationStore(paths.database);
  let ownerPrincipalId: string;
  let stewardAgentId: string;
  let stewardClient: string;
  let participantAgentIds: readonly string[] | undefined;
  let delegateTargets: readonly StewardDelegateTarget[];
  let participantTargets: readonly StewardDelegateTarget[];
  let orchestratorBinding: CallerOrchestratorBinding | undefined;
  const requestedMode = input.orchestration?.mode ??
    (input.steward === undefined ? "steward" : "autonomous");
  if (input.series !== undefined && requestedMode !== "autonomous") {
    throw new Error("Run series currently requires autonomous orchestration");
  }
  const checkpointDriven = requestedMode !== "autonomous";
  try {
    const local = foundation.foundation();
    if (local === undefined) throw new Error("Local foundation is not initialized");
    ownerPrincipalId = local.owner.principalId;
    const stewardHandle = input.steward ?? "codex";
    if (requestedMode === "steward" && stewardHandle !== "codex") {
      throw new Error("Steward orchestration currently requires the codex handle");
    }
    const steward = foundation.agentByHandle(stewardHandle);
    if (steward === undefined) throw new Error(`Local Agent not found: ${stewardHandle}`);
    if (steward.status !== "active") {
      throw new Error(`Local Agent is not active: ${stewardHandle}`);
    }
    stewardAgentId = steward.principalId;
    stewardClient = steward.client;
    const activeAgents = foundation.listAgents().filter((agent) => agent.status === "active");
    participantAgentIds = input.participantAgentIds === undefined
      ? (checkpointDriven
          ? activeAgents.map((agent) => agent.principalId).sort()
          : undefined)
      : admittedParticipantAgentIds(input.participantAgentIds, stewardAgentId, activeAgents);
    const admitted = participantAgentIds === undefined
      ? activeAgents
      : activeAgents.filter((agent) => participantAgentIds!.includes(agent.principalId));
    participantTargets = admitted.map((agent) => ({
      agentId: agent.principalId,
      handle: agent.handle,
      client: agent.client
    }));
    delegateTargets = checkpointDriven
      ? []
      : admitted
        .filter((agent) => agent.principalId !== steward.principalId)
        .map((agent) => ({
          agentId: agent.principalId,
          handle: agent.handle,
          client: agent.client
        }));
    if (requestedMode === "steward" && steward.client !== "codex") {
      throw new Error("Steward orchestration requires an active Codex Agent");
    }
    if (input.taskUrl !== undefined && requestedMode !== "steward") {
      throw new Error("taskUrl is supported only by Steward orchestration");
    }
    orchestratorBinding = requestedMode === "caller"
      ? {
          schemaVersion: "OrchestratorBinding@1",
          mode: "caller",
          callerRef: {
            kind: "owner",
            principalId: ownerPrincipalId
          },
          decisionContractId: "run-decision@1",
          deliveryPolicy: "manual"
        }
      : requestedMode === "steward"
        ? {
            schemaVersion: "OrchestratorBinding@2",
            mode: "caller",
            callerRef: {
              kind: "owner",
              principalId: ownerPrincipalId
            },
            orchestratorRef: {
              kind: "agent",
              agentId: stewardAgentId
            },
            decisionContractId: "run-decision@2",
            deliveryPolicy: "internal-with-manual-fallback",
            ...(input.taskUrl === undefined
              ? {}
              : {
                  resultDestination: createVikunjaRunResultDestination(
                    runtimeId("dst"),
                    input.taskUrl
                  )
                })
          }
        : undefined;
  } finally {
    foundation.close();
  }

  const baseMandate = mandateSnapshot(input);
  const mandate: RunMandateSnapshot = participantAgentIds === undefined
    ? baseMandate
    : { ...baseMandate, participantAgentIds };
  const workspaceGrant = input.workspace === undefined
    ? undefined
    : externalWorkspaceGrant(input.workspace);
  const maxDepth = input.maxDepth ?? (checkpointDriven ? 0 : 4);
  if (checkpointDriven && maxDepth !== 0) {
    throw new Error("checkpoint-driven orchestration requires maxDepth=0");
  }
  if (workspaceGrant?.networkAccess === true) {
    if (stewardClient !== "codex") {
      throw new Error("workspace.networkAccess requires a Codex Steward");
    }
    if (maxDepth !== 0) {
      throw new Error("workspace.networkAccess requires maxDepth=0");
    }
  }
  const timestamp = iso(at);
  if (input.deadlineAt !== undefined &&
    Date.parse(iso(input.deadlineAt)) <= Date.parse(timestamp)) {
    throw new Error("deadlineAt must be in the future");
  }
  const requestId = text(input.requestId, "requestId", 256);
  const seriesKey = input.series === undefined
    ? undefined
    : text(input.series.key, "series.key", 512);
  const sourceRevision = input.series === undefined
    ? undefined
    : text(input.series.sourceRevision, "series.sourceRevision", 512);
  const rootPrompt = requestedMode === "steward"
    ? stewardOrchestratorPrompt({
        objective: mandate.kind === "objective"
          ? mandate.objective
          : mandate.renderedInstruction,
        runVersion: 1,
        maxSteps: input.maxSteps ?? 20,
        completedWorkerSteps: 0,
        participants: participantTargets,
        ...(workspaceGrant?.effect === undefined
          ? {}
          : { workspaceEffect: workspaceGrant.effect }),
        ...(input.taskUrl === undefined ? {} : { taskUrl: input.taskUrl })
      })
    : requestedMode === "caller"
      ? callerOrchestratedStepPrompt(mandate.renderedInstruction)
      : stewardTurnPrompt(
          mandate.renderedInstruction,
          delegateTargets,
          workspaceGrant?.effect
        );
  const database = openRuntimeDatabase(paths.database);
  const runtime = new RuntimeStore(database);
  const runs = new AgentRunStore(database);
  try {
    return runtime.withImmediateTransaction(() => {
      const existingSeries = seriesKey === undefined
        ? undefined
        : runs.projectionBySeriesKey(seriesKey);
      if (existingSeries !== undefined) {
        if (existingSeries.stewardAgentId !== stewardAgentId ||
          existingSeries.orchestrationMode !== (orchestratorBinding === undefined
            ? "autonomous"
            : "caller")) {
          throw new Error(`Agent Run series admission does not match: ${seriesKey}`);
        }
        if (isTerminal(existingSeries.status)) {
          throw new Error(`Agent Run series is terminal: ${seriesKey}`);
        }
      }
      const runId = existingSeries?.runId ?? newAgentRunId();
      const existingCycle = sourceRevision === undefined || existingSeries === undefined
        ? undefined
        : runs.cycleByRevision(runId, sourceRevision);
      const cycleId = seriesKey === undefined
        ? undefined
        : existingCycle?.cycleId ?? newAgentRunCycleId();
      const rootStepId = newAgentStepId();
      const cycleSession = cycleId === undefined
        ? undefined
        : runtime.sessionForRunAgent(runId, stewardAgentId, cycleId);
      const admission = runtime.appendEventInTransaction({
        type: "agent.request",
        source: {
          kind: "cli",
          externalId: `agent-run:${requestId}`
        },
        agentId: stewardAgentId,
        prompt: rootPrompt,
        ...(cycleSession === undefined ? {} : { sessionId: cycleSession.sessionId }),
        ...(existingSeries === undefined
          ? {}
          : {
              parent: {
                eventId: existingSeries.rootEventId,
                rootEventId: existingSeries.rootEventId,
                hop: 0
              }
            }),
        runContext: {
          schemaVersion: "AgentRunContext@1",
          resultContractId: requestedMode === "steward"
            ? "run-decision@2"
            : requestedMode === "caller"
              ? "agent-step-result@1"
              : "agent-turn-result@1",
          runId,
          ...(cycleId === undefined ? {} : { cycleId }),
          stepId: rootStepId,
          depth: 0,
          ...(workspaceGrant === undefined ? {} : { workspaceGrant })
        },
        maxAttempts: 1,
        createdAt: timestamp
      });
      if (admission.status === "duplicate") {
        const existing = existingSeries ?? runs.projectionByRoot(admission.event.eventId);
        if (existing === undefined) {
          throw new Error(
            `Duplicate Steward Run Event has no run: ${admission.event.eventId}`
          );
        }
        assertDuplicateAdmission(existing, {
          stewardAgentId,
          mandate,
          workspaceGrant,
          orchestratorBinding,
          maxSteps: input.maxSteps ?? 20,
          maxDepth,
          deadlineAt: input.deadlineAt
        });
        return {
          status: "duplicate",
          run: existing,
          rootEventId: admission.event.eventId,
          executionId: admission.execution.executionId
        };
      }
      if (existingSeries !== undefined) {
        if (existingSeries.status !== "awaiting_source") {
          throw new Error(`Agent Run series is not awaiting source: ${seriesKey}`);
        }
        const cycle = existingCycle ?? runs.createCycleInTransaction({
          cycleId: cycleId!,
          runId,
          requestId,
          sourceRevision: sourceRevision!,
          mandate,
          ...(workspaceGrant === undefined ? {} : { workspaceGrant }),
          initialStepCount: requestedMode === "steward" ? 0 : 1,
          createdAt: timestamp
        });
        const run = runs.activateCycleInTransaction({
          runId,
          expectedVersion: existingSeries.version,
          cycleId: cycle.cycleId,
          mandate,
          ...(workspaceGrant === undefined ? {} : { workspaceGrant }),
          rootStepId,
          rootExecutionId: admission.execution.executionId,
          initialStepCount: existingCycle === undefined
            ? (requestedMode === "steward" ? 0 : 1)
            : cycle.stepCount,
          maxSteps: input.maxSteps ?? 20,
          maxDepth,
          ...(input.deadlineAt === undefined
            ? {}
            : { deadlineAt: iso(input.deadlineAt) }),
          updatedAt: timestamp
        });
        return {
          status: "accepted",
          run,
          rootEventId: admission.event.eventId,
          executionId: admission.execution.executionId
        };
      }
      const run = runs.createInTransaction({
        runId,
        rootEventId: admission.event.eventId,
        rootExecutionId: admission.execution.executionId,
        ownerRequestId: requestId,
        ownerPrincipalId,
        stewardAgentId,
        ...(seriesKey === undefined ? {} : { seriesKey, activeCycleId: cycleId! }),
        mandate,
        ...(workspaceGrant === undefined ? {} : { workspaceGrant }),
        ...(orchestratorBinding === undefined ? {} : { orchestratorBinding }),
        rootStepId,
        initialStepCount: requestedMode === "steward" ? 0 : 1,
        maxSteps: input.maxSteps ?? 20,
        maxDepth,
        ...(input.deadlineAt === undefined
          ? {}
          : { deadlineAt: iso(input.deadlineAt) }),
        createdAt: timestamp
      });
      if (cycleId !== undefined) {
        runs.createCycleInTransaction({
          cycleId,
          runId,
          requestId,
          sourceRevision: sourceRevision!,
          mandate,
          ...(workspaceGrant === undefined ? {} : { workspaceGrant }),
          initialStepCount: requestedMode === "steward" ? 0 : 1,
          createdAt: timestamp
        });
      }
      return {
        status: "accepted",
        run,
        rootEventId: admission.event.eventId,
        executionId: admission.execution.executionId
      };
    });
  } finally {
    runs.close();
    runtime.close();
    database.close();
  }
}

export function submitCallerRunDecision(
  repoRoot: string,
  runId: string,
  input: SubmitCallerRunDecisionInput,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): SubmitCallerRunDecisionReceipt {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const decision = parseRunDecision(input.decision);
  const requestId = text(input.requestId, "requestId", 256);
  const timestamp = iso(at);
  const foundation = new LocalFoundationStore(paths.database);
  let ownerPrincipalId: string;
  try {
    const local = foundation.foundation();
    if (local === undefined) throw new Error("Local foundation is not initialized");
    ownerPrincipalId = local.owner.principalId;
  } finally {
    foundation.close();
  }
  const database = openRuntimeDatabase(paths.database);
  const runtime = new RuntimeStore(database);
  const runs = new AgentRunStore(database);
  try {
    return runtime.withImmediateTransaction(() => {
      const replay = runs.decision(runId, requestId);
      if (replay !== undefined) {
        if (JSON.stringify(replay.decision) !== JSON.stringify(decision)) {
          throw new Error("Run decision requestId is already bound to another decision");
        }
        return {
          status: "duplicate",
          run: runs.requireProjection(runId),
          decision: replay.receipt
        };
      }
      const run = runs.requireProjection(runId);
      if (run.orchestratorBinding?.callerRef.principalId !== ownerPrincipalId) {
        throw new Error("RunDecision caller is not the admitted Local Owner");
      }
      return applyRunDecisionInTransaction({
        runtime,
        runs,
        run,
        decision,
        requestId,
        sourceKind: "cli",
        at: timestamp
      });
    });
  } finally {
    runs.close();
    runtime.close();
    database.close();
  }
}

export function cancelStewardRun(
  repoRoot: string,
  runId: string,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): CancelStewardRunReceipt {
  const database = openRuntimeDatabase(runtimePaths(repoRoot, runtimeDirectory).database);
  const runtime = new RuntimeStore(database);
  const runs = new AgentRunStore(database);
  try {
    return runtime.withImmediateTransaction(() => {
      const cancelled = runs.cancelInTransaction(runId, at);
      if (!cancelled.changed) {
        return {
          run: cancelled.run,
          status: "already_terminal",
          cancelledExecutions: 0
        };
      }
      return {
        run: cancelled.run,
        status: "cancelled",
        cancelledExecutions: runtime.cancelQueuedExecutionsForRootInTransaction(
          cancelled.run.rootEventId,
          at
        )
      };
    });
  } finally {
    runs.close();
    runtime.close();
    database.close();
  }
}

export function closeStewardRunSeries(
  repoRoot: string,
  runId: string,
  summary: string,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): CloseStewardRunSeriesReceipt {
  const database = openRuntimeDatabase(runtimePaths(repoRoot, runtimeDirectory).database);
  const runtime = new RuntimeStore(database);
  const runs = new AgentRunStore(database);
  try {
    return runtime.withImmediateTransaction(() => {
      const closed = runs.closeSeriesInTransaction(runId, summary, at);
      return {
        run: closed.run,
        status: closed.changed ? "closed" : "already_terminal"
      };
    });
  } finally {
    runs.close();
    runtime.close();
    database.close();
  }
}

function mandateSnapshot(input: StartStewardRunInput): RunMandateSnapshot {
  const hasObjective = input.objective !== undefined;
  const hasWorkflow = input.workflowRef !== undefined;
  if (hasObjective === hasWorkflow) {
    throw new Error("Run requires exactly one of objective or workflowRef");
  }
  if (hasObjective) {
    if (input.inputs !== undefined) {
      throw new Error("inputs are valid only with workflowRef");
    }
    return inlineMandateSnapshot(input.objective!);
  }
  return workflowMandateSnapshot(input.workflowRef!, input.inputs ?? {});
}

function externalWorkspaceGrant(input: {
  readonly root: string;
  readonly access: "read" | "write";
  readonly effect?: WorkspaceEffect;
  readonly networkAccess?: boolean;
}): ExternalWorkspaceGrant {
  if (!isAbsolute(input.root)) throw new Error("workspace.root must be absolute");
  const root = realpathSync(input.root);
  if (!statSync(root).isDirectory()) throw new Error("workspace.root must be a directory");
  if (input.networkAccess === true && input.access !== "write") {
    throw new Error("workspace.networkAccess requires workspace.access=write");
  }
  if (input.access === "write" && input.effect !== "must_change" &&
    input.effect !== "may_remain_unchanged") {
    throw new Error("workspace.effect is required for write access");
  }
  if (input.access === "read" && input.effect !== undefined) {
    throw new Error("workspace.effect is valid only with write access");
  }
  return {
    schemaVersion: "ExternalWorkspaceGrant@1",
    root,
    access: input.access,
    ...(input.effect === undefined ? {} : { effect: input.effect }),
    ...(input.networkAccess === undefined
      ? {}
      : { networkAccess: input.networkAccess }),
    revision: workspaceRevision(root).revision
  };
}

function text(value: string, field: string, maximum: number): string {
  if (value.trim() === "" || value.length > maximum) {
    throw new Error(`${field} must be non-empty and at most ${maximum} characters`);
  }
  return value;
}

function iso(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("timestamp must be RFC3339");
  return new Date(value).toISOString();
}

function admittedParticipantAgentIds(
  input: readonly string[],
  stewardAgentId: string,
  activeAgents: readonly { readonly principalId: string }[]
): readonly string[] {
  if (input.length === 0 || input.length > 64 || new Set(input).size !== input.length) {
    throw new Error("participantAgentIds must contain 1-64 unique Local Agent ids");
  }
  if (!input.includes(stewardAgentId)) {
    throw new Error("participantAgentIds must include the Steward Agent");
  }
  const activeIds = new Set(activeAgents.map((agent) => agent.principalId));
  for (const agentId of input) {
    text(agentId, "participantAgentId", 256);
    if (!activeIds.has(agentId)) throw new Error(`Run participant is not active: ${agentId}`);
  }
  return [...input].sort();
}

function assertDuplicateAdmission(
  existing: AgentRunProjection,
  expected: {
    readonly stewardAgentId: string;
    readonly mandate: RunMandateSnapshot;
    readonly workspaceGrant: ExternalWorkspaceGrant | undefined;
    readonly maxSteps: number;
    readonly maxDepth: number;
    readonly deadlineAt: string | undefined;
    readonly orchestratorBinding: CallerOrchestratorBinding | undefined;
  }
): void {
  const deadlineAt = expected.deadlineAt === undefined ? undefined : iso(expected.deadlineAt);
  if (existing.stewardAgentId !== expected.stewardAgentId ||
    JSON.stringify(existing.mandate) !== JSON.stringify(expected.mandate) ||
    JSON.stringify(existing.workspaceGrant) !== JSON.stringify(expected.workspaceGrant) ||
    JSON.stringify(comparableBinding(existing.orchestratorBinding)) !==
      JSON.stringify(comparableBinding(expected.orchestratorBinding)) ||
    existing.maxSteps !== expected.maxSteps || existing.maxDepth !== expected.maxDepth ||
    existing.deadlineAt !== deadlineAt) {
    throw new Error("Run requestId is already bound to another exact admission");
  }
}

function comparableBinding(binding: CallerOrchestratorBinding | undefined): unknown {
  if (binding?.schemaVersion !== "OrchestratorBinding@2" ||
    binding.resultDestination === undefined) {
    return binding;
  }
  const { destinationId: _destinationId, ...destination } = binding.resultDestination;
  return { ...binding, resultDestination: destination };
}
