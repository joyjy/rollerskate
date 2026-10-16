import { RunAdmissionStore } from "../../infrastructure/files/run-admission-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { deterministicRunId, isDeterministicRunId, parseWorkRunIntent, workDigest } from "../../modules/run/intent.js";
import { diagnostic, ValidationError } from "../../modules/validation.js";
import { startCommand } from "../command/control.js";
import { cancelStewardRun } from "../steward/control.js";
import { startStewardRunFromOwnerIntent } from "../steward/intent-control.js";
import type { RunIntentOwnerPolicy } from "../steward/admission.js";
import { controlSubscriptionView } from "../subscription/control.js";
import { registerObservationSource } from "../subscription/observation-control.js";
import { preflightRun } from "./admission.js";
import { inspectRun } from "./query.js";

export class RunStartInterruptedError extends Error {
  constructor(readonly runId: string, readonly sourceId: string, cause: unknown) {
    super(`Run admission may have taken effect: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export async function startRun(repoRoot: string, value: unknown, runtimeDirectory?: string, policy: RunIntentOwnerPolicy = {}) {
  let intent;
  try { intent = parseWorkRunIntent(value); }
  catch (error) { throw new ValidationError([diagnostic("INTENT_SCHEMA", "intent", "a supported Run intent with exact fields",
    error instanceof Error ? error.message : String(error), "Correct the intent before starting work.")]); }
  const store = new RunAdmissionStore(runtimePaths(repoRoot, runtimeDirectory).runtimeDirectory);
  if (intent.schemaVersion === "RunIntent@2") {
    const runId = deterministicRunId(intent.requestId);
    if (store.has(runId)) {
      if (store.read(runId).intentDigest !== workDigest(intent)) throw new ValidationError([diagnostic("REQUEST_CONFLICT", "requestId",
        "the original immutable intent", "This request ID is already bound to different work", "Inspect the existing Run; use a new request ID for new work.")]);
      return { status: "already_admitted", runId, run: inspectRun(repoRoot, runId, runtimeDirectory) };
    }
  }
  // Always compile from current definitions; a caller cannot submit a preflight plan as authority.
  const preflight = await preflightRun(repoRoot, intent, runtimeDirectory, policy);
  if (preflight.status !== "passed" || !preflight.plan) throw new ValidationError(preflight.diagnostics);
  const plan = preflight.plan;
  if (plan.executor === "agent") return startStewardRunFromOwnerIntent(repoRoot, plan.intent, policy, runtimeDirectory);
  try {
    store.reserve({ schemaVersion: "RunAdmission@1", runId: plan.runId, sourceId: plan.sourceId, createdAt: new Date().toISOString(),
      intent: plan.intent, intentDigest: workDigest(plan.intent), planDigest: preflight.planDigest! });
    const continuous = plan.intent.work.kind === "observe" && plan.intent.work.mode === "continuous";
    const maxWaitMilliseconds = plan.intent.maxWaitMilliseconds ?? 3600_000;
    const intervalMilliseconds = Math.min(plan.intent.checkpointMilliseconds ?? Infinity, Math.floor(maxWaitMilliseconds / 2), Math.max(5000, Math.ceil(maxWaitMilliseconds / 99_999)));
    registerObservationSource(repoRoot, { subscriptionId: plan.sourceId, title: plan.intent.title, mode: continuous ? "continuous" : "until",
      ...(plan.threadId ? { threadId: plan.threadId } : {}),
      ...(plan.chatDispatchEventId ? {chatDispatchEventId: plan.chatDispatchEventId} : {}), plugin: plan.plugin, pluginConfig: plan.pluginConfig,
      intervalMilliseconds, ...(plan.intent.checkpointMilliseconds === undefined ? {} : {checkpointMilliseconds: plan.intent.checkpointMilliseconds}), ...(continuous ? {} : {maxWaitMilliseconds, maxAttempts: Math.min(100_000, Math.ceil(maxWaitMilliseconds / intervalMilliseconds) + 1)})
    }, runtimeDirectory);
    const launch = plan.command ? await startCommand(repoRoot, { commandId: plan.runId, subscriptionId: plan.sourceId,
      ...(plan.threadId ? { threadId: plan.threadId } : {}), cwd: plan.command.cwd, argv: [plan.command.executable, ...plan.command.args] }, runtimeDirectory) : undefined;
    return { status: "admitted", runId: plan.runId, sourceId: plan.sourceId, ...(launch ? { launch } : {}),
      run: inspectRun(repoRoot, plan.runId, runtimeDirectory) };
  } catch (error) { throw new RunStartInterruptedError(plan.runId, plan.sourceId, error); }
}

export function cancelRun(repoRoot: string, runId: string, runtimeDirectory?: string) {
  if (!isDeterministicRunId(runId)) return cancelStewardRun(repoRoot, runId, runtimeDirectory);
  const admission = new RunAdmissionStore(runtimePaths(repoRoot, runtimeDirectory).runtimeDirectory).read(runId);
  controlSubscriptionView(repoRoot, admission.sourceId, "cancel", runtimeDirectory);
  return { scope: "observation", processTermination: "not_requested", run: inspectRun(repoRoot, runId, runtimeDirectory) };
}
