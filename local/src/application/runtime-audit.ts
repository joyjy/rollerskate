import { runtimePaths } from "./runtime-config.js";
import { RuntimeStore, type RuntimeAudit } from "../core/runtime/store.js";

export function runtimeTrace(
  repoRoot: string,
  eventId: string,
  runtimeDirectory?: string
): unknown {
  const store = new RuntimeStore(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const audit = store.audit(eventId);
    if (audit === undefined) throw new Error(`Event not found: ${eventId}`);
    return auditView(audit, store.audits(1_000));
  } finally {
    store.close();
  }
}

export function runtimeTraces(
  repoRoot: string,
  runtimeDirectory?: string
): unknown[] {
  const store = new RuntimeStore(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const audits = store.audits(1_000);
    return audits.map((audit) => auditView(audit, audits));
  } finally {
    store.close();
  }
}

function auditView(audit: RuntimeAudit, all: readonly RuntimeAudit[]): unknown {
  const event = {
    ...audit.event,
    ...("prompt" in audit.event
      ? {
          prompt: bounded(audit.event.prompt, 1_024),
          boundedPromptSummary: bounded(audit.event.prompt, 160)
        }
      : {})
  };
  const resultEvent = audit.resultEvent === undefined
    ? undefined
    : {
        ...audit.resultEvent,
        ...("output" in audit.resultEvent && audit.resultEvent.output !== undefined
          ? { output: bounded(audit.resultEvent.output, 4_096) }
          : {}),
        ...("error" in audit.resultEvent && audit.resultEvent.error !== undefined
          ? { error: bounded(audit.resultEvent.error, 4_096) }
          : {})
      };
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
    lifecycleChangedAt: timestamps.at(-1) ?? audit.event.createdAt,
    reasonForIntervention: failure === undefined ? null : bounded(failure, 512),
    directChildren,
    causalityBoundary: audit.event.causality.parentEventId !== undefined &&
      !all.some((candidate) =>
        candidate.event.eventId === audit.event.causality.parentEventId)
      ? "missing-parent"
      : null
  };
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
