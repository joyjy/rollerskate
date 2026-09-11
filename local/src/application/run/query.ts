import { RunAdmissionStore } from "../../infrastructure/files/run-admission-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { isDeterministicRunId } from "../../modules/run/intent.js";
import { inspectCommand } from "../command/query.js";
import { inspectStewardRunView, listStewardRunViews } from "../steward/query.js";
import { inspectSubscriptionView } from "../subscription/query.js";
import { desktopSubscriptionDeliveries } from "../subscription/desktop-control.js";

export function inspectRun(repoRoot: string, runId: string, runtimeDirectory?: string) {
  if (!isDeterministicRunId(runId)) return inspectStewardRunView(repoRoot, runId, runtimeDirectory);
  return inspectDeterministicRun(repoRoot, runId, runtimeDirectory);
}

function inspectDeterministicRun(repoRoot: string, runId: string, runtimeDirectory?: string) {
  const admission = new RunAdmissionStore(runtimePaths(repoRoot, runtimeDirectory).runtimeDirectory).read(runId);
  const sourceId = admission.sourceId;
  const errors: string[] = [];
  const read = <T>(label: string, query: () => T): T | null => {
    try { return query(); } catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); return null; }
  };
  const source = read("source", () => inspectSubscriptionView(repoRoot, sourceId, runtimeDirectory));
  const execution = admission.intent.work.kind === "command" ? read("command", () => inspectCommand(repoRoot, runId, runtimeDirectory)) : null;
  const identityMismatch = execution !== null && execution.subscriptionId !== sourceId;
  if (identityMismatch) errors.push("Command request does not match the admitted source identity");
  const deliveries = source ? read("delivery", () => desktopSubscriptionDeliveries(repoRoot, sourceId, runtimeDirectory)) : null;
  const observation = source?.kind === "free" ? source.terminalObservation as { terminal?: string } | null : null;
  const result = identityMismatch ? "unknown" : admission.intent.work.kind === "command"
    ? execution?.state === "completed" ? execution.outcome! : "unknown"
    : observation?.terminal ?? "unknown";
  const status = result === "success" ? "succeeded" : result === "failure" ? "failed" : result === "cancelled" ? "cancelled"
    : errors.length || execution?.state === "running" && execution.pid === undefined ? "unknown"
    : source?.status === "expired" || source?.status === "blocked" ? "attention_required"
    : source?.status === "cancelled" ? "cancelled" : "running";
  return { runId, kind: admission.intent.work.kind, requestId: admission.intent.requestId, title: admission.intent.title,
    createdAt: admission.createdAt, updatedAt: execution?.completedAt ?? source?.updatedAt ?? admission.createdAt, status, result, admission, execution, source, deliveries, errors,
    deliveryStatus: admission.intent.resultDestinationRef === undefined ? "not_requested"
      : deliveries === null ? "unknown" : deliveries.length ? deliveries[0]!.status : "not_enqueued" };
}

export function listRuns(repoRoot: string, runtimeDirectory?: string, limit = 100, archived = false) {
  const agentRuns = listStewardRunViews(repoRoot, runtimeDirectory, limit, archived ? "archived" : "current");
  if (archived) return agentRuns;
  const admissions = new RunAdmissionStore(runtimePaths(repoRoot, runtimeDirectory).runtimeDirectory).list()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  return [...agentRuns, ...admissions.map(admission => inspectDeterministicRun(repoRoot, admission.runId, runtimeDirectory))]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}
