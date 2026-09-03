import { eventTrace } from "../event/query.js";
import { inspectStewardRunView } from "../steward/query.js";
import { subscriptionHistoryByReference } from "../subscription/query.js";
import { redact } from "../../integrations/activity/provider-source.js";
import type { ChatReadToolContext } from "./read-tool-policy.js";

export type ChatReadQuery =
  | { readonly tool: "subscription_history"; readonly subscriptionId: string; readonly limit: number }
  | { readonly tool: "get_run"; readonly runId: string }
  | { readonly tool: "event_trace"; readonly eventId: string };

export function queryChatReadTool(
  context: Pick<ChatReadToolContext, "repoRoot" | "runtimeDirectory">,
  query: ChatReadQuery
): unknown {
  if (query.tool === "subscription_history") {
    return subscriptionHistoryView(context, query.subscriptionId, query.limit);
  }
  if (query.tool === "get_run") return runEvidenceView(context, query.runId);
  return eventEvidenceView(context, query.eventId);
}

function subscriptionHistoryView(
  context: Pick<ChatReadToolContext, "repoRoot" | "runtimeDirectory">,
  subscriptionId: string,
  limit: number
): unknown {
  const history = subscriptionHistoryByReference(
    context.repoRoot,
    subscriptionId,
    context.runtimeDirectory
  );
  const fires = history.fires.slice(-limit).map((fire) => ({
    ...fire,
    lastError: safeText(fire.lastError),
    resultEvent: {
      ...fire.resultEvent,
      output: safeText(fire.resultEvent.output),
      error: safeText(fire.resultEvent.error)
    },
    deliveries: fire.deliveries.map((delivery) => ({
      ...delivery,
      lastError: safeText(delivery.lastError),
      executions: delivery.executions.map((execution) => ({
        ...execution,
        lastError: safeText(execution.lastError)
      }))
    }))
  }));
  return {
    schemaVersion: "ChatSubscriptionHistory@1",
    queryStatus: history.queryStatus,
    subscriptionId: history.subscriptionId,
    linkStatus: history.linkStatus,
    reasonCode: history.reasonCode,
    fires,
    truncated: fires.length < history.fires.length
  };
}

function runEvidenceView(
  context: Pick<ChatReadToolContext, "repoRoot" | "runtimeDirectory">,
  runId: string
): unknown {
  const view = inspectStewardRunView(
    context.repoRoot,
    runId,
    context.runtimeDirectory,
    { inspectCurrentWorkspaceRevision: false }
  );
  return {
    schemaVersion: "ChatRunEvidence@1",
    summary: {
      runId: view.summary.runId,
      rootEventId: view.summary.rootEventId,
      status: view.summary.status,
      orchestrationMode: view.summary.orchestrationMode,
      series: view.summary.series,
      source: view.summary.source,
      mandate: {
        kind: view.summary.mandate.kind,
        label: safeText(view.summary.mandate.label),
        workflowRef: view.summary.mandate.workflowRef
      },
      steward: view.summary.steward,
      workspace: view.summary.workspace === null
        ? null
        : {
            access: view.summary.workspace.access,
            effect: view.summary.workspace.effect ?? null,
            networkAccess: view.summary.workspace.networkAccess ?? false,
            admittedRevision: view.summary.workspace.admittedRevision
          },
      progress: view.summary.progress,
      terminalSummary: safeText(view.summary.terminalSummary),
      archivedAt: view.summary.archivedAt,
      updatedAt: view.summary.updatedAt
    },
    triggerSource: view.triggerSource === null
      ? null
      : {
          ...view.triggerSource,
          latestError: safeText(view.triggerSource.latestError)
        },
    participants: view.participants,
    steps: view.steps.slice(-50).map((step) => ({
      stepId: step.stepId,
      cycleId: step.cycleId,
      parentStepId: step.parentStepId,
      depth: step.depth,
      agent: step.agent,
      requestEventId: step.requestEventId,
      resultEventId: step.resultEventId,
      status: step.status,
      resultSummary: safeText(serialized(step.result)),
      error: safeText(step.error),
      toolUsage: step.invocation?.toolUsage ?? [],
      durationMilliseconds: step.invocation?.durationMilliseconds ?? null,
      createdAt: step.createdAt,
      completedAt: step.completedAt
    })),
    stepsTruncated: view.steps.length > 50,
    exchanges: view.exchanges.slice(-100),
    exchangesTruncated: view.exchanges.length > 100
  };
}

