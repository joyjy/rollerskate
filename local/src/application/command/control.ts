import { fork } from "node:child_process";
import { closeSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCommandId, writeCommandReceipt } from "../../infrastructure/command/receipt.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";

export interface StartCommandInput {
  readonly commandId: string;
  readonly subscriptionId: string;
  readonly threadId?: string;
  readonly cwd: string;
  readonly argv: readonly string[];
}

/** Run admission has already validated and bound this command; this executor never registers sources. */
export async function startCommand(repoRoot: string, input: StartCommandInput, runtimeDirectory?: string) {
  assertCommandId(input.commandId);
  const root = join(runtimePaths(repoRoot, runtimeDirectory).runtimeDirectory, "commands");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = join(realpathSync(root), input.commandId);
  mkdirSync(directory, { mode: 0o700 });
  const request = { schemaVersion: "ShellCommandRequest@2", ...input, cwd: realpathSync(input.cwd) };
  writeFileSync(join(directory, "request.json"), JSON.stringify(request), { flag: "wx", mode: 0o600 });
  writeCommandReceipt(directory, { schemaVersion: "ShellCommandReceipt@1", commandId: input.commandId,
    state: "running", startedAt: new Date().toISOString() });
  const fd = openSync(join(directory, "output.log"), "wx", 0o600);
  try {
    const child = fork(fileURLToPath(new URL("../../entrypoints/command/worker.js", import.meta.url)), [], {
      detached: true, stdio: ["ignore", fd, fd, "ipc"], env: process.env
    });
    const launch = await new Promise<{ state: "started" | "failed" | "unknown"; pid: number | null }>(resolve => {
      let settled = false;
      const finish = (state: "started" | "failed" | "unknown", pid: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.connected) child.disconnect();
        child.unref();
        resolve({ state, pid });
      };
      const timer = setTimeout(() => finish("unknown", null), 5000);
      child.once("message", (value: { pid: number | null }) => finish(value.pid === null ? "failed" : "started", value.pid));
      child.once("error", () => finish("unknown", null));
      child.once("exit", () => finish("unknown", null));
      child.send({ directory, commandId: input.commandId, cwd: request.cwd, argv: input.argv }, error => {
        if (error) finish("unknown", null);
      });
    });
    return { commandId: input.commandId, subscriptionId: input.subscriptionId, threadId: input.threadId, ...launch,
      receiptPath: join(directory, "receipt.json"), logPath: join(directory, "output.log") };
  } finally { closeSync(fd); }
}
