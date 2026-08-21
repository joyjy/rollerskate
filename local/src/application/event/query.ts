import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { RuntimeStore, type RuntimeAudit } from "../../core/runtime/store.js";

export function eventTrace(
  repoRoot: string,
  eventId: string,
  runtimeDirectory?: string
): EventTraceView {
  const store = new RuntimeStore(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const audit = store.audit(eventId);
    if (audit === undefined) throw new Error(`Event not found: ${eventId}`);
    return eventTraceView(
      audit,
      store.auditsForRoot(audit.event.causality.rootEventId),
      true
    );
  } finally {
    store.close();
  }
}

export function listEventTraces(
  repoRoot: string,
  runtimeDirectory?: string
): readonly EventTraceView[] {
  const store = new RuntimeStore(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const audits = store.audits(1_000);
    return eventTraceViews(audits, false);
  } finally {
    store.close();
  }
}

export function eventTraceViews(
  audits: readonly RuntimeAudit[],
  includeConversationTimeline = true
): readonly EventTraceView[] {
  return audits.map((audit) =>
    eventTraceView(audit, audits, includeConversationTimeline));
}

export type EventTraceView = ReturnType<typeof eventTraceView>;

function eventTraceView(
  audit: RuntimeAudit,
  all: readonly RuntimeAudit[],
  includeDetails: boolean
) {
  const event = "prompt" in audit.event
    ? (() => {
        const { prompt, ...summary } = audit.event;
        return {
          ...summary,
          ...(includeDetails ? { prompt: bounded(prompt, 1_024) } : {}),
          boundedPromptSummary: bounded(prompt, 160)
        };
      })()
    : audit.event;
  const resultEvent = audit.resultEvent === undefined
    ? undefined
    : (() => {
        const { output, error, ...summary } = audit.resultEvent;
        return {
          ...summary,
          ...(includeDetails && output !== undefined
            ? { output: bounded(output, 4_096) }
            : {}),
          ...(includeDetails && error !== undefined
            ? { error: bounded(error, 4_096) }
            : {})
        };
      })();
  const directChildren = all
    .filter((candidate) => candidate.event.causality.parentEventId === audit.event.eventId)
    .map((candidate) => ({
      eventId: candidate.event.eventId,
      type: candidate.event.type,
      status: candidate.execution?.status ?? "recorded"
    }));
  const timestamps = [
    audit.event.createdAt,
    audit.execution?.updatedAt,
    audit.resultEvent?.createdAt,
    audit.resultExecution?.updatedAt,
    ...audit.deliveries.map(({ delivery }) => delivery.updatedAt)
  ].filter((value): value is string => value !== undefined).sort();
  const failure = audit.execution?.status === "failed"
    ? audit.execution.lastError
    : audit.resultExecution?.status === "failed"
      ? audit.resultExecution.lastError
      : audit.deliveries.find(({ delivery }) => delivery.status === "failed")?.delivery.lastError;
  return {
    event,
    execution: audit.execution === undefined ? null : executionView(audit.execution),
    ...(resultEvent === undefined ? {} : { resultEvent }),
    ...(audit.resultExecution === undefined
      ? {}
      : { resultExecution: executionView(audit.resultExecution) }),
    ...(audit.session === undefined
      ? {}
      : {
          session: {
            ...audit.session,
            resumedAt: audit.session.updatedAt === audit.session.createdAt
              ? null
              : audit.session.updatedAt
          }
        }),
    deliveries: audit.deliveries.map(({ delivery, destination }) => ({
      delivery: {
        ...delivery,
        source: "agent.result",
        attemptedAt: delivery.attemptCount === 0 ? null : delivery.updatedAt,
        deliveredAt: delivery.status === "delivered" ? delivery.updatedAt : null,
        boundedError: delivery.lastError === undefined ? undefined : bounded(delivery.lastError, 512)
      },
      destination
    })),
    ...(includeDetails && audit.chat !== undefined ? { chat: audit.chat } : {}),
    ...(includeDetails && audit.invocation !== undefined
      ? { invocation: audit.invocation }
      : {}),
    lifecycleChangedAt: timestamps.at(-1) ?? audit.event.createdAt,
    reasonForIntervention: failure === undefined ? null : bounded(failure, 512),
    directChildren,
    ...(includeDetails
      ? {
          conversationTimeline: conversationTimeline(
            audit.event.causality.rootEventId,
            all
          )
        }
      : {}),
    causalityBoundary: audit.event.causality.parentEventId !== undefined &&
      !all.some((candidate) =>
        candidate.event.eventId === audit.event.causality.parentEventId)
      ? "missing-parent"
      : null
  };
}

function conversationTimeline(rootEventId: string, all: readonly RuntimeAudit[]) {
  return all
    .filter((candidate) =>
      candidate.event.causality.rootEventId === rootEventId &&
      (candidate.event.type === "chat.activation" ||
        candidate.event.type === "chat.dispatch" ||
        candidate.event.type === "chat.message"))
    .sort((left, right) =>
      left.event.createdAt.localeCompare(right.event.createdAt) ||
      left.event.eventId.localeCompare(right.event.eventId))
    .map((candidate) => {
      const decision = candidate.chat?.decisionReceipt;
      const budgetStop = candidate.chat?.attentionReceipts.find((receipt) =>
        receipt.reason === "turn-budget-exhausted");
      const completedAt = candidate.invocation?.completedAt ??
        candidate.execution?.completedAt;
      const startedAt = candidate.invocation?.startedAt ??
        candidate.execution?.startedAt;
      const durationMilliseconds = candidate.invocation?.durationMilliseconds ??
        (startedAt === undefined || completedAt === undefined
          ? undefined
          : Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)));
      const agentHandle = candidate.event.type === "chat.dispatch"
        ? candidate.event.targetHandleSnapshot
        : candidate.event.type === "chat.message" &&
            candidate.event.sender.kind === "agent"
          ? candidate.event.sender.handleSnapshot
          : undefined;
      const reason = candidate.execution?.status === "failed"
        ? candidate.execution.lastError
        : budgetStop?.reason ??
          (candidate.event.type === "chat.activation"
            ? candidate.event.reason
            : decision?.silenceReason);
      return {
        eventId: candidate.event.eventId,
        type: candidate.event.type,
        ...(candidate.event.causality.parentEventId === undefined
          ? {}
          : { parentEventId: candidate.event.causality.parentEventId }),
        ...(candidate.event.agentId === undefined
          ? {}
          : { agentId: candidate.event.agentId }),
        ...(agentHandle === undefined ? {} : { agentHandle }),
        ...(candidate.session?.sessionId === undefined
          ? {}
          : { sessionId: candidate.session.sessionId }),
        ...(candidate.execution === undefined
          ? {}
          : { executionId: candidate.execution.executionId }),
        status: budgetStop === undefined
          ? candidate.execution?.status ?? "recorded"
          : "stopped",
        ...(decision === undefined ? {} : { outcome: decision.speechAction }),
        ...(reason === undefined ? {} : { reason: bounded(reason, 512) }),
        createdAt: candidate.event.createdAt,
        ...(completedAt === undefined ? {} : { completedAt }),
        ...(durationMilliseconds === undefined ? {} : { durationMilliseconds })
      };
    });
}

function executionView(execution: NonNullable<RuntimeAudit["execution"]>): unknown {
  return {
    ...execution,
    firstStartedAt: execution.startedAt ?? null,
    lastAttemptAt: execution.startedAt ?? null,
    completedAt: execution.completedAt ?? null
  };
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
