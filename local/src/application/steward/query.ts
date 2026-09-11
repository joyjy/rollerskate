import { runCapabilityRequest } from "./capability.js";
import { runHumanQuestion } from "./human-input.js";
import type { AgentRequestEvent } from "../../core/event/model.js";
import type { DatabaseSync } from "node:sqlite";
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
import type {
  AgentInvocationDiagnostics,
  AgentInvocationFailure,
  AgentInvocationProgress
} from "../../core/runtime/agent-invocation.js";
import type { WorkspaceEffect } from "../../core/runtime/model.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import {
  workspaceRevision,
  type WorkspaceRevision
} from "../../infrastructure/workspace/revision.js";
import { eventTraceViews, type EventTraceView } from "../event/query.js";
import {
  literalLikePattern,
  normalizeListPageInput,
  type ListPage,
  type ListPageInput
} from "../list-page.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { assertCurrentLocalSchema } from
  "../../infrastructure/sqlite/schema/index.js";
import { inspectScheduleViewForRunSource } from "../schedule/query.js";
import { inspectSubscriptionViewForRunSource } from "../subscription/query.js";
import { stewardRunIntervention, type StewardRunIntervention } from "./intervention.js";

export interface StewardRunSummaryView {
  readonly version: number;
  readonly runId: string;
  readonly rootEventId: string;
  readonly status: AgentRunProjection["status"];
  readonly orchestrationMode: AgentRunProjection["orchestrationMode"];
  readonly series: {
    readonly key: string;
    readonly activeCycleId: string | null;
  } | null;
  readonly source: {
    readonly kind: "schedule" | "subscription" | "continuous_subscription";
    readonly id: string;
    readonly definitionRevision: string;
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
  readonly archivedAt: string | null;
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
  readonly intervention: StewardRunIntervention | null;
  readonly capabilityRequest: ReturnType<typeof runCapabilityRequest>;
  readonly humanQuestion: ReturnType<typeof runHumanQuestion>;
  readonly summary: StewardRunSummaryView;
  readonly projection: AgentRunProjection;
  readonly cycles: readonly AgentRunCycleProjection[];
  readonly triggerSource: TriggerSourceView | null;
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

export interface StewardRunInspectionOptions {
  readonly database?: DatabaseSync;
  readonly inspectCurrentWorkspaceRevision?: boolean;
}

export interface TriggerSourceView {
  readonly kind: "schedule" | "subscription" | "continuous_subscription";
  readonly id: string;
  readonly definitionRevision: string;
  readonly status: string;
  readonly diagnosticsRoute: string;
  readonly nextActionAt: string | null;
  readonly pendingOccurrenceKey: string | null;
  readonly checkpointOccurrenceKey: string | null;
  readonly reconcileStatus: string;
  readonly latestError: string | null;
  readonly lastOccurrence: {
    readonly occurrenceKey: string;
    readonly cycleId: string | null;
    readonly status: string;
    readonly observedAt: string;
  } | null;
}

export interface StewardOutputFolderView {
  readonly cycleId: string | null;
  readonly sourceRevision: string | null;
  readonly outputs: readonly StewardOutputView[];
}

export interface StewardOutputView {
  readonly outputId: string;
  readonly id?: string;
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
  readonly invocationProgress: AgentInvocationProgress | null;
  readonly invocationFailure: AgentInvocationFailure | null;
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
  limit = 100,
  archive: "current" | "archived" | "all" = "current"
): readonly StewardRunSummaryView[] {
  return withStores(repoRoot, runtimeDirectory, (stores) =>
    stores.runs.list(limit, archive).map((run) => summary(run, stores.foundation))
  );
}

export function pageStewardRunViews(
  repoRoot: string,
  input: ListPageInput = {},
  runtimeDirectory?: string
): ListPage<StewardRunSummaryView> {
  const query = normalizeListPageInput(input);
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  const where = `
    ($archive = 'all'
      OR ($archive = 'current' AND run.archived_at IS NULL)
      OR ($archive = 'archived' AND run.archived_at IS NOT NULL))
    AND ($search = ''
      OR run.run_id LIKE $pattern ESCAPE '\\'
      OR run.status LIKE $pattern ESCAPE '\\'
      OR steward.handle LIKE $pattern ESCAPE '\\'
      OR COALESCE(json_extract(run.mandate_snapshot_json, '$.objective'), '')
        LIKE $pattern ESCAPE '\\'
      OR COALESCE(json_extract(run.mandate_snapshot_json, '$.workflowRef'), '')
        LIKE $pattern ESCAPE '\\')
  `;
  const filterParameters = {
    archive: query.archive,
    search: query.search,
    pattern: literalLikePattern(query.search)
  };
  try {
    assertCurrentLocalSchema(database);
    database.exec("BEGIN");
    const total = Number((database.prepare(`
      SELECT COUNT(*) AS count
      FROM agent_runs AS run
      JOIN agents AS steward ON steward.principal_id = run.steward_agent_id
      WHERE ${where}
    `).get(filterParameters) as { count: number }).count);
    const ids = database.prepare(`
      SELECT run.run_id
      FROM agent_runs AS run
      JOIN agents AS steward ON steward.principal_id = run.steward_agent_id
      WHERE ${where}
      ORDER BY run.updated_at DESC, run.run_id DESC
      LIMIT $pageSize OFFSET $offset
    `).all({
      ...filterParameters,
      pageSize: query.pageSize,
      offset: query.offset
    }) as unknown as Array<{ run_id: string }>;
    database.exec("COMMIT");
    const items = withStores(repoRoot, runtimeDirectory, (stores) =>
      ids.map(({ run_id }) => summary(stores.runs.requireProjection(run_id), stores.foundation))
    );
    return { items, total, page: query.page, pageSize: query.pageSize };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

export function latestStewardRunView(
  repoRoot: string,
  runtimeDirectory?: string
): StewardRunDetailView | null {
  const latest = withStores(repoRoot, runtimeDirectory, (stores) =>
    stores.runs.list(1, "current")[0]
  );
  return latest === undefined
    ? null
    : inspectStewardRunView(repoRoot, latest.runId, runtimeDirectory);
}

export function inspectStewardRunView(
  repoRoot: string,
  runId: string,
  runtimeDirectory?: string,
  options: StewardRunInspectionOptions = {}
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
    const workspace = options.inspectCurrentWorkspaceRevision === false
      ? { value: undefined, error: undefined }
      : attempt(() =>
          run.workspaceGrant === undefined
            ? undefined
            : workspaceRevision(run.workspaceGrant.root)
        );
    const cycles = stores.runs.cycles(run.runId, 1_000);
    const decisions = stores.runs.decisions(run.runId);
    const steps = requests
      .map((request) => stepView(
        request,
        audits.find((audit) => audit.event.eventId === request.eventId)!,
        stores.foundation,
        stores.runtime
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return {
      capabilityRequest: runCapabilityRequest(run, stores.runs, stores.runtime),
      humanQuestion: runHumanQuestion(run,stores.runs,stores.runtime),
      intervention: stewardRunIntervention(run, requests, stores.runtime),
      summary: summary(run, stores.foundation),
      projection: run,
      cycles,
      triggerSource: triggerSourceView(run, cycles, stores),
      checkpoint: run.checkpoint ?? null,
      decisions: decisions.map((record) => record.receipt),
      orchestrationHistory: decisions,
      participants: [...participantIds].map((agentId) =>
        agentReference(requireAgent(stores.foundation, agentId))),
      sessions: stores.runtime.sessions(1_000).filter(
        (session) => session.runId === run.runId
      ),
      exchanges,
      exchangeCounts: exchangeCounts(exchanges),
      steps,
      outputFolders: outputFolders(cycles, steps, decisions),
      timeline: eventTraceViews(audits),
      currentWorkspaceRevision: workspace.value ?? null,
      workspaceRevisionError: workspace.error ?? null
    };
  }, options.database);
}

function outputFolders(
  cycles: readonly AgentRunCycleProjection[],
  steps: readonly StewardRunStepView[],
  decisions: readonly { readonly decision: AnyRunDecision; readonly receipt: AgentRunDecisionReceipt }[]
): readonly StewardOutputFolderView[] {
  const accepted = decisions.flatMap(({ decision, receipt }) =>
    (decision.schemaVersion === "RunDecision@4" || decision.schemaVersion === "RunDecision@5" || decision.schemaVersion === "RunDecision@6") && decision.action === "finish"
      ? (decision.finish.outputs ?? []).map((output) => ({
          cycleId: receipt.schemaVersion === "AgentRunDecisionReceipt@2" ? receipt.cycleId ?? null : null,
          output: { ...output, schemaVersion: output.schemaVersion ?? null,
            outputId: `${receipt.runId}:decision:${receipt.requestId}:output:${output.id}`,
            stepId: receipt.sourceStepId, kind: "output" as const }
        }))
      : []
  );
  const forCycle = (cycleId: string | null) => [
    ...outputsForSteps(steps.filter((step) => step.cycleId === cycleId)),
    ...accepted.filter((item) => item.cycleId === cycleId).map((item) => item.output)
  ];
  const cycleFolders = cycles.map((cycle) => ({
    cycleId: cycle.cycleId,
    sourceRevision: cycle.sourceRevision ?? null,
    outputs: forCycle(cycle.cycleId)
  }));
  const unscoped = forCycle(null);
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
        id: output.id,
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
  if ((result?.schemaVersion === "RunDecision@1" || result?.schemaVersion === "RunDecision@2" ||
    result?.schemaVersion === "RunDecision@3" || result?.schemaVersion === "RunDecision@4" || result?.schemaVersion === "RunDecision@5" || result?.schemaVersion === "RunDecision@6") &&
    result.action === "finish") {
    return result.finish.summary;
  }
  if ((result?.schemaVersion === "RunDecision@1" || result?.schemaVersion === "RunDecision@2" ||
    result?.schemaVersion === "RunDecision@3" || result?.schemaVersion === "RunDecision@4" || result?.schemaVersion === "RunDecision@5" || result?.schemaVersion === "RunDecision@6") &&
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
    invocationProgress: audit.invocationProgress ?? null,
    invocationFailure: audit.invocationFailure ?? null,
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
  if (request.runContext?.resultContractId === "run-decision@2" ||
    request.runContext?.resultContractId === "run-decision@3") {
    return parseRunDecision(JSON.parse(output) as unknown, {
      allowHistorical: request.runContext.resultContractId === "run-decision@2"
    });
  }
  if (request.runContext?.resultContractId === "agent-turn-adjudication@1") {
    const adjudication = parseAgentTurnAdjudication(output);
    if (adjudication.decision === "accept") return adjudication.normalizedResult;
    throw new Error("Agent turn adjudication did not accept a normalized result");
  }
  return parseAgentTurnResult(output);
}

interface Stores {
  readonly database: DatabaseSync;
  readonly runs: AgentRunStore;
  readonly runtime: RuntimeStore;
  readonly foundation: LocalFoundationStore;
}

function withStores<T>(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  callback: (stores: Stores) => T,
  existingDatabase?: DatabaseSync
): T {
  const databasePath = runtimePaths(repoRoot, runtimeDirectory).database;
  const database = existingDatabase ?? openRuntimeDatabaseReadOnly(databasePath);
  try {
    assertCurrentLocalSchema(database);
    const runs = new AgentRunStore(database, { migrate: false });
    const runtime = new RuntimeStore(database, { migrate: false });
    const foundation = new LocalFoundationStore(database, { migrate: false });
    try {
      return callback({ database, runs, runtime, foundation });
    } finally {
      foundation.close();
      runtime.close();
      runs.close();
    }
  } finally {
    if (existingDatabase === undefined) database.close();
  }
}

function summary(
  run: AgentRunProjection,
  foundation: LocalFoundationStore
): StewardRunSummaryView {
  return {
    runId: run.runId,
    version: run.version,
    rootEventId: run.rootEventId,
    status: run.status,
    orchestrationMode: run.orchestrationMode,
    series: run.seriesKey === undefined
      ? null
      : { key: run.seriesKey, activeCycleId: run.activeCycleId ?? null },
    source: run.sourceBinding === undefined
      ? null
      : {
          kind: run.sourceBinding.source.kind,
          id: run.sourceBinding.source.id,
          definitionRevision: run.sourceBinding.source.definitionRevision
        },
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
    archivedAt: run.archivedAt ?? null,
    updatedAt: run.updatedAt
  };
}

function triggerSourceView(
  run: AgentRunProjection,
  cycles: readonly AgentRunCycleProjection[],
  stores: Stores
): TriggerSourceView | null {
  const binding = run.sourceBinding;
  if (binding === undefined) return null;
  const source = binding.source;
  if (source.kind === "schedule") {
    const schedule = inspectScheduleViewForRunSource(stores.database, source.id);
    const occurrence = schedule.occurrence;
    const cycle = occurrence === null || occurrence.cycleId === null
      ? undefined
      : cycles.find(({ cycleId }) => cycleId === occurrence.cycleId);
    return {
      kind: source.kind,
      id: source.id,
      definitionRevision: source.definitionRevision,
      status: schedule.status,
      diagnosticsRoute: `/console/schedules?scheduleId=${encodeURIComponent(source.id)}`,
      nextActionAt: schedule.nextRunAt,
      pendingOccurrenceKey: occurrence !== null &&
        (occurrence.status === "queued" || occurrence.status === "running")
        ? occurrence.occurrenceKey
        : null,
      checkpointOccurrenceKey: occurrence?.status === "succeeded"
        ? occurrence.occurrenceKey
        : null,
      reconcileStatus: cycle?.status ?? occurrence?.status ?? "awaiting_occurrence",
      latestError: occurrence?.failureRef ?? null,
      lastOccurrence: occurrence === null
        ? null
        : {
            occurrenceKey: occurrence.occurrenceKey,
            cycleId: occurrence.cycleId,
            status: cycle?.status ?? occurrence.status,
            observedAt: occurrence.updatedAt
          }
    };
  }
  const subscription = inspectSubscriptionViewForRunSource(stores.database, source.id);
  if (subscription.kind === "free") {
    const admission = subscription.admissionReceipt ?? null;
    const cycle = subscription.cycleId === null
      ? undefined
      : cycles.find(({ cycleId }) => cycleId === subscription.cycleId);
    return {
      kind: source.kind,
      id: source.id,
      definitionRevision: source.definitionRevision,
      status: subscription.status,
      diagnosticsRoute: `/console/subscriptions?subscriptionId=${encodeURIComponent(source.id)}`,
      nextActionAt: subscription.nextPollAt,
      pendingOccurrenceKey: admission !== null &&
        subscription.callbackPhaseStatus === "running"
        ? admission.occurrenceKey
        : null,
      checkpointOccurrenceKey: admission !== null &&
        subscription.callbackPhaseStatus === "completed"
        ? admission.occurrenceKey
        : null,
      reconcileStatus: subscription.callbackPhaseStatus,
      latestError: subscription.latestError ?? null,
      lastOccurrence: admission === null
        ? null
        : {
            occurrenceKey: admission.occurrenceKey,
            cycleId: subscription.cycleId,
            status: cycle?.status ?? subscription.callbackPhaseStatus,
            observedAt: admission.admittedAt
          }
    };
  }
  const pendingAdmission = subscription.pendingAdmissionReceipt ?? null;
  const cycle = subscription.pendingCycleId === null
    ? undefined
      : cycles.find(({ cycleId }) => cycleId === subscription.pendingCycleId);
  return {
    kind: source.kind,
    id: source.id,
    definitionRevision: source.definitionRevision,
    status: subscription.status,
    diagnosticsRoute: `/console/subscriptions?subscriptionId=${encodeURIComponent(source.id)}`,
    nextActionAt: subscription.nextPollAt,
    pendingOccurrenceKey: subscription.pendingOccurrenceKey,
    checkpointOccurrenceKey: subscription.checkpointOccurrenceKey,
    reconcileStatus: subscription.latestError !== null
      ? `blocked:${subscription.latestError}`
      : cycle?.status ?? (subscription.pendingOccurrenceKey === null
          ? "awaiting_delta"
          : "pending_cycle"),
    latestError: subscription.latestError,
    lastOccurrence: pendingAdmission !== null
      ? {
          occurrenceKey: pendingAdmission.occurrenceKey,
          cycleId: subscription.pendingCycleId,
          status: cycle?.status ?? "pending_cycle",
          observedAt: pendingAdmission.admittedAt
        }
      : subscription.checkpointOccurrenceKey === null
        ? null
        : {
            occurrenceKey: subscription.checkpointOccurrenceKey,
            cycleId: null,
            status: "checkpointed",
            observedAt: subscription.updatedAt
          }
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
