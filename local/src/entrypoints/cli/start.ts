import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  runtimeLogPaths,
  runtimeProcessStatus
} from "../../application/runtime/control.js";
import { createRuntimeLogStream } from "../../bootstrap/logging.js";
import { startRuntime } from "../../bootstrap/runtime.js";
import { startUiServer } from "../console/launcher.js";
import type { AppOutput } from "./shared.js";
import { findExecutable, parseBoundedInteger } from "./shared.js";

export interface StartOptions {
  readonly noOpen: boolean;
  readonly uiPort: number;
  readonly foreground: boolean;
}

const DAEMON_READY_TIMEOUT_MILLISECONDS = 10_000;
const DAEMON_POLL_MILLISECONDS = 50;

const GRACEFUL_SHUTDOWN_SIGNALS = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP"
] as const satisfies readonly NodeJS.Signals[];

export async function runStartForeground(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  environment: NodeJS.ProcessEnv,
  output: AppOutput,
  startOptions: StartOptions
): Promise<number> {
  const codexDesktopSocketPath = environment.ROLLERSKATE_CODEX_IPC_SOCKET?.trim() || undefined;
  const codexExecutable = environment.ROLLERSKATE_CODEX_EXECUTABLE?.trim() ||
    findExecutable("codex", environment.PATH);
  const claudeCodeExecutable = environment.ROLLERSKATE_CLAUDE_CODE_EXECUTABLE?.trim() ||
    findExecutable("claude", environment.PATH);
  const kimiCodeExecutable = environment.ROLLERSKATE_KIMI_CODE_EXECUTABLE?.trim() ||
    findExecutable("kimi", environment.PATH);
  const piExecutable = environment.ROLLERSKATE_PI_EXECUTABLE?.trim() ||
    findExecutable("pi", environment.PATH);
  const paths = runtimeLogPaths(repoRoot, runtimeDirectory);
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const log = createRuntimeLogStream(paths.daemonLog);
  const sink: AppOutput = {
    write(text) {
      output.write(text);
      log.write(text);
    }
  };
  const controller = new AbortController();
  const signalHandlers = GRACEFUL_SHUTDOWN_SIGNALS.map((signal) => {
    const handler = (): void => {
      sink.write(`Rollerskate received ${signal}; stopping.\n`);
      controller.abort();
    };
    process.once(signal, handler);
    return { signal, handler };
  });
  const removeSignalHandlers = (): void => {
    for (const { signal, handler } of signalHandlers) {
      process.off(signal, handler);
    }
  };
  const closeLog = async (): Promise<void> => {
    log.end();
    await finished(log);
  };
  sink.write("Rollerskate starting. Press Ctrl-C to stop.\n");
  sink.write(`Log: ${paths.daemonLog}\n`);

  let uiClose: (() => Promise<void>) | undefined;
  try {
    const ui = await startUiServer({
      repoRoot,
      ...(runtimeDirectory === undefined ? {} : { runtimeDirectory }),
      ...(environment.ROLLERSKATE_SERVER_URL?.trim()
        ? { serverUrl: environment.ROLLERSKATE_SERVER_URL.trim() }
        : {}),
      port: startOptions.uiPort,
      signal: controller.signal,
      output: sink
    });
    uiClose = ui.close;
    sink.write(`Rollerskate UI: ${ui.url}\n`);
    if (!startOptions.noOpen) {
      openBrowser(ui.url, sink);
    }
  } catch (error) {
    sink.write(`Local UI failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    controller.abort();
    removeSignalHandlers();
    await closeLog();
    return 1;
  }

  try {
    const result = await startRuntime({
      repoRoot,
      ...(runtimeDirectory === undefined ? {} : { runtimeDirectory }),
      ...(codexExecutable === undefined ? {} : { codexExecutable }),
      ...(codexDesktopSocketPath === undefined ? {} : { codexDesktopSocketPath }),
      ...(claudeCodeExecutable === undefined ? {} : { claudeCodeExecutable }),
      ...(kimiCodeExecutable === undefined ? {} : { kimiCodeExecutable }),
      ...(piExecutable === undefined ? {} : { piExecutable }),
      ...(environment.ROLLERSKATE_VIKUNJA_URL?.trim()
        ? { vikunjaEndpoint: environment.ROLLERSKATE_VIKUNJA_URL.trim() }
        : {}),
      ...(environment.ROLLERSKATE_VIKUNJA_TOKEN?.trim()
        ? { vikunjaToken: environment.ROLLERSKATE_VIKUNJA_TOKEN.trim() }
        : {}),
      environment: roomAgentEnvironment(environment),
      output: sink
    }, controller.signal);
    sink.write(`Rollerskate stopped after ${result.cycles} Runtime cycle(s).\n`);
    return 0;
  } catch (error) {
    sink.write(
      `Rollerskate failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  } finally {
    removeSignalHandlers();
    try {
      if (uiClose !== undefined) {
        await uiClose();
      }
    } finally {
      await closeLog();
    }
  }
}

export async function runStartDaemon(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  environment: NodeJS.ProcessEnv,
  output: AppOutput,
  startOptions: StartOptions,
  launcher: string | undefined
): Promise<number> {
  const paths = runtimeLogPaths(repoRoot, runtimeDirectory);
  const existing = runtimeProcessStatus(repoRoot, runtimeDirectory);
  if (existing.running) {
    output.write([
      `Rollerskate is already running with pid ${existing.state!.pid}.`,
      `Log: ${paths.daemonLog}`
    ].join("\n") + "\n");
    return 0;
  }

  if (launcher === undefined || launcher.trim() === "") {
    throw new Error("cannot resolve the Rollerskate CLI launcher");
  }
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [
    launcher,
    ...(runtimeDirectory === undefined ? [] : ["--runtime", runtimeDirectory]),
    "start",
    "--foreground",
    ...(startOptions.noOpen ? ["--no-open"] : []),
    "--ui-port",
    String(startOptions.uiPort)
  ], {
    cwd: repoRoot,
    detached: true,
    env: environment,
    stdio: "ignore",
    windowsHide: true
  });
  if (child.pid === undefined) {
    throw new Error("failed to spawn the Rollerskate daemon");
  }
  const childPid = child.pid;
  let childExited = false;
  let childError: Error | undefined;
  child.once("exit", () => {
    childExited = true;
  });
  child.once("error", (error) => {
    childError = error;
  });
  child.unref();

  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MILLISECONDS;
  while (Date.now() < deadline) {
    const status = runtimeProcessStatus(repoRoot, runtimeDirectory);
    if (status.running) {
      const pid = status.state!.pid;
      output.write(pid === childPid
        ? [
          "Rollerskate started in the background.",
          `PID: ${pid}`,
          `UI: http://localhost:${startOptions.uiPort}/console/`,
          `Log: ${paths.daemonLog}`
        ].join("\n") + "\n"
        : [
          `Rollerskate is already running with pid ${pid}.`,
          `Log: ${paths.daemonLog}`
        ].join("\n") + "\n");
      return 0;
    }
    if (childError !== undefined) {
      throw new Error(`failed to spawn the Rollerskate daemon: ${childError.message}`);
    }
    if (childExited) {
      throw new Error(
        `Rollerskate daemon exited before readiness; inspect ${paths.daemonLog}`
      );
    }
    await delay(DAEMON_POLL_MILLISECONDS);
  }

  try {
    process.kill(childPid, "SIGTERM");
  } catch {
    // The child may have exited between the final readiness check and cleanup.
  }
  throw new Error(
    `Rollerskate daemon did not become ready within ${DAEMON_READY_TIMEOUT_MILLISECONDS}ms; ` +
    `inspect ${paths.daemonLog}`
  );
}

