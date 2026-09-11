import { spawn } from "node:child_process";
import { writeCommandReceipt, type CommandReceipt } from "../../infrastructure/command/receipt.js";

/** One invocation, inherited caller authority, no retry or Runtime command executor. */
export function runCommandWorker(message: { directory: string; commandId: string; cwd: string; argv: string[] }): void {
  const { directory, commandId, cwd, argv } = message;
  const startedAt = new Date().toISOString();
  let running: CommandReceipt = { schemaVersion: "ShellCommandReceipt@1", commandId, state: "running", startedAt };
  let settled = false;
  let acknowledged = false;
  const acknowledge = (pid: number | null): void => {
    if (acknowledged) return;
    acknowledged = true;
    if (process.connected) process.send?.({ pid }, () => { if (process.connected) process.disconnect(); });
  };
  const finish = (exitCode: number | null, signal: string | null, error?: string): void => {
    if (settled) return;
    settled = true;
    writeCommandReceipt(directory, { ...running, state: "completed", completedAt: new Date().toISOString(),
      exitCode, signal, outcome: signal !== null ? "cancelled" : exitCode === 0 ? "success" : "failure",
      ...(error === undefined ? {} : { error: error.slice(0, 2048) }) });
    acknowledge(null);
  };
  try {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: process.env, stdio: ["ignore", "inherit", "inherit"] });
    child.once("spawn", () => {
      running = { ...running, pid: child.pid! };
      writeCommandReceipt(directory, running);
      acknowledge(child.pid!);
    });
    child.once("error", error => finish(null, null, error.message));
    child.once("close", (code, signal) => finish(code, signal));
  } catch (error) { finish(null, null, String(error)); }
}
