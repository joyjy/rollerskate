import type { AgentRequestEvent } from "../../core/event/model.js";
import { RuntimeStore, type RuntimeAudit } from "../../core/runtime/store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import type {
  AgentRunCycleProjection,
  AgentRunProjection
} from "../../modules/steward/state-machine.js";
import {
  parseAgentStepResult,
  parseRunDecision,
  type AgentRunCheckpoint,
  type AgentRunDecisionReceipt,
  type AgentStepResult,
  type AnyRunDecision
} from "../../modules/steward/caller-contract.js";
import {
  parseAgentTurnResult,
  type AgentTurnResult
} from "../../modules/steward/result-contract.js";
import {
  parseAgentTurnAdjudication
} from "../../modules/steward/result-adjudication.js";
import type { AgentInvocationDiagnostics } from "../../core/runtime/agent-invocation.js";
import type { WorkspaceEffect } from "../../core/runtime/model.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import {
  workspaceRevision,
  type WorkspaceRevision
} from "../../infrastructure/workspace/revision.js";
import { eventTraceViews, type EventTraceView } from "../event/query.js";

export interface StewardRunSummaryView {
  readonly runId: string;
  readonly rootEventId: string;
  readonly status: AgentRunProjection["status"];
  readonly orchestrationMode: AgentRunProjection["orchestrationMode"];
  readonly series: {
    readonly key: string;
    readonly activeCycleId: string | null;
  } | null;
  readonly mandate: {
    readonly kind: AgentRunProjection["mandate"]["kind"];
    readonly label: string;
    readonly workflowRef: string | null;
  };
  readonly steward: AgentReferenceView;
  readonly workspace: {
    readonly root: string;
    readonly access: "read" | "write";
    readonly effect?: WorkspaceEffect;
    readonly networkAccess?: boolean;
    readonly admittedRevision: string;
  } | null;
  readonly progress: {
    readonly steps: number;
    readonly maxSteps: number;
    readonly maxDepth: number;
  };
  readonly terminalSummary: string | null;
  readonly updatedAt: string;
}

export interface AgentExchangeView {
  readonly fromAgentId: string;
  readonly toAgentId: string;
  readonly kind: "delegate" | "callback";
  readonly requestEventId: string;
  readonly stepId: string;
  readonly createdAt: string;
}

export interface AgentExchangeCountView {
  readonly fromAgentId: string;
  readonly toAgentId: string;
  readonly delegates: number;
  readonly callbacks: number;
  readonly total: number;
}

export interface StewardRunDetailView {
  readonly summary: StewardRunSummaryView;
  readonly projection: AgentRunProjection;
  readonly cycles: readonly AgentRunCycleProjection[];
  readonly checkpoint: AgentRunCheckpoint | null;
  readonly decisions: readonly AgentRunDecisionReceipt[];
  readonly orchestrationHistory: readonly {
    readonly decision: AnyRunDecision;
    readonly receipt: AgentRunDecisionReceipt;
  }[];
  readonly participants: readonly AgentReferenceView[];
  readonly sessions: ReturnType<RuntimeStore["sessions"]>;
  readonly exchanges: readonly AgentExchangeView[];
  readonly exchangeCounts: readonly AgentExchangeCountView[];
  readonly steps: readonly StewardRunStepView[];
  readonly outputFolders: readonly StewardOutputFolderView[];
  readonly timeline: readonly EventTraceView[];
  readonly currentWorkspaceRevision: WorkspaceRevision | null;
  readonly workspaceRevisionError: string | null;
}

export interface StewardOutputFolderView {
  readonly cycleId: string | null;
  readonly sourceRevision: string | null;
  readonly outputs: readonly StewardOutputView[];
}

export interface StewardOutputView {
  readonly outputId: string;
  readonly stepId: string;
  readonly title: string;
  readonly kind: "primary" | "output" | "reference";
  readonly contentType: "application/json" | "text/markdown" | "text/plain" | "text/uri-list";
  readonly schemaVersion: string | null;
  readonly value: unknown;
}

