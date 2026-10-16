import { readFileSync, statSync } from "node:fs";
import { preflightRun } from "../../application/run/admission.js";
import { startRun, cancelRun, RunStartInterruptedError } from "../../application/run/control.js";
import { inspectRun, listRuns } from "../../application/run/query.js";
import { diagnostic, ValidationError } from "../../application/run/admission.js";
import { compileGitLabPipelineRunIntent } from "../../application/run/gitlab-pipeline-source.js";
import { runStewardCommand } from "./run.js";
import { validateRunInput } from "../../application/run/validation.js";

const HELP = [
  "scripts/rs run validate <intent.json>  validate format only; does not authorize or execute work",
  "scripts/rs run preflight|start <intent.json> [--authorize-network]",
  "scripts/rs run preflight|start --id <request-id> --title <title> [--return-to codex-desktop:<UUID>|rs-chat:<dispatch-event-id>] [--timeout <seconds> [--checkpoint <seconds>]] --cwd <absolute-dir> -- <executable> [args...]",
  "scripts/rs run preflight|start --id <request-id> --title <title> [--return-to codex-desktop:<UUID>|rs-chat:<dispatch-event-id>] [--timeout <seconds> [--checkpoint <seconds>]] --source <plugin-ref> --input <business-input.json> [--continuous]",
  "scripts/rs run pipeline preflight|start --id <request-id> --project <project> --pipeline <pipeline-id> --expected-sha <40|64-char-sha> --return-to codex-desktop:<UUID>|rs-chat:<dispatch-event-id> --timeout <seconds> [--checkpoint <seconds>]",
  "scripts/rs run preflight|start --id <request-id> --objective <text> --acceptance <text> [--acceptance <text>...] [--workspace <workspace-ref>] [--effect read|change] [--steward <handle|ref>] [--worker <handle|ref>] [--return-to destination:<id>]",
  "scripts/rs run inspect|trace|cancel <run-id>",
  "scripts/rs run list [--limit <count>] [--archived]",
  "Preflight executes no work or network probe. Command execution inherits caller permissions; timeout/cancel only stops observation."
].join("\n");

export async function runWorkCommand(repoRoot: string, args: readonly string[], output: { write: (text: string) => void }, runtimeDirectory?: string): Promise<number> {
  const [command, ...rest] = args;
  const write = (value: unknown) => output.write(`${JSON.stringify(value, null, 2)}\n`);
  if (command === "--help" && rest.length === 0) { output.write(`${HELP}\n`); return 0; }
  if (command === "validate") {
    try {
      if (rest.length !== 1) throw new Error("run validate requires one intent JSON file");
      write(validateRunInput(readJson(rest[0]!)));
      return 0;
    } catch (error) {
      write({status: "invalid", scope: "format", error: error instanceof Error ? error.message : String(error)});
      return 2;
    }
  }
  if (command === "pipeline") {
    try {
      const [operation, ...pipelineArgs] = rest;
      if (operation !== "preflight" && operation !== "start") throw new Error(HELP);
      return submitRun(repoRoot, operation, compileGitLabPipelineRunIntent(repoRoot, parsePipelineSubmission(pipelineArgs), runtimeDirectory), write, runtimeDirectory);
    } catch (error) {
      return writeSubmissionError(error, write);
    }
  }
  if (command === "start" || command === "preflight") {
    try {
      const { intent, authorizeNetwork } = parseSubmission(rest);
      return submitRun(repoRoot, command, intent, write, runtimeDirectory, authorizeNetwork ? { authorizeNetwork: true } : {});
    } catch (error) {
      return writeSubmissionError(error, write);
    }
  }
  if (command === "inspect" || command === "trace" || command === "cancel") {
    if (rest.length !== 1) throw new Error(`run ${command} requires exactly one Run id`);
    write(command === "cancel" ? cancelRun(repoRoot, rest[0]!, runtimeDirectory) : inspectRun(repoRoot, rest[0]!, runtimeDirectory));
    return 0;
  }
  if (command === "list") {
    const archived = rest.includes("--archived");
    const options = rest.filter(arg => arg !== "--archived");
    if ((options.length !== 0 && (options.length !== 2 || options[0] !== "--limit")) || rest.filter(arg => arg === "--archived").length > 1) throw new Error(HELP);
    const limit = options.length ? Number(options[1]) : 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be 1-1000");
    write(listRuns(repoRoot, runtimeDirectory, limit, archived));
    return 0;
  }
  return runStewardCommand(repoRoot, args, output, runtimeDirectory);
}

async function submitRun(
  repoRoot: string,
  command: "preflight" | "start",
  intent: unknown,
  write: (value: unknown) => void,
  runtimeDirectory?: string,
  policy: { readonly authorizeNetwork?: boolean } = {}
): Promise<number> {
  try {
    if (command === "preflight") {
      const result = await preflightRun(repoRoot, intent, runtimeDirectory, policy);
      write(result);
      return result.status === "passed" ? 0 : 2;
    }
    const result = await startRun(repoRoot, intent, runtimeDirectory, policy);
    write(result);
    return "launch" in result && result.launch?.state === "unknown" ? 3 : "launch" in result && result.launch?.state === "failed" ? 1 : 0;
  } catch (error) {
    return writeSubmissionError(error, write);
  }
}

