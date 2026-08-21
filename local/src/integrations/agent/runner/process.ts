import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface RunnerProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
}

export function spawnRunnerProcess(options: RunnerProcessOptions): ChildProcessWithoutNullStreams {
  return spawn(options.executable, [...options.args], {
    shell: false,
    cwd: options.workingDirectory,
    env: { ...options.environment },
    stdio: ["pipe", "pipe", "pipe"]
  });
}

export function collectBoundedStderr(
  child: ChildProcessWithoutNullStreams,
  maxBytes: number = 16_384
): () => string {
  const chunks: Buffer[] = [];
  let bytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    if (bytes >= maxBytes) return;
    const retained = chunk.subarray(0, maxBytes - bytes);
    chunks.push(Buffer.from(retained));
    bytes += retained.length;
  });
  return () => Buffer.concat(chunks).toString("utf8").trim();
}

export async function stopRunnerProcess(
  child: ChildProcessWithoutNullStreams,
  options: { readonly closeStdin?: boolean; readonly graceMilliseconds?: number } = {}
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (options.closeStdin === true && !child.stdin.destroyed) {
    child.stdin.end();
    if (await waitForExit(child, options.graceMilliseconds ?? 5_000)) return;
  }
  child.kill("SIGTERM");
  if (await waitForExit(child, 1_000)) return;
  child.kill("SIGKILL");
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  milliseconds: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", exited);
      resolve(false);
    }, milliseconds);
    const exited = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", exited);
  });
}