export interface StewardRunStepView {
  readonly stepId: string;
  readonly cycleId: string | null;
  readonly parentStepId: string | null;
  readonly depth: number;
  readonly agent: AgentReferenceView;
  readonly requestEventId: string;
  readonly resultEventId: string | null;
  readonly status: "queued" | "running" | "succeeded" | "failed";
  readonly prompt: string;
  readonly effectivePrompt: string | null;
  readonly result: AgentTurnResult | AgentStepResult | AnyRunDecision | null;
  readonly rawOutput: string | null;
  readonly error: string | null;
  readonly invocation: AgentInvocationDiagnostics | null;
  readonly observedWorkspaceRevision: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

interface AgentReferenceView {
  readonly principalId: string;
  readonly handle: string;
  readonly client: LocalAgent["client"];
  readonly status: LocalAgent["status"];
}

export function listStewardRunViews(
  repoRoot: string,
  runtimeDirectory?: string,
  limit = 100
): readonly StewardRunSummaryView[] {
  return withStores(repoRoot, runtimeDirectory, (stores) =>
    stores.runs.list(limit).map((run) => summary(run, stores.foundation))
  );
}

export function latestStewardRunView(
  repoRoot: string,
  runtimeDirectory?: string
): StewardRunDetailView | null {
  const latest = withStores(repoRoot, runtimeDirectory, (stores) =>
    stores.runs.list(1)[0]
  );
  return latest === undefined
    ? null
    : inspectStewardRunView(repoRoot, latest.runId, runtimeDirectory);
}

export function inspectStewardRunView(
  repoRoot: string,
  runId: string,
  runtimeDirectory?: string
): StewardRunDetailView {
  return withStores(repoRoot, runtimeDirectory, (stores) => {
    const run = stores.runs.requireProjection(runId);
    const audits = stores.runs.eventIds(runId)
      .map((eventId) => stores.runtime.audit(eventId))
      .filter((entry): entry is RuntimeAudit => entry !== undefined);
    const requests = audits
      .map((entry) => entry.event)
      .filter((event): event is AgentRequestEvent =>
        event.type === "agent.request" &&
        event.runContext?.runId === run.runId);
    const exchanges = requests.flatMap(exchange);
    const participantIds = new Set<string>([
      run.stewardAgentId,
      ...(run.mandate.participantAgentIds ?? []),
      ...requests.map((request) => request.agentId),
      ...exchanges.flatMap((item) => [item.fromAgentId, item.toAgentId])
    ]);
    const workspace = attempt(() =>
      run.workspaceGrant === undefined
        ? undefined
        : workspaceRevision(run.workspaceGrant.root)
    );
    const cycles = stores.runs.cycles(run.runId, 1_000);
    const steps = requests
      .map((request) => stepView(
        request,
        audits.find((audit) => audit.event.eventId === request.eventId)!,
        stores.foundation,
        stores.runtime
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return {
      summary: summary(run, stores.foundation),
      projection: run,
      cycles,
      checkpoint: run.checkpoint ?? null,
      decisions: stores.runs.decisions(run.runId).map((record) => record.receipt),
      orchestrationHistory: stores.runs.decisions(run.runId),
      participants: [...participantIds].map((agentId) =>
        agentReference(requireAgent(stores.foundation, agentId))),
      sessions: stores.runtime.sessions(1_000).filter(
        (session) => session.runId === run.runId
      ),
      exchanges,
      exchangeCounts: exchangeCounts(exchanges),
      steps,
      outputFolders: outputFolders(cycles, steps),
      timeline: eventTraceViews(audits),
      currentWorkspaceRevision: workspace.value ?? null,
      workspaceRevisionError: workspace.error ?? null
    };
  });
}

function outputFolders(
  cycles: readonly AgentRunCycleProjection[],
  steps: readonly StewardRunStepView[]
): readonly StewardOutputFolderView[] {
  const cycleFolders = cycles.map((cycle) => ({
    cycleId: cycle.cycleId,
    sourceRevision: cycle.sourceRevision ?? null,
    outputs: outputsForSteps(steps.filter((step) => step.cycleId === cycle.cycleId))
  }));
  const unscoped = outputsForSteps(steps.filter((step) => step.cycleId === null));
  return unscoped.length === 0
    ? cycleFolders
    : [{ cycleId: null, sourceRevision: null, outputs: unscoped }, ...cycleFolders];
}

function outputsForSteps(steps: readonly StewardRunStepView[]): StewardOutputView[] {
  return steps.flatMap((step) => {
    const result = step.result;
    const primary = primaryOutput(result);
    if (primary === null) return [];
    return [
      {
        outputId: `${step.stepId}:primary`,
        stepId: step.stepId,
        title: "Terminal result",
        kind: "primary" as const,
        contentType: "text/plain" as const,
        schemaVersion: null,
        value: primary
      },
      ...(result?.schemaVersion === "AgentTurnResult@1" && result.action === "complete"
        ? (result.outputs ?? []).map((output) => ({
        outputId: `${step.stepId}:output:${output.id}`,
        stepId: step.stepId,
        title: output.title,
        kind: "output" as const,
        contentType: output.contentType,
        schemaVersion: output.schemaVersion ?? null,
        value: output.value
      }))
        : []),
      ...(result?.schemaVersion === "AgentTurnResult@1" && result.action === "complete"
        ? result.artifactRefs.map((reference, index) => ({
        outputId: `${step.stepId}:artifact-${index + 1}`,
        stepId: step.stepId,
        title: `Artifact ${index + 1}`,
        kind: "reference" as const,
        contentType: "text/uri-list" as const,
        schemaVersion: null,
        value: reference
      }))
        : [])
    ];
  });
}

function primaryOutput(result: StewardRunStepView["result"]): string | null {
  if (result?.schemaVersion === "AgentTurnResult@1" && result.action === "complete") {
    return result.summary;
  }
  if ((result?.schemaVersion === "RunDecision@1" || result?.schemaVersion === "RunDecision@2") &&
    result.action === "finish") {
    return result.finish.summary;
  }
  if ((result?.schemaVersion === "RunDecision@1" || result?.schemaVersion === "RunDecision@2") &&
    result.action === "needs_human") {
    return result.rationale;
  }
  return null;
}

function stepView(
  request: AgentRequestEvent,
  audit: RuntimeAudit,
  foundation: LocalFoundationStore,
  runtime: RuntimeStore
): StewardRunStepView {
  const output = audit.resultEvent?.output;
  return {
    stepId: request.runContext!.stepId,
    cycleId: request.runContext!.cycleId ?? null,
    parentStepId: request.runContext!.parentStepId ?? null,
    depth: request.runContext!.depth,
    agent: agentReference(requireAgent(foundation, request.agentId)),
    requestEventId: request.eventId,
    resultEventId: audit.resultEvent?.eventId ?? null,
    status: audit.resultEvent?.outcome ??
      (audit.execution?.status === "running" ? "running" : "queued"),
    prompt: request.prompt,
    effectivePrompt: audit.invocation?.effectivePrompt ?? null,
    result: output === undefined
      ? null
      : attempt(() => parseStepOutput(request, output)).value ?? null,
    rawOutput: output ?? null,
    error: audit.resultEvent?.error ?? audit.execution?.lastError ?? null,
    invocation: audit.invocation ?? null,
    observedWorkspaceRevision: resultObservedWorkspaceRevision(audit, runtime),
    createdAt: request.createdAt,
    completedAt: audit.invocation?.completedAt ?? audit.resultEvent?.createdAt ?? null
  };
}

function resultObservedWorkspaceRevision(
  audit: RuntimeAudit,
  runtime: RuntimeStore
): string | null {
  const executionId = audit.resultExecution?.executionId;
  if (executionId === undefined) return null;
  const raw = runtime.executionReceiptJson(executionId);
  if (raw === null) return null;
  try {
    const receipt = JSON.parse(raw) as unknown;
    if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return null;
    const revision = (receipt as Readonly<Record<string, unknown>>).observedWorkspaceRevision;
    return typeof revision === "string" && revision.trim() !== "" ? revision : null;
  } catch {
    return null;
  }
}

function parseStepOutput(
  request: AgentRequestEvent,
  output: string
): AgentTurnResult | AgentStepResult | AnyRunDecision {
  if (request.runContext?.resultContractId === "agent-step-result@1") {
    return parseAgentStepResult(output);
  }
  if (request.runContext?.resultContractId === "run-decision@2") {
    return parseRunDecision(JSON.parse(output) as unknown);
  }
  if (request.runContext?.resultContractId === "agent-turn-adjudication@1") {
    const adjudication = parseAgentTurnAdjudication(output);
    if (adjudication.decision === "accept") return adjudication.normalizedResult;
    throw new Error("Agent turn adjudication did not accept a normalized result");
  }
  return parseAgentTurnResult(output);
}

interface Stores {
  readonly runs: AgentRunStore;
  readonly runtime: RuntimeStore;
  readonly foundation: LocalFoundationStore;
}

function withStores<T>(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  callback: (stores: Stores) => T
): T {
  const databasePath = runtimePaths(repoRoot, runtimeDirectory).database;
  const runs = new AgentRunStore(databasePath);
  const runtime = new RuntimeStore(databasePath);
  const foundation = new LocalFoundationStore(databasePath);
  try {
    return callback({ runs, runtime, foundation });
  } finally {
    foundation.close();
    runtime.close();
    runs.close();
  }
}

function summary(
  run: AgentRunProjection,
  foundation: LocalFoundationStore
): StewardRunSummaryView {
  return {
    runId: run.runId,
    rootEventId: run.rootEventId,
    status: run.status,
    orchestrationMode: run.orchestrationMode,
    series: run.seriesKey === undefined
      ? null
      : { key: run.seriesKey, activeCycleId: run.activeCycleId ?? null },
    mandate: {
      kind: run.mandate.kind,
      label: run.mandate.kind === "workflow"
        ? run.mandate.workflowRef
        : boundedLabel(run.mandate.objective),
      workflowRef: run.mandate.kind === "workflow"
        ? run.mandate.workflowRef
        : null
    },
    steward: agentReference(requireAgent(foundation, run.stewardAgentId)),
    workspace: run.workspaceGrant === undefined
      ? null
      : {
          root: run.workspaceGrant.root,
          access: run.workspaceGrant.access,
          ...(run.workspaceGrant.effect === undefined
            ? {}
            : { effect: run.workspaceGrant.effect }),
          ...(run.workspaceGrant.networkAccess === undefined
            ? {}
            : { networkAccess: run.workspaceGrant.networkAccess }),
          admittedRevision: run.workspaceGrant.revision
        },
    progress: {
      steps: run.stepCount,
      maxSteps: run.maxSteps,
      maxDepth: run.maxDepth
    },
    terminalSummary: run.terminalSummary ?? null,
    updatedAt: run.updatedAt
  };
}

function exchange(request: AgentRequestEvent): AgentExchangeView[] {
  const context = request.runContext!;
  if (context.stepCompletion !== undefined) {
    return [{
      fromAgentId: context.stepCompletion.childAgentId,
      toAgentId: request.agentId,
      kind: "callback",
      requestEventId: request.eventId,
      stepId: context.stepId,
      createdAt: request.createdAt
    }];
  }
  if (context.completionBinding !== undefined) {
    return [{
      fromAgentId: context.completionBinding.callerAgentId,
      toAgentId: request.agentId,
      kind: "delegate",
      requestEventId: request.eventId,
      stepId: context.stepId,
      createdAt: request.createdAt
    }];
  }
  return [];
}

function exchangeCounts(
  exchanges: readonly AgentExchangeView[]
): AgentExchangeCountView[] {
  const counts = new Map<string, AgentExchangeCountView>();
  for (const exchange of exchanges) {
    const key = `${exchange.fromAgentId}\0${exchange.toAgentId}`;
    const existing = counts.get(key) ?? {
      fromAgentId: exchange.fromAgentId,
      toAgentId: exchange.toAgentId,
      delegates: 0,
      callbacks: 0,
      total: 0
    };
    counts.set(key, {
      ...existing,
      delegates: existing.delegates + (exchange.kind === "delegate" ? 1 : 0),
      callbacks: existing.callbacks + (exchange.kind === "callback" ? 1 : 0),
      total: existing.total + 1
    });
  }
  return [...counts.values()].sort((left, right) =>
    left.fromAgentId.localeCompare(right.fromAgentId) ||
    left.toAgentId.localeCompare(right.toAgentId));
}

function requireAgent(
  foundation: LocalFoundationStore,
  agentId: string
): LocalAgent {
  const agent = foundation.agent(agentId);
  if (agent === undefined) throw new Error(`Local Agent is missing: ${agentId}`);
  return agent;
}

function agentReference(agent: LocalAgent): AgentReferenceView {
  return {
    principalId: agent.principalId,
    handle: agent.handle,
    client: agent.client,
    status: agent.status
  };
}

function boundedLabel(value: string): string {
  const firstLine = value.split("\n", 1)[0]!.trim();
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}...`;
}

function attempt<T>(callback: () => T): {
  readonly value?: T;
  readonly error?: string;
} {
  try {
    return { value: callback() };
  } catch (error) {
    return {
      error: (error instanceof Error ? error.message : String(error)).slice(0, 4_096)
    };
  }
}
