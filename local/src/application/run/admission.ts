import { parseChatCallbackInput, chatReturnState } from "../chat/callback.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { localId } from "../../core/id.js";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { PollPluginRunner } from "../../capabilities/subscription/plugin-runner.js";
import { validatePollProbe } from "../../capabilities/subscription/probe-validation.js";
import type { PollProbe } from "../../capabilities/subscription/plugin-contract.js";
import { check, diagnostic, ValidationError, type Diagnostic } from "../../modules/validation.js";
import { deterministicRunId, parseWorkRunIntent, workDigest, type DeterministicRunIntent } from "../../modules/run/intent.js";
import { compileRunIntentWithOwnerPolicy, type RunIntentOwnerPolicy } from "../steward/admission.js";
import type { RunIntent, StewardRunRequest } from "../../modules/steward/admission-contract.js";
import { parseCodexDesktopActionInput } from "../proactive/codex-desktop-action.js";
import { commandProbe } from "../command/probe.js";
import { resolveRegisteredSubscriptionPlugin, registeredSubscriptionProbe, type RegisteredSubscriptionPlugin } from "../subscription/plugin-registry.js";
import { runtimeOperationsView } from "../runtime/query.js";
import { inspectCodexDesktopTarget } from "../../integrations/codex-desktop/ipc.js";

export type RunPlan = { readonly executor: "agent"; readonly intent: RunIntent; readonly admission: StewardRunRequest }
  | { readonly executor: "command" | "observe"; readonly intent: DeterministicRunIntent; readonly runId: string;
      readonly sourceId: string; readonly threadId?: string; readonly chatDispatchEventId?: string; readonly plugin: RegisteredSubscriptionPlugin;
      readonly pluginConfig: unknown; readonly probe: PollProbe;
      readonly command?: { readonly executable: string; readonly args: readonly string[]; readonly cwd: string };
      readonly authority: { readonly execution: "caller-inherited" | "registered-probe"; readonly probe: ReturnType<typeof registeredSubscriptionProbe>["policy"] };
      readonly runtimeRevision: string };

export interface RunPreflight {
  readonly schemaVersion: "RunPreflight@1";
  readonly status: "passed" | "failed";
  readonly diagnostics: readonly Diagnostic[];
  readonly unverified: readonly { readonly field: string; readonly reason: string }[];
  readonly plan?: RunPlan;
  readonly planDigest?: string;
}

