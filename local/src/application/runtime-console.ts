import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { LocalAgentRegistryStore } from "./agent/registry-store.js";
import { LoopControlStore } from "./loop-control-store.js";
import { runtimeStatus } from "./loop-control.js";
import { runtimePaths } from "./runtime-config.js";
import { PollSubscriptionStore } from "../capabilities/subscription/store.js";
import type { RuntimeAudit } from "../core/runtime/store.js";
import { RuntimeStore } from "../core/runtime/store.js";

export interface RuntimeControlResultView {
  readonly kind: "pause" | "resume" | "recover";
  readonly status: "succeeded" | "failed";
  readonly message: string;
  readonly recovered?: number;
  readonly leftUnknown?: number;
  readonly failed?: number;
}

export function runtimeConsoleView(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  consoleAddress: string,
  controlResult: RuntimeControlResultView | null = null
): unknown {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const refreshedAt = new Date().toISOString();
  const loop = runtimeStatus(repoRoot, runtimeDirectory);
  const runtime = new RuntimeStore(paths.database);
  const subscriptions = new PollSubscriptionStore(paths.database);
  const agents = new LocalAgentRegistryStore(paths.database);
  try {
    const audits = runtime.audits(1_000);
    const sessions = runtime.sessions(1_000);
    const destinations = runtime.destinations(1_000);
    const subscriptionItems = subscriptions.list();
    const agentItems = agents.list();
    const state = loop.state;
    const paused = new LoopControlStore(paths.loopControl).paused();
    const stale = state?.status === "running" &&
      Date.parse(refreshedAt) - Date.parse(state.updatedAt) > 15_000;
    const status = !loop.running || state?.status === "failed" || stale
      ? "degraded"
      : paused
        ? "paused"
        : "running";
    const workspaceRoots = [...new Set(agentItems.map((agent) => agent.workspacePath))];
    const lifecycle = audits.map(deriveLifecycle);
    const executionCounts = loop.activity?.executions ?? {};
    const resultCounts = loop.activity?.resultEvents ?? {};
    const deliveryCounts = loop.activity?.deliveries ?? {};
    return {
      status,
      statusReason: status === "degraded"
        ? !loop.running
          ? "Core loop process is not running."
          : "Core loop state exceeded the 15 second freshness window."
        : status === "paused"
          ? "Durable pause is active; no new loop work is claimed."
          : "Core loop process is alive and its state is fresh.",
      recommendedAction: status === "degraded"
        ? "Inspect scripts/rs status and the daemon log, then restart the Runtime if needed."
        : status === "paused"
          ? "Resume when new work may be claimed."
          : "No immediate action required.",
      statusSince: state?.updatedAt ?? refreshedAt,
      version: packageVersion(repoRoot),
      runtimeRoot: paths.runtimeDirectory,
      workspaceRoot: workspaceRoots.length === 0
        ? "No registered workspace"
        : workspaceRoots.length === 1
          ? workspaceRoots[0]
          : `${workspaceRoots.length} registered workspaces`,
      pid: state?.pid ?? null,
      startedAt: state?.startedAt ?? null,
      schemaVersion: databaseSchemaVersion(paths.database),
      consoleAddress,
      lastRefreshedAt: refreshedAt,
      stale,
      loop: {
        state: status === "degraded" ? "degraded" : paused ? "paused" : "idle",
        totalCycles: state?.cycles ?? 0,
        lastCycleStartAt: null,
        lastCycleEndAt: state?.updatedAt ?? null,
        lastCycleDurationMs: null,
        nextCycleAt: null,
        inCycle: false,
        currentPhaseSummary: null
      },
      workload: {
        queuedExecutions: executionCounts.queued ?? 0,
        runningExecutions: executionCounts.running ?? 0,
        retryWaitExecutions: executionCounts.retry_wait ?? 0,
        failedExecutions: executionCounts.failed ?? 0,
        agentResultSucceeded: resultCounts.succeeded ?? 0,
        agentResultFailed: resultCounts.failed ?? 0,
        pendingDeliveries: deliveryCounts.pending ?? 0,
        retryingDeliveries: deliveryCounts.retry_wait ?? 0,
        failedDeliveries: deliveryCounts.failed ?? 0
      },
      recentIsolations: isolationViews(audits),
      agents: {
        registered: agentItems.length,
        callable: agentItems.filter((agent) => agent.status === "active").length,
        unavailable: agentItems.filter((agent) => agent.status !== "active").length
      },
      events: {
        lastReceivedAt: audits[0]?.event.createdAt ?? null,
        waiting: lifecycle.filter((item) => item === "queued" || item === "retrying").length,
        running: lifecycle.filter((item) => item === "running").length,
        succeeded: lifecycle.filter((item) =>
          item === "succeeded" || item === "delivered").length,
        failed: lifecycle.filter((item) =>
          item === "failed" || item === "delivery_failed").length
      },
      sessions: {
        total: sessions.length,
        lastResumedAt: sessions
          .filter((session) => session.updatedAt !== session.createdAt)
          .map((session) => session.updatedAt)
          .sort()
          .at(-1) ?? null,
        mismatched: 0
      },
      subscriptions: {
        active: subscriptionItems.filter((item) => item.status === "active").length,
        paused: subscriptionItems.filter((item) => item.status === "paused").length,
        expired: subscriptionItems.filter((item) => item.status === "expired").length,
        failedUnknown: subscriptionItems.filter((item) => item.latestError !== undefined).length
      },
      destinations: {
        available: destinations.length,
        pending: deliveryCounts.pending ?? 0,
        retrying: deliveryCounts.retry_wait ?? 0,
        failed: deliveryCounts.failed ?? 0
      },
      capabilities: [
        { name: "poll-subscription", version: "1", available: true }
      ],
      integrations: integrationViews(agentItems, state?.roomIds ?? [], loop.running),
      recentLogs: [],
      controlResult
    };
  } finally {
    agents.close();
    subscriptions.close();
    runtime.close();
  }
}

