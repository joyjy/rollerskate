import type { AgentRequestEvent } from "../../core/event/model.js";
import { RuntimeStore, type RuntimeAudit } from "../../core/runtime/store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import type { AgentRunProjection } from "../../modules/agent-run/state-machine.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import {
  workspaceRevision,
  type WorkspaceRevision
} from "../../infrastructure/workspace/revision.js";
import { eventTraceViews, type EventTraceView } from "../event/query.js";

export interface AgentRunSummaryView {
  readonly runId: string;
  readonly rootEventId: string;
  readonly status: AgentRunProjection["status"];
  readonly mandate: {
    readonly kind: AgentRunProjection["mandate"]["kind"];
    readonly label: string;
    readonly workflowRef: string | null;
  };
  readonly steward: AgentReferenceView;
  readonly workspace: {
    readonly root: string;
    readonly access: "read" | "write";
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

export interface AgentRunDetailView {
  readonly summary: AgentRunSummaryView;
  readonly projection: AgentRunProjection;
  readonly participants: readonly AgentReferenceView[];
  readonly sessions: ReturnType<RuntimeStore["sessions"]>;
  readonly exchanges: readonly AgentExchangeView[];
  readonly exchangeCounts: readonly AgentExchangeCountView[];
  readonly timeline: readonly EventTraceView[];
  readonly currentWorkspaceRevision: WorkspaceRevision | null;
  readonly workspaceRevisionError: string | null;
}

interface AgentReferenceView {
  readonly principalId: string;
  readonly handle: string;
  readonly client: LocalAgent["client"];
  readonly status: LocalAgent["status"];
}

export function listAgentRunViews(
  repoRoot: string,
  runtimeDirectory?: string,
  limit = 100
): readonly AgentRunSummaryView[] {
  return withStores(repoRoot, runtimeDirectory, (stores) =>
    stores.runs.list(limit).map((run) => summary(run, stores.foundation))
  );
}

export function latestAgentRunView(
  repoRoot: string,
  runtimeDirectory?: string
): AgentRunDetailView | null {
  const latest = withStores(repoRoot, runtimeDirectory, (stores) =>
    stores.runs.list(1)[0]
  );
  return latest === undefined
    ? null
    : inspectAgentRunView(repoRoot, latest.runId, runtimeDirectory);
}

export function inspectAgentRunView(
  repoRoot: string,
  runId: string,
  runtimeDirectory?: string
): AgentRunDetailView {
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
      ...requests.map((request) => request.agentId),
      ...exchanges.flatMap((item) => [item.fromAgentId, item.toAgentId])
    ]);
    const workspace = attempt(() =>
      run.workspaceGrant === undefined
        ? undefined
        : workspaceRevision(run.workspaceGrant.root)
    );
    return {
      summary: summary(run, stores.foundation),
      projection: run,
      participants: [...participantIds].map((agentId) =>
        agentReference(requireAgent(stores.foundation, agentId))),
      sessions: stores.runtime.sessions(1_000).filter(
        (session) => session.runId === run.runId
      ),
      exchanges,
      exchangeCounts: exchangeCounts(exchanges),
      timeline: eventTraceViews(audits),
      currentWorkspaceRevision: workspace.value ?? null,
      workspaceRevisionError: workspace.error ?? null
    };
  });
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
): AgentRunSummaryView {
  return {
    runId: run.runId,
    rootEventId: run.rootEventId,
    status: run.status,
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
