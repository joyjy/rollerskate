import { runtimePaths } from "../../infrastructure/runtime/config.js";
import {
  readRuntimeWorkloadFacts,
  type RuntimeWorkloadFacts
} from "../../infrastructure/sqlite/runtime-operations-query.js";

export type RuntimeWorkloadState = "idle" | "running" | "queued" | "retrying";

export interface RuntimeWorkloadStatus {
  readonly state: RuntimeWorkloadState;
  readonly ready: number;
  readonly running: number;
  readonly retrying: number;
  readonly total: number;
  readonly asOf: string;
}

export function runtimeWorkloadStatus(
  repoRoot: string,
  runtimeDirectory?: string,
  now: () => Date = () => new Date()
): RuntimeWorkloadStatus {
  const facts = readRuntimeWorkloadFacts(
    runtimePaths(repoRoot, runtimeDirectory).database
  );
  return workloadStatus(facts, now().toISOString());
}

export function workloadStatus(
  facts: RuntimeWorkloadFacts,
  asOf: string
): RuntimeWorkloadStatus {
  const ready = facts.readyExecutions +
    facts.pendingDeliveries +
    facts.pendingScheduledRuns;
  const running = facts.runningExecutions +
    facts.deliveringDeliveries +
    facts.runningScheduledRuns;
  const retrying = facts.retryingExecutions + facts.retryingDeliveries;
  const total = ready + running + retrying;
  return {
    state: running > 0
      ? "running"
      : ready > 0
        ? "queued"
        : retrying > 0
          ? "retrying"
          : "idle",
    ready,
    running,
    retrying,
    total,
    asOf
  };
}