function writeSubmissionError(error: unknown, write: (value: unknown) => void): number {
  if (error instanceof RunStartInterruptedError) {
    write({status: "unknown", runId: error.runId, sourceId: error.sourceId, error: error.message,
      next: "Inspect this Run. Do not change request ID or retry the underlying command without resolving its outcome."});
    return 3;
  }
  write({ schemaVersion: "RunPreflight@1", status: "failed", diagnostics: error instanceof ValidationError ? error.diagnostics
    : [diagnostic("RUN_ADMISSION_FAILED", "intent", "a valid admissible Run request", error instanceof Error ? error.message : String(error),
      "Correct the reported input or environment; inspect the exact request ID before retrying an interrupted start.")], unverified: [] });
  return 2;
}

function readJson(path: string): unknown {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 65_536) throw new Error("Intent/input must be a regular JSON file up to 65536 bytes");
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseSubmission(args: readonly string[]): { intent: unknown; authorizeNetwork: boolean } {
  if (args[0] && !args[0].startsWith("--")) {
    if (args.length !== 1 && (args.length !== 2 || args[1] !== "--authorize-network")) throw new Error(HELP);
    return { intent: readJson(args[0]), authorizeNetwork: args[1] === "--authorize-network" };
  }
  const separator = args.indexOf("--");
  const flags = separator < 0 ? args : args.slice(0, separator);
  const options = new Map<string, string>();
  const acceptance: string[] = [];
  let authorizeNetwork = false;
  let continuous = false;
  for (let index = 0; index < flags.length; index++) {
    const key = flags[index]!;
    if (key === "--continuous") {
      if (continuous) throw new Error("duplicate --continuous");
      continuous = true; continue;
    }
    if (key === "--authorize-network") {
      if (authorizeNetwork) throw new Error("duplicate --authorize-network");
      authorizeNetwork = true; continue;
    }
    const value = flags[++index];
    if (!["--id", "--title", "--return-to", "--timeout", "--checkpoint", "--cwd", "--source", "--input", "--objective", "--acceptance", "--workspace", "--effect", "--steward", "--worker"].includes(key) ||
      value === undefined || (key !== "--acceptance" && options.has(key))) throw new Error(`Invalid or duplicate Run option: ${key}`);
    if (key === "--acceptance") acceptance.push(value); else options.set(key, value);
  }
  const required = (key: string) => { const value = options.get(key); if (!value) throw new Error(`${key} is required`); return value; };
  const destination = options.get("--return-to");
  if (options.has("--objective")) {
    if (continuous || separator >= 0 || ["--cwd", "--source", "--input", "--timeout", "--checkpoint", "--title"].some(key => options.has(key))) throw new Error("Agent and deterministic work options cannot be mixed");
    return { authorizeNetwork, intent: { schemaVersion: "RunIntent@1", requestId: required("--id"), objective: required("--objective"),
      acceptance, terminalEvidence: acceptance, contextRefs: [], ...(destination ? {resultDestinationRef: destination} : {}),
      ...(options.has("--steward") ? {stewardRef: agentRef(required("--steward"))} : {}),
      ...(options.has("--worker") ? {workerRef: agentRef(required("--worker"))} : {}),
      ...(options.has("--workspace") ? {workspaceRef: required("--workspace")} : {}),
      ...(options.has("--effect") ? {desiredEffect: required("--effect")} : {}) } };
  }
  if (acceptance.length || ["--workspace", "--effect", "--steward", "--worker"].some(key => options.has(key))) throw new Error("Agent options require --objective");
  const command = separator >= 0;
  if (continuous && (command || options.has("--timeout") || options.has("--checkpoint"))) throw new Error("--continuous requires observation without --timeout or --checkpoint");
  if (options.has("--checkpoint") && !options.has("--timeout")) throw new Error("--checkpoint requires an explicit --timeout total budget");
  if (command && (options.has("--source") || options.has("--input"))) throw new Error("Command and observation options cannot be mixed");
  if (!command && options.has("--cwd")) throw new Error("Probe cwd is owned by the source; --cwd is for commands");
  return { authorizeNetwork, intent: { schemaVersion: "RunIntent@2", requestId: required("--id"), title: required("--title"),
    ...(destination ? { resultDestinationRef: destination } : {}), ...(continuous ? {} : {maxWaitMilliseconds: Number(options.get("--timeout") ?? "3600") * 1000}),
    ...(options.has("--checkpoint") ? {checkpointMilliseconds: Number(options.get("--checkpoint")) * 1000} : {}),
    work: command ? { kind: "command", executable: args[separator + 1], args: args.slice(separator + 2), cwd: required("--cwd") }
      : { kind: "observe", mode: continuous ? "continuous" : "until", sourceRef: required("--source"), input: readJson(required("--input")) } } };
}

function parsePipelineSubmission(args: readonly string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    const value = args[++index];
    if (!["--id", "--project", "--pipeline", "--expected-sha", "--return-to", "--timeout", "--checkpoint"].includes(key) || value === undefined || options.has(key)) {
      throw new Error(`Invalid or duplicate GitLab pipeline option: ${key}`);
    }
    options.set(key, value);
  }
  const required = (key: string) => {
    const value = options.get(key);
    if (!value) throw new Error(`${key} is required for GitLab pipeline observation`);
    return value;
  };
  const pipeline = Number(required("--pipeline"));
  const timeoutSeconds = Number(required("--timeout"));
  const checkpointSeconds = options.has("--checkpoint") ? Number(options.get("--checkpoint")) : undefined;
  return {
    requestId: required("--id"),
    project: required("--project"),
    pipelineId: pipeline,
    expectedSha: required("--expected-sha"),
    resultDestinationRef: required("--return-to"),
    timeoutSeconds,
    ...(checkpointSeconds === undefined ? {} : {checkpointSeconds})
  };
}

function agentRef(value: string): string {
  return value.startsWith("agent:") || value.startsWith("principal:") ? value : `agent:${value}`;
}