function deriveLifecycle(
  audit: RuntimeAudit
): "queued" | "running" | "retrying" | "succeeded" | "failed" | "delivery_pending" |
  "delivered" | "delivery_failed" {
  if (audit.execution.status === "queued") return "queued";
  if (audit.execution.status === "running") return "running";
  if (audit.execution.status === "retry_wait") return "retrying";
  if (audit.execution.status === "failed" || audit.resultEvent?.outcome === "failed") return "failed";
  if (audit.resultEvent === undefined) return "running";
  if (audit.deliveries.length === 0) return "succeeded";
  const statuses = audit.deliveries.map(({ delivery }) => delivery.status);
  if (statuses.some((status) => status === "failed")) return "delivery_failed";
  if (statuses.every((status) => status === "delivered")) return "delivered";
  return "delivery_pending";
}

function isolationViews(audits: readonly RuntimeAudit[]): unknown[] {
  return audits.flatMap((audit) => {
    const values: unknown[] = [];
    if (audit.execution.status === "failed" && audit.execution.lastError !== undefined) {
      values.push({
        occurredAt: audit.execution.updatedAt,
        eventId: audit.event.eventId,
        executionId: audit.execution.executionId,
        boundedError: audit.execution.lastError.slice(0, 512),
        loopContinued: true
      });
    }
    for (const { delivery } of audit.deliveries) {
      if (delivery.status === "failed" && delivery.lastError !== undefined) {
        values.push({
          occurredAt: delivery.updatedAt,
          eventId: audit.event.eventId,
          destinationId: delivery.destinationId,
          boundedError: delivery.lastError.slice(0, 512),
          loopContinued: true
        });
      }
    }
    return values;
  }).slice(0, 20);
}

function integrationViews(
  agents: readonly { readonly name: string; readonly client: string; readonly status: string }[],
  roomIds: readonly string[],
  running: boolean
): unknown[] {
  const adapters = agents.map((agent) => ({
    name: `${agent.client}:${agent.name}`,
    kind: "adapter",
    status: running && agent.status === "active" ? "connected" : "disconnected",
    lastSuccessAt: null,
    failureReason: agent.status === "active" ? null : `Agent status is ${agent.status}`
  }));
  return [
    ...adapters,
    {
      name: "matrix",
      kind: "ingress",
      status: running && roomIds.length > 0 ? "connected" : "disconnected",
      lastSuccessAt: null,
      failureReason: roomIds.length > 0 ? null : "No active Matrix binding"
    }
  ];
}

function databaseSchemaVersion(path: string): number | null {
  if (!existsSync(path)) return null;
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare(
      "SELECT value FROM schema_meta WHERE key = 'schema_version'"
    ).get() as { value: string } | undefined;
    return row === undefined ? null : Number(row.value);
  } finally {
    database.close();
  }
}

function packageVersion(repoRoot: string): string {
  const value = JSON.parse(readFileSync(`${repoRoot}/local/package.json`, "utf8")) as {
    version?: unknown;
  };
  return typeof value.version === "string" ? value.version : "unknown";
}
