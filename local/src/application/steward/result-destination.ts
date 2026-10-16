import {join} from "node:path";
import type { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import type { CodexPushSourceResolver } from "../../integrations/codex-desktop/push.js";
import { stableContractJson } from "../../modules/steward/contract-codec.js";
import type { RuntimeStore } from "../../core/runtime/store.js";
import type { AgentRunProjection } from "../../modules/steward/state-machine.js";
import { isStewardOrchestrated } from "../../modules/steward/caller-contract.js";
import { vikunjaRunResultDelivery } from
  "../../integrations/vikunja/task-destination.js";
import type { RunResultDestination } from
  "../../modules/steward/caller-contract.js";

export function terminalRunResultDelivery(
  destination: RunResultDestination,
  input: {
    readonly runId: string;
    readonly cycleId?: string;
    readonly status: "succeeded" | "failed" | "needs_human" | "cancelled";
    readonly summary: string;
  }
): {
  readonly kind: "vikunja-task" | "server-topic" | "codex-desktop";
  readonly address: Readonly<Record<string, string>>;
  readonly payload: Readonly<Record<string, unknown>>;
} {
  const heading = `Rollerskate Run ${input.runId}${input.cycleId === undefined
    ? ""
    : ` cycle ${input.cycleId}`}: ${input.status}`;
  const detailedBody = [
    heading,
    "",
    input.summary
  ].join("\n");
  if (destination.delivery.kind === "vikunja-task") {
    const delivery = vikunjaRunResultDelivery(destination);
    return {
      kind: delivery.kind,
      address: delivery.address,
      payload: {
        schemaVersion: "VikunjaTaskComment@1",
        runId: input.runId,
        body: detailedBody
      }
    };
  }
  if (destination.delivery.kind === "codex-desktop") {
    const address = destination.delivery.address;
    if (Object.keys(address).some(key => !["threadId", "agentId"].includes(key)) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(address.threadId ?? "") ||
      (address.agentId !== undefined && text(address.agentId) === undefined)) {
      throw new Error("Steward codex-desktop destination address is invalid");
    }
    return { kind: "codex-desktop", address, payload: { body: detailedBody } };
  }
  if (destination.delivery.kind === "server-topic") {
    const address = destination.delivery.address;
    if (Object.keys(address).length !== 2 ||
      text(address.topicId) === undefined || text(address.agentId) === undefined) {
      throw new Error("Steward server-topic destination address is invalid");
    }
    return {
      kind: "server-topic",
      address: { topicId: address.topicId!, agentId: address.agentId! },
      payload: {
        body: [heading, "", "Inspect the Run Workspace for bounded details and trace."].join(
          "\n"
        )
      }
    };
  }
  throw new Error(
    `Steward terminal result destination is unsupported: ${destination.delivery.kind}`
  );
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function enqueueTerminalRunDelivery(runtime: RuntimeStore, run: AgentRunProjection,
  status: "succeeded" | "failed" | "needs_human" | "cancelled", summary: string, at: string): void {
  if (!isStewardOrchestrated(run.orchestratorBinding) || run.orchestratorBinding.resultDestination === undefined) return;
  const destination = run.orchestratorBinding.resultDestination;
  const delivery = terminalRunResultDelivery(destination, {
    runId: run.runId, ...(run.activeCycleId === undefined ? {} : {cycleId: run.activeCycleId}), status, summary
  });
  runtime.enqueueHostDeliveryInTransaction({
    originId: `steward-run:${run.runId}:${run.activeCycleId ?? "run"}:terminal`,
    destinationId: destination.destinationId, kind: delivery.kind, address: delivery.address, payload: delivery.payload, at
  });
}

/** Compile exactly the same support matrix before any Run work is admitted. */
export function validateRunResultDestination(destination: RunResultDestination): void {
  terminalRunResultDelivery(destination, {runId: "admission", status: "succeeded", summary: ""});
}

export function runResultTaskUrl(destination: RunResultDestination | undefined): string | undefined {
  return destination?.delivery.kind === "vikunja-task" ? vikunjaRunResultDelivery(destination).taskUrl : undefined;
}

/** Outbound Desktop content must come from the bound durable Run/cycle, never arbitrary payload. */
export function resolveStewardRunPush(runs: AgentRunStore,
  {delivery, destination}: Parameters<CodexPushSourceResolver>[0],
  location?: {readonly repoRoot: string; readonly runtimeDirectory: string}
): ReturnType<CodexPushSourceResolver> {
  if (delivery.origin.kind !== "host" || !delivery.origin.id.startsWith("steward-run:")) return undefined;
  const match = /^steward-run:([^:]+):([^:]+):terminal$/u.exec(delivery.origin.id);
  if (!match) throw new Error("Invalid Steward Desktop source identity");
  const run = runs.requireProjection(match[1]!);
  const binding = run.orchestratorBinding;
  if (!isStewardOrchestrated(binding) || !binding.resultDestination) throw new Error("Steward Desktop binding is missing");
  const bound = binding.resultDestination;
  const cycle = match[2] === "run" ? undefined : runs.cycle(match[2]!);
  if (match[2] !== "run" && cycle?.runId !== run.runId) throw new Error("Steward Desktop cycle identity mismatch");
  const terminal = cycle ?? run;
  if (!["succeeded", "failed", "needs_human", "cancelled"].includes(terminal.status) || terminal.terminalSummary === undefined) {
    throw new Error("Steward Desktop source is not terminal");
  }
  const expected = terminalRunResultDelivery(bound, {runId: run.runId, ...(cycle ? {cycleId: cycle.cycleId} : {}),
    status: terminal.status as "succeeded" | "failed" | "needs_human" | "cancelled", summary: terminal.terminalSummary});
  const same = (a: unknown, b: unknown) => stableContractJson(a) === stableContractJson(b);
  if (bound.destinationId !== delivery.destinationId || destination.destinationId !== bound.destinationId ||
    destination.kind !== "codex-desktop" || expected.kind !== "codex-desktop" ||
    !same(destination.address, expected.address) || !same(delivery.payload, expected.payload)) {
    throw new Error("Steward Desktop Delivery differs from the immutable Run binding");
  }
  const quote = (value: string): string => "'" + value.replace(/'/gu,"'\\''") + "'";
  const read = location === undefined ? "" : "\nRead: " + [join(location.repoRoot,"scripts/rs"),"--runtime",location.runtimeDirectory,"run","inspect",run.runId].map(quote).join(" ");
  return {body: String(expected.payload.body) + read, source: {kind: "steward-run", runId: run.runId,
    ...(cycle ? {cycleId: cycle.cycleId} : {}), status: terminal.status, rootEventId: run.rootEventId}};
}