export async function stopRuntimeDaemon(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  output: AppOutput
): Promise<number> {
  const status = runtimeProcessStatus(repoRoot, runtimeDirectory);
  if (!status.running) {
    output.write("Rollerskate is already stopped.\n");
    return 0;
  }
  const pid = status.state!.pid;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error &&
      error.code === "ESRCH") {
      output.write("Rollerskate is already stopped.\n");
      return 0;
    }
    throw error;
  }

  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MILLISECONDS;
  while (Date.now() < deadline) {
    if (!runtimeProcessStatus(repoRoot, runtimeDirectory).running) {
      output.write(`Rollerskate stopped (pid ${pid}).\n`);
      return 0;
    }
    await delay(DAEMON_POLL_MILLISECONDS);
  }
  throw new Error(`Rollerskate pid ${pid} did not stop within 10000ms`);
}

export function roomAgentEnvironment(
  environment: NodeJS.ProcessEnv
): Readonly<Record<string, string>> {
  const home = environment.HOME?.trim();
  if (home === undefined || home === "") throw new Error("HOME is required to start Rollerskate");
  const path = environment.PATH?.trim();
  if (path === undefined || path === "") throw new Error("PATH is required to start Rollerskate");
  return {
    HOME: home,
    PATH: path,
    ...(environment.CODEX_HOME === undefined ? {} : { CODEX_HOME: environment.CODEX_HOME })
  };
}

export function parseStartOptions(argv: readonly string[]): StartOptions {
  let noOpen = false;
  let uiPort = 4300;
  let foreground = false;
  let offset = 0;
  while (offset < argv.length) {
    const arg = argv[offset];
    if (arg === "--no-open") {
      noOpen = true;
      offset += 1;
    } else if (arg === "--foreground") {
      foreground = true;
      offset += 1;
    } else if (arg === "--ui-port") {
      const value = argv[offset + 1];
      if (value === undefined || value.trim() === "") {
        throw new Error("--ui-port requires a port number");
      }
      uiPort = parseBoundedInteger(value, "--ui-port", 1, 65_535);
      offset += 2;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return { noOpen, uiPort, foreground };
}

function openBrowser(url: string, output: AppOutput): void {
  const platform = process.platform;
  const child = platform === "darwin"
    ? spawn("open", [url], { stdio: "ignore", detached: true })
    : platform === "win32"
      ? spawn("cmd", ["/c", "start", url], { stdio: "ignore", detached: true })
      : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  child.on("error", () => {
    output.write(`Warning: could not open browser; visit ${url} manually.\n`);
  });
}
