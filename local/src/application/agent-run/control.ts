import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { workspaceRevision } from "../../infrastructure/workspace/revision.js";
import type { ExternalWorkspaceGrant } from "../../core/runtime/model.js";
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
import {
  newAgentRunId,
  newAgentStepId,
  type AgentRunProjection,
  type RunMandateSnapshot
} from "../../modules/agent-run/state-machine.js";
import { agentRunTurnPrompt, type AgentRunDelegateTarget } from "./prompt.js";

export interface StartAgentRunInput {
  readonly requestId: string;
  readonly steward: string;
  readonly objective?: string;
  readonly workflowRef?: string;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly workspace?: {
    readonly root: string;
    readonly access: "read" | "write";
  };
  readonly maxSteps?: number;
  readonly maxDepth?: number;
  readonly deadlineAt?: string;
}

export interface StartAgentRunReceipt {
  readonly status: AppendRuntimeEventReceipt["status"];
  readonly run: AgentRunProjection;
  readonly rootEventId: string;
  readonly executionId: string;
}

export interface CancelAgentRunReceipt {
  readonly run: AgentRunProjection;
  readonly status: "cancelled" | "already_terminal";
  readonly cancelledExecutions: number;
}

export function startAgentRun(
  repoRoot: string,
  input: StartAgentRunInput,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): StartAgentRunReceipt {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const foundation = new LocalFoundationStore(paths.database);
  let ownerPrincipalId: string;
  let stewardAgentId: string;
  let delegateTargets: readonly AgentRunDelegateTarget[];
  try {
    const local = foundation.foundation();
    if (local === undefined) throw new Error("Local foundation is not initialized");
    ownerPrincipalId = local.owner.principalId;
    const steward = foundation.agentByHandle(input.steward);
    if (steward === undefined) throw new Error(`Local Agent not found: ${input.steward}`);
    if (steward.status !== "active") {
      throw new Error(`Local Agent is not active: ${input.steward}`);
    }
    stewardAgentId = steward.principalId;
    delegateTargets = foundation.listAgents()
      .filter((agent) =>
        agent.status === "active" && agent.principalId !== steward.principalId)
      .map((agent) => ({
        agentId: agent.principalId,
        handle: agent.handle
      }));
  } finally {
    foundation.close();
  }

  const mandate = mandateSnapshot(input);
  const workspaceGrant = input.workspace === undefined
    ? undefined
    : externalWorkspaceGrant(input.workspace);
  const timestamp = iso(at);
  if (input.deadlineAt !== undefined &&
    Date.parse(iso(input.deadlineAt)) <= Date.parse(timestamp)) {
    throw new Error("deadlineAt must be in the future");
  }
  const database = openRuntimeDatabase(paths.database);
  const runtime = new RuntimeStore(database);
  const runs = new AgentRunStore(database);
  try {
    return runtime.withImmediateTransaction(() => {
      const runId = newAgentRunId();
      const rootStepId = newAgentStepId();
      const admission = runtime.appendEventInTransaction({
        type: "agent.request",
        source: {
          kind: "cli",
          externalId: `agent-run:${text(input.requestId, "requestId", 256)}`
        },
        agentId: stewardAgentId,
        prompt: agentRunTurnPrompt(mandate.renderedInstruction, delegateTargets),
        runContext: {
          schemaVersion: "AgentRunContext@1",
          resultContractId: "agent-turn-result@1",
          runId,
          stepId: rootStepId,
          depth: 0,
          ...(workspaceGrant === undefined ? {} : { workspaceGrant })
        },
        createdAt: timestamp
      });
      if (admission.status === "duplicate") {
        const existing = runs.projectionByRoot(admission.event.eventId);
        if (existing === undefined) {
          throw new Error(
            `Duplicate Agent Run Event has no run: ${admission.event.eventId}`
          );
        }
        return {
          status: "duplicate",
          run: existing,
          rootEventId: admission.event.eventId,
          executionId: admission.execution.executionId
        };
      }
      const run = runs.createInTransaction({
        runId,
        rootEventId: admission.event.eventId,
        rootExecutionId: admission.execution.executionId,
        ownerRequestId: input.requestId,
        ownerPrincipalId,
        stewardAgentId,
        mandate,
        ...(workspaceGrant === undefined ? {} : { workspaceGrant }),
        rootStepId,
        maxSteps: input.maxSteps ?? 20,
        maxDepth: input.maxDepth ?? 4,
        ...(input.deadlineAt === undefined
          ? {}
          : { deadlineAt: iso(input.deadlineAt) }),
        createdAt: timestamp
      });
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

export function cancelAgentRun(
  repoRoot: string,
  runId: string,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): CancelAgentRunReceipt {
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

function mandateSnapshot(input: StartAgentRunInput): RunMandateSnapshot {
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
}): ExternalWorkspaceGrant {
  if (!isAbsolute(input.root)) throw new Error("workspace.root must be absolute");
  const root = realpathSync(input.root);
  if (!statSync(root).isDirectory()) throw new Error("workspace.root must be a directory");
  return {
    schemaVersion: "ExternalWorkspaceGrant@1",
    root,
    access: input.access,
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
