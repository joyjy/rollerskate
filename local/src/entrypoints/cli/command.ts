import { inspectCommand } from "../../application/command/query.js";

/** Historical receipt readback only; new work is admitted through Run. */
export function runCommandCommand(repoRoot: string, args: readonly string[], output: { write: (text: string) => void }, runtimeDirectory?: string) {
  if (args[0] !== "inspect" || args.length !== 2) throw new Error("command start is closed; use run preflight/start. Historical receipts: command inspect <id>");
  output.write(`${JSON.stringify(inspectCommand(repoRoot, args[1]!, runtimeDirectory), null, 2)}\n`);
  return 0;
}
