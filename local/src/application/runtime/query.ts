import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { readLoopStatus, type LoopState } from "../../core/loop.js";
import { LoopControlStore } from "../../infrastructure/files/loop-control-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { runtimeArtifactRevision } from "../../infrastructure/runtime/revision.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import {
  countRecoverableRuntimeWork,
  readRuntimeWorkloadFacts
} from "../../infrastructure/sqlite/runtime-operations-query.js";
import {
  listRuntimeFailures,
  type RuntimeFailureSummary
} from "./failure-query.js";
import {
  workloadStatus,
  type RuntimeWorkloadStatus
} from "./workload-query.js";

export type RuntimeProcessState = "running" | "paused" | "degraded" | "stopped";
export type RuntimeLoopPhase = "idle" | "in_cycle";

export interface RuntimeControlAvailability {
  readonly pause: boolean;
  readonly resume: boolean;
  readonly recover: boolean;
}

export interface RuntimeControlResultView {
  readonly kind: "pause" | "resume" | "recover";
  readonly status: "succeeded" | "failed";
  readonly message: string;
  readonly recovered?: number;
  readonly leftUnknown?: number;
  readonly failed?: number;
}

export interface RuntimeOperationsView {
  readonly status: RuntimeProcessState;
  readonly statusReason: string;
  readonly recommendedAction: string;
  readonly statusSince: string;
  readonly version: string;
  readonly runtimeRoot: string;
  readonly workspaceRoot: string;
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly schemaVersion: number | null;
  readonly runtimeRevision: {
    readonly expected: string;
    readonly running: string | null;
    readonly matchesExpected: boolean;
  };
  readonly consoleAddress: string;
  readonly lastRefreshedAt: string;
  readonly stale: boolean;
  readonly loop: {
    readonly phase: RuntimeLoopPhase;
    readonly totalCycles: number;
    readonly lastCycleStartAt: string | null;
    readonly lastCycleEndAt: string | null;
    readonly lastCycleDurationMs: number | null;
    readonly currentPhaseSummary: string | null;
  };
  readonly controls: RuntimeControlAvailability;
  readonly workload: RuntimeWorkloadStatus;
  readonly failures: readonly RuntimeFailureSummary[];
  readonly controlResult: RuntimeControlResultView | null;
}

interface ObservableLoopState extends LoopState {
  readonly phase?: RuntimeLoopPhase;
  readonly cycleStartedAt?: string;
  readonly lastCycleStartAt?: string;
  readonly lastCycleEndAt?: string;
  readonly lastCycleDurationMs?: number;
  readonly currentPhaseSummary?: string;
}

export function runtimeOperationsView(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  consoleAddress: string,
  controlResult: RuntimeControlResultView | null = null,
  now: () => Date = () => new Date()
): RuntimeOperationsView {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const refreshedAt = now().toISOString();
  const loop = readLoopStatus(paths.loopState);
  const state = loop.state as ObservableLoopState | undefined;
  const expectedRuntimeRevision = runtimeArtifactRevision(repoRoot);
  const paused = new LoopControlStore(paths.loopControl).paused();
  const stale = loop.running && state !== undefined &&
    Date.parse(refreshedAt) - Date.parse(state.updatedAt) > 15_000;
  const status: RuntimeProcessState = !loop.running
    ? "stopped"
    : stale || state?.status === "failed"
      ? "degraded"
      : paused
        ? "paused"
        : "running";
  const recoverable = countRecoverableRuntimeWork(paths.database);
  const controls: RuntimeControlAvailability = {
    pause: loop.running && !paused,
    resume: loop.running && paused,
    recover: !loop.running && recoverable > 0
  };
  return {
    status,
    statusReason: statusReason(status, stale, state),
    recommendedAction: recommendedAction(status, controls),
    statusSince: state?.updatedAt ?? refreshedAt,
    version: packageVersion(repoRoot),
    runtimeRoot: paths.runtimeDirectory,
    workspaceRoot: workspaceRoot(paths.database),
    pid: loop.running ? state?.pid ?? null : null,
    startedAt: state?.startedAt ?? null,
    schemaVersion: databaseSchemaVersion(paths.database),
    runtimeRevision: {
      expected: expectedRuntimeRevision,
      running: state?.runtimeRevision ?? null,
      matchesExpected: loop.running && state?.runtimeRevision === expectedRuntimeRevision
    },
    consoleAddress,
    lastRefreshedAt: refreshedAt,
    stale,
    loop: {
      phase: loop.running && !paused && state?.phase === "in_cycle"
        ? "in_cycle"
        : "idle",
      totalCycles: state?.cycles ?? 0,
      lastCycleStartAt: state?.lastCycleStartAt ?? state?.cycleStartedAt ?? null,
      lastCycleEndAt: state?.lastCycleEndAt ?? state?.updatedAt ?? null,
      lastCycleDurationMs: state?.lastCycleDurationMs ?? null,
      currentPhaseSummary: state?.phase === "in_cycle"
        ? state.currentPhaseSummary ?? null
        : null
    },
    controls,
    workload: workloadStatus(readRuntimeWorkloadFacts(paths.database), refreshedAt),
    failures: listRuntimeFailures(repoRoot, runtimeDirectory),
    controlResult
  };
}

function statusReason(
  status: RuntimeProcessState,
  stale: boolean,
  state: ObservableLoopState | undefined
): string {
  if (status === "stopped") {
    return state?.status === "failed"
      ? `Runtime process stopped after failure: ${state.error ?? "unknown error"}`
      : "Runtime process is not running.";
  }
  if (status === "degraded") {
    return stale
      ? "Runtime heartbeat exceeded the 15 second freshness window."
      : `Runtime loop reported failure: ${state?.error ?? "unknown error"}`;
  }
  if (status === "paused") {
    return "Durable pause is active; no new loop work is claimed.";
  }
  return "Runtime process is alive and its heartbeat is fresh.";
}

function recommendedAction(
  status: RuntimeProcessState,
  controls: RuntimeControlAvailability
): string {
  if (controls.recover) return "Recover interrupted durable work before restarting Runtime.";
  if (status === "stopped") return "Start Runtime when it should resume processing work.";
  if (status === "degraded") return "Inspect failures and daemon diagnostics before intervening.";
  if (status === "paused") return "Resume when new work may be claimed.";
  return "No immediate action required.";
}

function workspaceRoot(database: string): string {
  if (!existsSync(database)) return "No registered workspace";
  const connection = new DatabaseSync(database, { readOnly: true });
  const store = new LocalFoundationStore(connection, { migrate: false });
  try {
    return store.foundation()?.workspacePath ?? "No registered workspace";
  } finally {
    store.close();
    connection.close();
  }
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
