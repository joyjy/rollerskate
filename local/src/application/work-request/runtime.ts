import { randomUUID } from "node:crypto";

import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import type { AgentRunProjection } from "../../modules/steward/state-machine.js";
import {
  attachAcceptedWorkRequest,
  type WorkRequestControlDependencies,
  type WorkRequestTarget
} from "./control.js";

export interface WorkRequestRuntimeResult {
  readonly routed: readonly string[];
  readonly recovered: readonly string[];
  readonly completed: readonly string[];
  readonly failed: readonly { readonly agentId: string; readonly error: string }[];
}

export class AgentWorkRequestRuntime {
  public readonly routeId: string;
  readonly #repoRoot: string;
  readonly #targets: readonly WorkRequestTarget[];
  readonly #dependencies: WorkRequestControlDependencies;
  readonly #settledRunIds = new Set<string>();

  public constructor(options: {
    readonly repoRoot: string;
    readonly targets: readonly WorkRequestTarget[];
    readonly routeId?: string;
    readonly dependencies?: WorkRequestControlDependencies;
  }) {
    this.#repoRoot = options.repoRoot;
    this.#targets = options.targets;
    this.#dependencies = options.dependencies ?? {};
    this.routeId = options.routeId ?? `work-route-${randomUUID()}`;
  }

  public async runCycle(): Promise<WorkRequestRuntimeResult> {
    const routed: string[] = [];
    const recovered: string[] = [];
    const completed: string[] = [];
    const failed: Array<{ agentId: string; error: string }> = [];
    for (const target of this.#targets) {
      try {
        await target.client.registerWorkRequestRoute(this.routeId);
        routed.push(...(await target.client.routedWorkRequests(this.routeId))
          .map(({ workRequestId }) => workRequestId));
        for (const request of await target.client.acceptedWorkRequestsWithoutRun()) {
          await attachAcceptedWorkRequest(
            this.#repoRoot,
            target,
            request,
            this.#dependencies
          );
          recovered.push(request.workRequestId);
        }
      } catch (error) {
        failed.push({ agentId: target.serverAgentId, error: message(error) });
      }
    }
    for (const terminal of this.#terminalWorkRequestRuns()) {
      const target = this.#targets.find(
        (candidate) => candidate.serverAgentId === terminal.targetServerAgentId
      );
      if (target === undefined) continue;
      try {
        const request = await target.client.workRequest(terminal.workRequestId);
        if (request.status === "completed" || request.runReceipt?.runId !== terminal.run.runId) {
          this.#settledRunIds.add(terminal.run.runId);
          continue;
        }
        await target.client.completeWorkRequest(request.workRequestId, {
          schemaVersion: "AgentWorkRequestResultSubmit@1",
          expectedRevision: request.revision,
          result: {
            schemaVersion: "AgentWorkRequestResult@1",
            outcome: resultOutcome(terminal.run.status),
            summary: terminal.run.terminalSummary ?? terminal.run.status,
            resultRefs: [],
            completedAt: terminal.run.updatedAt
          }
        });
        this.#settledRunIds.add(terminal.run.runId);
        completed.push(request.workRequestId);
      } catch (error) {
        failed.push({ agentId: target.serverAgentId, error: message(error) });
      }
    }
    return { routed, recovered, completed, failed };
  }

  #terminalWorkRequestRuns(): readonly {
    readonly workRequestId: string;
    readonly targetServerAgentId: string;
    readonly run: AgentRunProjection;
  }[] {
    const store = new AgentRunStore(runtimePaths(
      this.#repoRoot,
      this.#dependencies.runtimeDirectory
    ).database);
    try {
      return store.list(1_000).flatMap((run) => {
        if (this.#settledRunIds.has(run.runId) ||
          !isTerminal(run.status) || run.mandate.kind !== "workflow") return [];
        const admission = run.mandate.inputs.workRequestAdmission;
        if (!isRecord(admission) || admission.schemaVersion !== "AgentWorkRequestAdmission@1" ||
          typeof admission.workRequestId !== "string" ||
          typeof admission.targetServerAgentId !== "string") return [];
        return [{
          workRequestId: admission.workRequestId,
          targetServerAgentId: admission.targetServerAgentId,
          run
        }];
      });
    } finally {
      store.close();
    }
  }
}

function isTerminal(status: AgentRunProjection["status"]): boolean {
  return status === "succeeded" || status === "failed" ||
    status === "needs_human" || status === "cancelled";
}

function resultOutcome(status: AgentRunProjection["status"]):
  "succeeded" | "failed" | "needs-human" | "cancelled" {
  if (status === "needs_human") return "needs-human";
  if (status === "succeeded" || status === "failed" || status === "cancelled") return status;
  throw new Error(`Agent Run is not terminal: ${status}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
