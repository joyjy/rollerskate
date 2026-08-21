import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

import type {
  HostCommandExecutor,
  HostCommandRequest,
  HostCommandResult
} from "../../integrations/host-command.js";

export class HostCallbackKernel implements HostCommandExecutor {
  public async executeHostCommand(
    request: HostCommandRequest
  ): Promise<HostCommandResult> {
    if (request.executable.trim() === "") {
      throw new Error("host command executable must be non-empty");
    }
    return runCommand({
      executable: request.executable,
      argv: request.arguments,
      timeout: positiveInteger(request.timeoutMilliseconds, "host command timeoutMilliseconds"),
      maxOutput: positiveInteger(request.maxOutputBytes, "host command maxOutputBytes")
    });
  }

  public async executeCommand(
    definition: Readonly<Record<string, unknown>>,
    grant: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    stdin: string
  ): Promise<unknown> {
    const runtime = definition.runtime;
    if (runtime !== "host" || grant.runtime !== "host") {
      throw new Error("callback command runtime must be host");
    }
    const executable = canonicalPath(text(definition.executable, "callback executable"));
    const grantedExecutable = canonicalPath(text(grant.executable, "grant executable"));
    const cwd = canonicalPath(text(definition.cwd, "callback cwd"));
    const grantedCwd = canonicalPath(text(grant.cwd, "grant cwd"));
    if (executable !== grantedExecutable) throw new Error("callback executable exceeds exact grant");
    if (cwd !== grantedCwd) throw new Error("callback cwd exceeds exact grant");
    const roots = strings(grant.filesystemRoots, "grant filesystemRoots").map(canonicalPath);
    if (!roots.some((root) => within(root, cwd)) ||
      !roots.some((root) => within(root, executable))) {
      throw new Error("callback command exceeds filesystem grant");
    }
    requireNoSecrets(grant);
    const environment = exactEnvironment(definition, grant);
    requireExecutorSafeEnvironment(environment);
    if (grant.networkAccess !== true) {
      throw new Error("host callback network authority must be truthfully granted");
    }
    const argv = strings(definition.argv, "callback argv");
    if (JSON.stringify(argv) !== JSON.stringify(strings(grant.argv, "grant argv"))) {
      throw new Error("callback argv exceeds exact grant");
    }
    const timeout = positiveInteger(definition.timeoutMilliseconds, "callback timeoutMilliseconds");
    const maxOutput = positiveInteger(definition.maxOutputBytes, "callback maxOutputBytes");
    if (grant.timeoutMilliseconds !== timeout || grant.maxOutputBytes !== maxOutput) {
      throw new Error("callback resource bounds exceed exact grant");
    }
    const execution = await runCommand({
      executable,
      argv,
      cwd,
      environment,
      timeout,
      maxOutput,
      signal,
      stdin
    });
    return { schemaVersion: "ProactiveCallbackReceipt@1", outcome: "succeeded", ...execution };
  }

}

function runCommand(input: {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeout: number;
  readonly maxOutput: number;
  readonly signal?: AbortSignal;
  readonly stdin?: string;
}): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(input.executable, input.argv, {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.environment === undefined ? {} : { env: { ...input.environment } }),
      timeout: input.timeout,
      maxBuffer: input.maxOutput,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      encoding: "utf8"
    }, (error, stdout, stderr) => {
      if (error !== null) reject(error);
      else resolve({ exitCode: 0, stdout, stderr });
    });
    child.stdin?.end(input.stdin ?? "");
  });
}

function canonicalPath(value: string): string {
  if (!isAbsolute(value)) throw new Error("callback filesystem paths must be absolute");
  return realpathSync(value);
}

function within(root: string, target: string): boolean {
  if (!isAbsolute(root)) return false;
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function exactEnvironment(
  definition: Readonly<Record<string, unknown>>,
  grant: Readonly<Record<string, unknown>>
): Readonly<Record<string, string>> {
  const environment = stringRecord(definition.environment ?? {}, "callback environment");
  if (JSON.stringify(environment) !== JSON.stringify(
    stringRecord(grant.environment, "grant environment")
  )) {
    throw new Error("callback environment exceeds exact grant");
  }
  return environment;
}

function requireExecutorSafeEnvironment(environment: Readonly<Record<string, string>>): void {
  for (const name of Object.keys(environment)) {
    if (name === "NODE_OPTIONS" || name === "NODE_PATH" || name === "LD_PRELOAD" ||
      name.startsWith("DYLD_")) {
      throw new Error(`callback environment may alter the host executor: ${name}`);
    }
  }
}

function requireNoSecrets(grant: Readonly<Record<string, unknown>>): void {
  if (strings(grant.secretReferences, "grant secretReferences").length > 0) {
    throw new Error("Secret injection is not configured");
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function stringRecord(value: unknown, field: string): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be a string record`);
  }
  return value as Readonly<Record<string, string>>;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}
