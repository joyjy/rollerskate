import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import type { AgentRunProjection } from "../../modules/steward/state-machine.js";

const RUN_LIMIT = 1_000;
const HOT_RUN_LIMIT = 100;
const REFRESH_INTERVAL_MILLISECONDS = 1_000;

export interface RunProgressSnapshot {
  readonly schemaVersion: "RunProgressSnapshot@1";
  readonly runId: string;
  readonly rootEventId: string;
  readonly ownerRequestId: string;
  readonly status: "active" | "waiting" | "awaiting_orchestrator" |
    "awaiting_source" | "succeeded" | "failed" | "needs_human" | "cancelled";
  readonly mandate: {
    readonly kind: "objective" | "workflow";
    readonly label: string;
    readonly workflowRef: string | null;
  };
  readonly stewardAgentId: string;
  readonly progress: {
    readonly currentStepId: string | null;
    readonly currentExecutionId: string | null;
    readonly steps: number;
    readonly maxSteps: number;
    readonly maxDepth: number;
  };
  readonly terminalSummaryAvailable: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunProgressIndex {
  readonly schemaVersion: "RunProgressIndex@1";
  readonly runs: readonly {
    readonly runId: string;
    readonly status: RunProgressSnapshot["status"];
    readonly progressPath: string;
    readonly updatedAt: string;
  }[];
  readonly runsTruncated: boolean;
}

export function buildRunProgressSnapshot(run: AgentRunProjection): RunProgressSnapshot {
  return {
    schemaVersion: "RunProgressSnapshot@1",
    runId: run.runId,
    rootEventId: run.rootEventId,
    ownerRequestId: run.ownerRequestId,
    status: run.status,
    mandate: {
      kind: run.mandate.kind,
      label: run.mandate.kind === "workflow"
        ? run.mandate.workflowRef
        : label(run.mandate.objective),
      workflowRef: run.mandate.kind === "workflow"
        ? run.mandate.workflowRef
        : null
    },
    stewardAgentId: run.stewardAgentId,
    progress: {
      currentStepId: run.activeStepId ?? null,
      currentExecutionId: run.activeExecutionId ?? null,
      steps: run.stepCount,
      maxSteps: run.maxSteps,
      maxDepth: run.maxDepth
    },
    terminalSummaryAvailable: run.terminalSummary !== undefined,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt
  };
}

export class RunProgressProjector {
  readonly #paths: ReturnType<typeof runtimePaths>;
  readonly #fingerprints = new Map<string, string>();
  readonly #entries = new Map<string, RunProgressIndex["runs"][number]>();
  #initialized = false;
  #historicalTruncated = false;
  #nextRefreshAt = 0;

  public constructor(repoRoot: string, runtimeDirectory?: string) {
    this.#paths = runtimePaths(repoRoot, runtimeDirectory);
  }

  public refresh(now = Date.now()): RunProgressIndex | undefined {
    if (now < this.#nextRefreshAt) return undefined;
    this.#nextRefreshAt = now + REFRESH_INTERVAL_MILLISECONDS;
    ensurePrivateDirectory(this.#paths.runProgressRoot);
    const store = new AgentRunStore(this.#paths.database);
    try {
      const limit = this.#initialized ? HOT_RUN_LIMIT : RUN_LIMIT;
      const runs = store.list(limit);
      if (!this.#initialized) this.#historicalTruncated = runs.length === RUN_LIMIT;
      let changed = !this.#initialized;
      for (const run of runs) changed = this.#project(run) || changed;
      this.#initialized = true;
      if (!changed) return undefined;
      const indexOverflow = this.#entries.size > RUN_LIMIT;
      const entries = [...this.#entries.values()]
        .sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          right.runId.localeCompare(left.runId))
        .slice(0, RUN_LIMIT);
      const retained = new Set(entries.map((entry) => entry.runId));
      for (const runId of this.#entries.keys()) {
        if (!retained.has(runId)) this.#entries.delete(runId);
      }
      for (const runId of this.#fingerprints.keys()) {
        if (!retained.has(runId)) this.#fingerprints.delete(runId);
      }
      const index: RunProgressIndex = {
        schemaVersion: "RunProgressIndex@1",
        runs: entries,
        runsTruncated: this.#historicalTruncated || indexOverflow
      };
      writePrivateJsonIfChanged(this.#paths.progress, index);
      return index;
    } finally {
      store.close();
    }
  }

  #project(run: AgentRunProjection): boolean {
    const fingerprint = `${run.version}:${run.updatedAt}`;
    const directory = join(this.#paths.runProgressRoot, run.runId);
    const progressPath = join(directory, "progress.json");
    if (this.#fingerprints.get(run.runId) === fingerprint) return false;
    ensurePrivateDirectory(directory);
    writePrivateJsonIfChanged(progressPath, buildRunProgressSnapshot(run));
    this.#fingerprints.set(run.runId, fingerprint);
    this.#entries.set(run.runId, {
      runId: run.runId,
      status: run.status,
      progressPath,
      updatedAt: run.updatedAt
    });
    return true;
  }
}

export function writePrivateJsonIfChanged(path: string, value: unknown): boolean {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("Run progress file must not be a symlink");
  }
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return true;
}

function ensurePrivateDirectory(path: string): void {
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) {
      throw new Error("Run progress path must be a regular directory");
    }
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  chmodSync(path, 0o700);
}

function label(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 160 ? compact : `${compact.slice(0, 159).trimEnd()}…`;
}
