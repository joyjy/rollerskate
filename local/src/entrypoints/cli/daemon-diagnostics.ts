import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface DaemonStderr { readonly fd: number; readonly path: string; close(): void; }

/** Open the detached child's private stderr before spawn; the child inherits its own fd. */
export function openDaemonStderr(logsDirectory: string): DaemonStderr {
  const directory = lstatSync(logsDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) {
    throw new Error("Daemon logs directory must be private and regular");
  }
  const path = join(logsDirectory, "daemon-stderr.log");
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT |
    constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || (file.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && file.uid !== process.getuid())) {
      throw new Error("Daemon stderr must be a private regular file owned by this user");
    }
  } catch (error) { closeSync(fd); throw error; }
  let closed = false;
  return {fd, path, close() { if (!closed) { closeSync(fd); closed = true; } }};
}

/** Diagnostic observers only. Node retains its default fatal-exception behavior. */
export function installDaemonDiagnostics(options: { readonly stderrPath?: string } = {}): () => void {
  // Only our inherited regular diagnostic file is eligible; never truncate terminals/pipes.
  const boundStderr = (): void => {
    if (options.stderrPath === undefined) return;
    try {
      const expected = lstatSync(options.stderrPath);
      const file = fstatSync(2);
      if (expected.isFile() && !expected.isSymbolicLink() && file.isFile() &&
        file.ino === expected.ino && file.dev === expected.dev &&
        (file.mode & 0o077) === 0 && file.size > 5 * 1024 * 1024) ftruncateSync(2, 0);
    } catch { /* Diagnostic retention must not affect Runtime health. */ }
  };
  boundStderr();
  const retention = setInterval(boundStderr, 10_000);
  retention.unref();
  const record = (value: Record<string, unknown>): void => {
    try {
      boundStderr();
      const body = Buffer.from(`${JSON.stringify(value)}\n`);
      let offset = 0;
      while (offset < body.length) offset += writeSync(2, body, offset, body.length - offset);
    } catch { /* Never change the daemon's exit behavior because diagnostics failed. */ }
  };
  const onException = (error: Error, origin: NodeJS.UncaughtExceptionOrigin): void => {
    record({event: "daemon.uncaught_exception", pid: process.pid, at: new Date().toISOString(), origin,
      error: redact(String(error.message ?? error)).slice(0, 16_384),
      stack: redact(String(error.stack ?? "")).slice(0, 32_768)});
  };
  const onExit = (code: number): void => {
    record({event: "daemon.exit", pid: process.pid, at: new Date().toISOString(), code});
  };
  process.on("uncaughtExceptionMonitor", onException);
  process.on("exit", onExit);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    clearInterval(retention);
    process.off("uncaughtExceptionMonitor", onException);
    process.off("exit", onExit);
  };
}

function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s"'<>]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{20,})\b/gu, "[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;"']+/giu, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[REDACTED]@");
}
