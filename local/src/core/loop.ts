import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export interface LoopState {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly status: "running" | "stopped" | "failed";
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly runtimeDirectory: string;
  readonly agentNames: readonly string[];
  readonly routeIds: readonly string[];
  readonly cycles: number;
  readonly paused: boolean;
  readonly error?: string;
}

export interface LoopStatus {
  readonly running: boolean;
  readonly state?: LoopState;
}

export interface LoopPhase {
  readonly scope: string;
  readonly bindingId?: string;
  readonly run: (signal: AbortSignal) => Promise<Readonly<Record<string, unknown>> | undefined>;
}

export interface LoopOptions {
  readonly statePath: string;
  readonly runtimeDirectory: string;
  readonly agentNames: readonly string[];
  readonly routeIds: readonly string[];
  readonly phases: readonly LoopPhase[];
  readonly paused: () => boolean;
  readonly pollMilliseconds?: number;
  readonly output?: { readonly write: (text: string) => void };
}

export interface LoopResult {
  readonly cycles: number;
  readonly stopped: true;
}

export async function runLoop(
  options: LoopOptions,
  signal: AbortSignal
): Promise<LoopResult> {
  const pollMilliseconds = bounded(options.pollMilliseconds ?? 1_000, 50, 60_000, "poll");
  const startedAt = new Date().toISOString();
  let cycles = 0;
  const release = claimLoop(options.statePath, state(options, startedAt, cycles, false));
  try {
    options.output?.write(
      `Runtime loop ready: ${options.agentNames.length} Agent(s), ` +
      `${options.routeIds.length} Route(s).\n`
    );
    main: while (!signal.aborted) {
      const paused = options.paused();
      if (paused) {
        writeState(options.statePath, state(options, startedAt, cycles, true));
        await waitForNextCycle(pollMilliseconds, signal);
        continue;
      }
      for (const phase of options.phases) {
        if (signal.aborted) break main;
        try {
          const activity = await phase.run(signal);
          if (activity !== undefined) {
            options.output?.write(`${JSON.stringify(activity)}\n`);
          }
        } catch (error) {
          if (signal.aborted) break main;
          writePhaseFailure(options.output, phase, error);
        }
      }
      cycles += 1;
      writeState(options.statePath, state(options, startedAt, cycles, false));
      await waitForNextCycle(pollMilliseconds, signal);
    }
    writeState(options.statePath, {
      ...state(options, startedAt, cycles, options.paused()),
      status: "stopped"
    });
    return { cycles, stopped: true };
  } catch (error) {
    writeState(options.statePath, {
      ...state(options, startedAt, cycles, options.paused()),
      status: "failed",
      error: message(error)
    });
    throw error;
  } finally {
    release();
  }
}

export function readLoopStatus(path: string): LoopStatus {
  if (!existsSync(path)) return { running: false };
  assertPrivateRegularFile(path);
  const stored = JSON.parse(readFileSync(path, "utf8")) as LoopState & {
    readonly roomIds?: readonly string[];
  };
  const state: LoopState = {
    ...stored,
    routeIds: stored.routeIds ?? stored.roomIds ?? []
  };
  if (state.schemaVersion !== 1 || !Number.isInteger(state.pid)) {
    throw new Error("Runtime loop state file has an unsupported schema");
  }
  return {
    running: state.status === "running" && processExists(state.pid),
    state
  };
}

function state(
  options: LoopOptions,
  startedAt: string,
  cycles: number,
  paused: boolean
): LoopState {
  return {
    schemaVersion: 1,
    pid: process.pid,
    status: "running",
    startedAt,
    updatedAt: new Date().toISOString(),
    runtimeDirectory: options.runtimeDirectory,
    agentNames: options.agentNames,
    routeIds: options.routeIds,
    cycles,
    paused
  };
}

async function waitForNextCycle(
  pollMilliseconds: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return;
  try {
    await delay(pollMilliseconds, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

function claimLoop(path: string, initialState: LoopState): () => void {
  const existing = readLoopStatus(path);
  if (existing.running) {
    throw new Error(`Runtime loop is already running with pid ${existing.state?.pid}`);
  }
  const lockPath = `${path}.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
    writeFileSync(descriptor, `${process.pid}\n`, "utf8");
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error &&
      error.code === "EEXIST")) {
      throw error;
    }
    const lockPid = Number(readFileSync(lockPath, "utf8").trim());
    if (Number.isInteger(lockPid) && processExists(lockPid)) {
      throw new Error(`Runtime loop is already running with pid ${lockPid}`);
    }
    if (existsSync(lockPath)) unlinkSync(lockPath);
    descriptor = openSync(lockPath, "wx", 0o600);
    writeFileSync(descriptor, `${process.pid}\n`, "utf8");
  }
  try {
    writeState(path, initialState);
  } catch (error) {
    closeSync(descriptor);
    if (existsSync(lockPath)) unlinkSync(lockPath);
    throw error;
  }
  return () => {
    closeSync(descriptor);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  };
}

function writeState(path: string, value: LoopState): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("Runtime loop state file must not be a symlink");
  }
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function writePhaseFailure(
  output: LoopOptions["output"],
  phase: LoopPhase,
  error: unknown
): void {
  output?.write(`${JSON.stringify({
    type: "runtime.cycle_failed",
    scope: phase.scope,
    ...(phase.bindingId === undefined ? {} : { bindingId: phase.bindingId }),
    error: message(error)
  })}\n`);
}

function assertPrivateRegularFile(path: string): void {
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
    throw new Error("Runtime loop state path must be a regular file");
  }
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error("Runtime loop state file must not be accessible by group or others");
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error &&
      error.code === "EPERM";
  }
}

function bounded(value: number, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}
