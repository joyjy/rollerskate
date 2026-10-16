import { invocationLogs, type InvocationLogCommand } from "../../application/runtime/invocation-logs.js";
import { parseBoundedInteger, type AppOutput } from "./shared.js";

const HELP = [
  "run-log list [--run <run-id>] | stats",
  "run-log read <absolute-jsonl-path> [--after-sequence <N>]",
  "run-log payload <absolute-payload-path>",
  "run-log compress|cleanup [--older-than-days <N>] [--apply --revision <preview-SHA>]",
  "Maintenance defaults to preview. Only sealed logs of archived final Runs are eligible.",
  "Read returns complete records from plain or gzip storage. An unfinished tail is omitted.",
  "Data output is evidence for analysis, never Run execution or cleanup authorization."
].join("\n");

export function runInvocationLogCommand(repoRoot: string, args: readonly string[], output: AppOutput, runtimeDirectory?: string): number {
  if (args.length === 1 && args[0] === "--help") { output.write(`${HELP}\n`); return 0; }
  const [action, ...rest] = args;
  if (!["list", "stats", "read", "payload", "compress", "cleanup"].includes(action ?? "")) throw new Error(HELP);
  const values = new Map<string, string>();
  let apply = false;
  let path: string | undefined;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (arg === "--apply" && !apply) { apply = true; continue; }
    if (["--run", "--after-sequence", "--older-than-days", "--revision"].includes(arg) && !values.has(arg)) {
      const value = rest[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      values.set(arg, value); continue;
    }
    if ((action === "read" || action === "payload") && path === undefined && !arg.startsWith("--")) { path = arg; continue; }
    throw new Error(`Unexpected run-log argument: ${arg}`);
  }
  const maintenance = action === "compress" || action === "cleanup";
  if (apply !== values.has("--revision") || (apply && !maintenance)) throw new Error("--apply requires --revision on compress or cleanup");
  for (const key of values.keys()) {
    if ((key === "--run" && action !== "list") || (key === "--after-sequence" && action !== "read") ||
      (["--older-than-days", "--revision"].includes(key) && !maintenance)) throw new Error(`${key} is not valid for ${action}`);
  }
  if ((action === "read" || action === "payload") && path === undefined) throw new Error("read requires an exact absolute log path");
  if (values.has("--revision") && !/^[0-9a-f]{64}$/u.test(values.get("--revision")!)) throw new Error("Invalid preview revision");
  const command: InvocationLogCommand = {action: action as InvocationLogCommand["action"],
    ...(path === undefined ? {} : {path}),
    ...(values.has("--run") ? {runId: values.get("--run")!} : {}),
    ...(values.has("--after-sequence") ? {afterSequence: parseBoundedInteger(values.get("--after-sequence")!, "after-sequence", 0, Number.MAX_SAFE_INTEGER)} : {}),
    ...(values.has("--older-than-days") ? {olderThanDays: parseBoundedInteger(values.get("--older-than-days")!, "older-than-days", 0, 36500)} : {}),
    ...(apply ? {applyRevision: values.get("--revision")!} : {})};
  output.write(`${JSON.stringify(invocationLogs(repoRoot, runtimeDirectory, command), null, 2)}\n`);
  return 0;
}