function eventEvidenceView(
  context: Pick<ChatReadToolContext, "repoRoot" | "runtimeDirectory">,
  eventId: string
): unknown {
  const trace = eventTrace(context.repoRoot, eventId, context.runtimeDirectory);
  return {
    schemaVersion: "ChatEventTrace@1",
    event: eventSummary(trace.event),
    execution: executionSummary(trace.execution),
    resultEvent: resultEventSummary(trace.resultEvent),
    resultExecution: executionSummary(trace.resultExecution),
    deliveries: trace.deliveries.map(({ delivery }) => ({
      deliveryId: delivery.deliveryId,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      maxAttempts: delivery.maxAttempts,
      boundedError: safeText(delivery.boundedError ?? null),
      updatedAt: delivery.updatedAt
    })),
    invocation: trace.invocation === undefined
      ? null
      : {
          startedAt: trace.invocation.startedAt,
          completedAt: trace.invocation.completedAt,
          durationMilliseconds: trace.invocation.durationMilliseconds,
          toolUsage: trace.invocation.toolUsage ?? []
        },
    lifecycleChangedAt: trace.lifecycleChangedAt,
    reasonForIntervention: safeText(trace.reasonForIntervention),
    directChildren: trace.directChildren.slice(0, 100),
    directChildrenTruncated: trace.directChildren.length > 100,
    conversationTimeline: (trace.conversationTimeline ?? []).slice(-100).map((item) => ({
      ...item,
      ...(item.reason === undefined ? {} : { reason: safeText(item.reason) })
    })),
    conversationTimelineTruncated: (trace.conversationTimeline?.length ?? 0) > 100,
    causalityBoundary: trace.causalityBoundary
  };
}

function eventSummary(value: unknown): unknown {
  if (!record(value)) return null;
  return {
    eventId: value.eventId,
    type: value.type,
    source: sourceSummary(value.source),
    agentId: value.agentId ?? null,
    sessionId: value.sessionId ?? null,
    createdAt: value.createdAt,
    causality: value.causality,
    contentSummary: safeText(
      string(value.boundedPromptSummary) ?? string(value.body) ?? null
    )
  };
}

function sourceSummary(value: unknown): unknown {
  if (!record(value)) return null;
  return {
    kind: value.kind,
    externalId: safeText(string(value.externalId) ?? null)
  };
}

function executionSummary(value: unknown): unknown {
  if (!record(value)) return null;
  return {
    executionId: value.executionId,
    eventId: value.eventId,
    handler: value.handler,
    status: value.status,
    attemptCount: value.attemptCount,
    maxAttempts: value.maxAttempts,
    lastError: safeText(string(value.lastError) ?? null),
    nextAttemptAt: value.nextAttemptAt,
    createdAt: value.createdAt,
    startedAt: value.startedAt ?? null,
    completedAt: value.completedAt ?? null,
    updatedAt: value.updatedAt
  };
}

function resultEventSummary(value: unknown): unknown {
  if (!record(value)) return null;
  return {
    eventId: value.eventId,
    outcome: value.outcome,
    output: safeText(string(value.output) ?? null),
    error: safeText(string(value.error) ?? null),
    createdAt: value.createdAt
  };
}

function safeText(value: string | null): string | null {
  return value === null ? null : redact(value);
}

function serialized(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
