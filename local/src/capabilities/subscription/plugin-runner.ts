import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CommandPollProbe,
  CommandProbeResult,
  EnvironmentValue,
  HttpPollProbe,
  HttpProbeResult,
  PollObservation,
  PollPluginContext,
  PollProbe,
  PollProbeResult
} from "./plugin-contract.js";
import type { ProbeExecutionPolicy } from "./model.js";

import { parsePollProbe, validatePollProbe } from "./probe-validation.js";

interface PluginHostRequest {
  readonly pluginPath: string;
  readonly phase: "plan" | "evaluate";
  readonly config: unknown;
  readonly context: PollPluginContext;
  readonly result?: PollProbeResult;
}

export class PollPluginRunner {
  readonly #hostPath: string;
  readonly #timeoutMilliseconds: number;

  public constructor(timeoutMilliseconds = 5_000) {
    this.#hostPath = fileURLToPath(new URL("./plugin-host.js", import.meta.url));
    this.#timeoutMilliseconds = bounded(timeoutMilliseconds, 100, 60_000, "plugin timeout");
  }

  public async plan(
    pluginPath: string,
    expectedPluginId: string,
    config: unknown,
    context: PollPluginContext
  ): Promise<PollProbe> {
    const value = await this.#run(expectedPluginId, {
      pluginPath: canonicalPluginPath(pluginPath),
      phase: "plan",
      config,
      context
    });
    return parsePollProbe(value);
  }

  public async evaluate(
    pluginPath: string,
    expectedPluginId: string,
    config: unknown,
    context: PollPluginContext,
    result: PollProbeResult
  ): Promise<PollObservation> {
    const value = await this.#run(expectedPluginId, {
      pluginPath: canonicalPluginPath(pluginPath),
      phase: "evaluate",
      config,
      context,
      result
    });
    return parseObservation(value);
  }

  async #run(expectedPluginId: string, request: PluginHostRequest): Promise<unknown> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [
        "--permission",
        "--allow-fs-read", request.pluginPath,
        "--allow-fs-read", this.#hostPath,
        "--experimental-vm-modules",
        this.#hostPath
      ], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {},
        cwd: dirname(request.pluginPath)
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error(`Poll plugin exceeded ${this.#timeoutMilliseconds}ms`));
      }, this.#timeoutMilliseconds);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== undefined) {
          rejectPromise(error);
          return;
        }
        try {
          const response = JSON.parse(Buffer.concat(stdout).toString("utf8")) as unknown;
          if (!isRecord(response) || response.pluginId !== expectedPluginId ||
            response.schemaVersion !== 1 || !("value" in response)) {
            throw new Error(`Poll plugin identity mismatch: expected ${expectedPluginId}@1`);
          }
          resolvePromise(response.value);
        } catch (parseError) {
          rejectPromise(new Error(`Poll plugin returned invalid JSON: ${message(parseError)}`));
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > 1_048_576) {
          child.kill("SIGKILL");
          finish(new Error("Poll plugin result exceeds 1048576 bytes"));
        } else {
          stdout.push(chunk);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= 65_536) stderr.push(chunk);
      });
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => {
        if (code !== 0) {
          finish(new Error(`Poll plugin failed (${code ?? "signal"}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
        } else {
          finish();
        }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
}

export interface ProbeExecutorOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

export class PollProbeExecutor {
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #fetch: typeof fetch;

  public constructor(options: ProbeExecutorOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#fetch = options.fetch ?? fetch;
  }

  public async execute(
    probe: PollProbe,
    policy: ProbeExecutionPolicy,
    signal?: AbortSignal
  ): Promise<PollProbeResult> {
    probe = validatePollProbe(probe, policy, this.#environment);
    return probe.kind === "http"
      ? this.#executeHttp(probe, policy, signal)
      : this.#executeCommand(probe, policy, signal);
  }

  async #executeHttp(
    probe: HttpPollProbe,
    policy: ProbeExecutionPolicy,
    signal?: AbortSignal
  ): Promise<HttpProbeResult> {
    const url = new URL(probe.url);
    if (!policy.allowedHttpOrigins.includes(url.origin)) {
      throw new Error(`HTTP probe origin is not allowed: ${url.origin}`);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), policy.timeoutMilliseconds);
    try {
      const response = await this.#fetch(url, {
        method: probe.method ?? "GET",
        headers: resolveValues(probe.headers ?? {}, policy, this.#environment),
        signal: controller.signal,
        redirect: "error"
      });
      const body = await readBoundedBody(response, policy.maxOutputBytes);
      return {
        kind: "http",
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  #executeCommand(
    probe: CommandPollProbe,
    policy: ProbeExecutionPolicy,
    signal?: AbortSignal
  ): Promise<CommandProbeResult> {
    const executable = realpathSync(probe.executable);
    const workspace = realpathSync(policy.workspaceRoot);
    const cwd = realpathSync(resolve(workspace, probe.cwd ?? "."));
    const environment = resolveValues(probe.environment ?? {}, policy, this.#environment);
    return runCommand({
      executable,
      args: [...probe.args],
      cwd,
      environment,
      timeoutMilliseconds: policy.timeoutMilliseconds,
      maxOutputBytes: policy.maxOutputBytes,
      ...(signal === undefined ? {} : { signal })
    });
  }
}

function parseObservation(value: unknown): PollObservation {
  if (!isRecord(value) || typeof value.version !== "string" || value.version.trim() === "" ||
    !isRecord(value.facts) || (value.terminal !== null && value.terminal !== "success" &&
      value.terminal !== "failure" && value.terminal !== "cancelled")) {
    throw new Error("Poll plugin returned a malformed observation");
  }
  if ("terminalKey" in value) {
    throw new Error("Poll plugin terminalKey is not supported; the Runtime owns terminal identity");
  }
  return value as unknown as PollObservation;
}

function canonicalPluginPath(path: string): string {
  if (!isAbsolute(path)) throw new Error("Poll plugin path must be absolute");
  const canonical = realpathSync(path);
  if (!statSync(canonical).isFile()) throw new Error("Poll plugin path must be a file");
  return canonical;
}

function resolveValues(
  values: Readonly<Record<string, string | EnvironmentValue>>,
  policy: ProbeExecutionPolicy,
  environment: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    if (typeof value === "string") return [key, value];
    if (!policy.allowedEnvironment.includes(value.environment)) {
      throw new Error(`Environment value is not allowed: ${value.environment}`);
    }
    const resolved = environment[value.environment];
    if (resolved === undefined) throw new Error(`Environment value is missing: ${value.environment}`);
    return [key, resolved];
  }));
}

async function readBoundedBody(response: Response, maximum: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error(`HTTP probe response exceeds ${maximum} bytes`);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

interface CommandRunOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

function runCommand(options: CommandRunOptions): Promise<CommandProbeResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: { ...options.environment },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      child.kill("SIGTERM");
      forceTimer ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, options.timeoutMilliseconds);
    const finish = (error?: Error, exitCode?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", stop);
      if (error !== undefined) {
        rejectPromise(error);
      } else {
        resolvePromise({
          kind: "command",
          exitCode: exitCode ?? -1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
      }
    };
    const collect = (target: Buffer[]) => (chunk: Buffer): void => {
      size += chunk.byteLength;
      if (size > options.maxOutputBytes) {
        child.kill("SIGKILL");
        finish(new Error(`Command probe output exceeds ${options.maxOutputBytes} bytes`));
      } else {
        target.push(chunk);
      }
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (options.signal?.aborted === true) {
        finish(new Error("Command probe aborted"));
      } else if (signal !== null) {
        finish(new Error(`Command probe terminated by ${signal}`));
      } else {
        finish(undefined, code ?? -1);
      }
    });
  });
}

function bounded(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