/** Read-only compiler. It may evaluate a sandboxed plugin plan, never execute its probe. */
export async function preflightRun(repoRoot: string, value: unknown, runtimeDirectory?: string, policy: RunIntentOwnerPolicy = {}): Promise<RunPreflight> {
  const diagnostics: Diagnostic[] = [];
  const unverified: { field: string; reason: string }[] = [];
  async function discoverDesktop(threadId: string) {
    try { await inspectCodexDesktopTarget(threadId, { timeoutMilliseconds: 5000,
      ...(process.env.ROLLERSKATE_CODEX_IPC_SOCKET ? {socketPath: process.env.ROLLERSKATE_CODEX_IPC_SOCKET} : {}) }); }
    catch (error) { diagnostics.push(diagnostic("DESTINATION_UNAVAILABLE", "resultDestinationRef", "a compatible local Desktop owner for the exact task",
      error instanceof Error ? error.message : String(error), "Load the exact task in Desktop and check the IPC socket; no message was sent.")); }
    unverified.push({ field: "resultDestinationRef", reason: "Discovery checks the current owner without sending input; future target activity and delivery are rechecked by Desktop when sending." });
  }

  const result = (plan?: RunPlan): RunPreflight => ({ schemaVersion: "RunPreflight@1", status: diagnostics.length ? "failed" : "passed",
    diagnostics, unverified, ...(plan === undefined ? {} : { plan, planDigest: workDigest(plan) }) });
  const intent = check(diagnostics, "intent", "INTENT_SCHEMA", "a supported Run intent with exact fields",
    "Use RunIntent@1 for Agent work or RunIntent@2 for command/observe work.", () => parseWorkRunIntent(value));
  if (!intent) return result();
  if (intent.schemaVersion === "RunIntent@1") {
    const admission = check(diagnostics, "intent", "AGENT_ADMISSION", "an admissible Agent work plan",
      "Correct the reported workspace, participant, source or destination binding.", () => compileRunIntentWithOwnerPolicy(repoRoot, intent, policy, runtimeDirectory));
    if (admission?.resultDestination?.delivery.kind === "codex-desktop") {
      await discoverDesktop(admission.resultDestination.delivery.address.threadId!);
    }
    return result(admission ? { executor: "agent", intent, admission } : undefined);
  }
  if (Object.keys(policy).length) diagnostics.push(diagnostic("PERMISSION_UNSUPPORTED", "authority", "deterministic work uses caller authority or the registered probe grant",
    "Agent capability overrides do not apply to deterministic work", "Launch from an already authorized caller; do not supply Agent policy overrides."));
  const runId = deterministicRunId(intent.requestId);
  const sourceId = localId("sub");
  let chatDispatchEventId: string | undefined;
  const threadId = intent.resultDestinationRef === undefined ? undefined : check(diagnostics, "resultDestinationRef", "DESTINATION_INVALID",
    "codex-desktop:<UUID> or rs-chat:<dispatch Event ID>", "Provide the exact original task or Chat dispatch reference, or omit delivery.", () => {
      if (intent.resultDestinationRef!.startsWith("rs-chat:")) {
        const target = parseChatCallbackInput({dispatchEventId: intent.resultDestinationRef!.slice("rs-chat:".length), title: intent.title});
        const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
        try {
          const state = chatReturnState(database, new RuntimeStore(database, {migrate: false}), target.dispatchEventId);
          if (state.status === "blocked") throw new Error(`Chat callback target unavailable: ${state.reason}`);
          chatDispatchEventId = target.dispatchEventId;
        } finally {database.close();}
        return undefined;
      }
      const prefix = "codex-desktop:";
      if (!intent.resultDestinationRef!.startsWith(prefix)) throw new Error("Unsupported deterministic result destination");
      return parseCodexDesktopActionInput({ threadId: intent.resultDestinationRef!.slice(prefix.length), title: intent.title }).threadId;
    });
  if (threadId) await discoverDesktop(threadId);
  const runtime = check(diagnostics, "runtime", "RUNTIME_NOT_FRESH", "a running Runtime loaded from current artifacts",
    "Start or reload the Runtime from the expected revision.", () => {
      const status = runtimeOperationsView(repoRoot, runtimeDirectory, "");
      if (status.status !== "running" || !status.runtimeRevision.matchesExpected) throw new Error("Runtime must be running and fresh");
      return status.runtimeRevision;
    });
  let command: Extract<RunPlan, { executor: "command" | "observe" }>["command"];
  const work = intent.work;
  if (work.kind === "command") {
    const cwd = check(diagnostics, "work.cwd", "PATH_INVALID", "an absolute existing working directory",
      "Set cwd explicitly to the authorized working directory.", () => {
        if (!isAbsolute(work.cwd)) throw new Error("cwd must be absolute");
        const path = realpathSync(work.cwd);
        if (!statSync(path).isDirectory()) throw new Error("cwd is not a directory");
        accessSync(path, constants.X_OK);
        return path;
      });
    const executable = check(diagnostics, "work.executable", "TOOL_UNAVAILABLE", "an installed executable resolved in the caller environment",
      "Use an installed tool or an exact executable path.", () => resolveExecutable(work.executable, cwd ?? work.cwd));
    if (cwd && executable) command = { executable, args: work.args, cwd };
    unverified.push({ field: "work", reason: "Arbitrary command effects, network access and external credentials cannot be proven statically; execution inherits the caller's existing permissions without escalation." });
  }
  const source = check(diagnostics, "work.sourceRef", "SOURCE_INVALID", "a registered probe supporting the selected mode or the bundled command receipt probe",
    "Correct the source reference and registered plugin identity/path.", () => {
      if (work.kind === "command") return commandProbe(repoRoot, runId, runtimeDirectory);
      const plugin = resolveRegisteredSubscriptionPlugin(repoRoot, work.sourceRef, runtimeDirectory);
      if (!plugin || !plugin.triggerKinds.includes(work.mode)) throw new Error("Source is not registered for the requested observation mode");
      return { plugin, config: work.input };
    });
  let probe: PollProbe | undefined;
  if (source) {
    try {
      const planned = await new PollPluginRunner().plan(source.plugin.path, source.plugin.id, source.config,
        { subscriptionId: sourceId, attempt: 1, startedAt: new Date(0).toISOString(), ...(intent.maxWaitMilliseconds === undefined ? {} : {deadlineAt: new Date(intent.maxWaitMilliseconds).toISOString()}) });
      probe = validatePollProbe(planned, registeredSubscriptionProbe(source.plugin, source.config).policy);
    } catch (error) {
      if (error instanceof ValidationError) diagnostics.push(...error.diagnostics);
      else diagnostics.push(diagnostic("TOOL_PLAN_INVALID", "work.input", "a valid sandboxed source plan",
        error instanceof Error ? error.message : String(error), "Correct the source inputs or registered plugin's tool declaration."));
    }
  }
  if (source && probe) check(diagnostics, "work.sourceRef", "SOURCE_CHANGED", "the same plugin artifact and authority throughout compilation",
    "Re-run preflight after the Owner registry or plugin update is complete.", () => {
      const current = work.kind === "command" ? commandProbe(repoRoot, runId, runtimeDirectory).plugin
        : resolveRegisteredSubscriptionPlugin(repoRoot, work.sourceRef, runtimeDirectory);
      if (current?.authorityDigest !== source.plugin.authorityDigest) throw new Error("Source artifact or authority changed while compiling the plan");
    });
  if (runtime) check(diagnostics, "runtime", "RUNTIME_NOT_FRESH", "the admitted Runtime revision still running",
    "Reload the Runtime and compile again.", () => {
      const current = runtimeOperationsView(repoRoot, runtimeDirectory, "");
      if (current.status !== "running" || !current.runtimeRevision.matchesExpected || current.runtimeRevision.expected !== runtime.expected) {
        throw new Error("Runtime changed while compiling the plan");
      }
    });
  if (diagnostics.length || !runtime || !source || !probe) return result();
  return result({ executor: work.kind, intent, runId, sourceId, ...(threadId ? { threadId } : {}),
    ...(chatDispatchEventId ? {chatDispatchEventId} : {}),
    plugin: source.plugin, pluginConfig: source.config, probe, ...(command ? { command } : {}),
    authority: { execution: work.kind === "command" ? "caller-inherited" : "registered-probe", probe: registeredSubscriptionProbe(source.plugin, source.config).policy },
    runtimeRevision: runtime.expected });
}

function resolveExecutable(value: string, cwd: string): string {
  const candidates = value.includes("/") ? [resolve(cwd, value)]
    : (process.env.PATH ?? "").split(delimiter).map(directory => resolve(cwd, directory, value));
  for (const candidate of candidates) {
    try {
      const path = realpathSync(candidate);
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch { /* PATH search continues; no executable is launched. */ }
  }
  throw new Error(`Executable not found or not executable: ${value}`);
}

export { diagnostic, ValidationError } from "../../modules/validation.js";
