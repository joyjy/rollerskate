import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { contractRecord, exactContractKeys } from "../../modules/steward/contract-codec.js";
import { check, diagnostic, ValidationError, type Diagnostic } from "../../modules/validation.js";
import type { PollProbe, EnvironmentValue } from "./plugin-contract.js";
import type { ProbeExecutionPolicy } from "./model.js";

/** The plan contract is checked in both the sandbox response and execution admission. */
export function parsePollProbe(value: unknown): PollProbe {
  const probe = contractRecord(value, "probe");
  if (probe.kind === "http") {
    exactContractKeys(probe, ["kind", "url", "method", "headers"], "probe", ["method", "headers"]);
    if (typeof probe.url !== "string" || (probe.method !== undefined && probe.method !== "GET" && probe.method !== "HEAD")) {
      throw new Error("HTTP probe requires a URL and GET or HEAD method");
    }
    parseValues(probe.headers, "probe.headers");
  } else if (probe.kind === "command") {
    exactContractKeys(probe, ["kind", "executable", "args", "cwd", "environment"], "probe", ["cwd", "environment"]);
    if (typeof probe.executable !== "string" || probe.executable.includes("\0") || !Array.isArray(probe.args) ||
      probe.args.length > 1024 || probe.args.some(arg => typeof arg !== "string" || arg.includes("\0")) ||
      (probe.cwd !== undefined && typeof probe.cwd !== "string")) throw new Error("Command probe requires executable, string argv and optional cwd");
    parseValues(probe.environment, "probe.environment");
  } else throw new Error("Unsupported probe tool; expected http or command");
  if (Buffer.byteLength(JSON.stringify(probe)) > 65_536) throw new Error("Probe plan exceeds 65536 bytes");
  return probe as unknown as PollProbe;
}

function parseValues(value: unknown, field: string): void {
  if (value === undefined) return;
  for (const [key, item] of Object.entries(contractRecord(value, field))) {
    if (!key || /[\0\r\n]/u.test(key)) throw new Error(`${field} has an invalid key`);
    if (typeof item === "string") {
      if ((field === "probe.headers" ? /[\0\r\n]/u : /\0/u).test(item)) throw new Error(`${field}.${key} has an invalid value`);
    } else {
      const ref = contractRecord(item, `${field}.${key}`);
      exactContractKeys(ref, ["environment"], `${field}.${key}`);
      if (typeof ref.environment !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(ref.environment)) {
        throw new Error(`${field}.${key} requires an environment reference`);
      }
    }
  }
}

/** No HTTP request or command is executed here. Runtime uses this same check on every plan. */
export function validatePollProbe(value: unknown, policy: ProbeExecutionPolicy,
  environment: Readonly<Record<string, string | undefined>> = process.env): PollProbe {
  const issues: Diagnostic[] = [];
  const probe = check(issues, "probe", "TOOL_SCHEMA", "http or command tool with matching parameters",
    "Correct the registered plugin's plan to match the probe tool contract.", () => parsePollProbe(value));
  if (!probe) throw new ValidationError(issues);
  const workspace = probe.kind === "http" ? undefined : check(issues, "policy.workspaceRoot", "PATH_INVALID", "an absolute existing directory",
    "Correct the registered workspace reference.", () => {
      if (!isAbsolute(policy.workspaceRoot)) throw new Error("Workspace must be absolute");
      const path = realpathSync(policy.workspaceRoot);
      if (!statSync(path).isDirectory()) throw new Error("Workspace is not a directory");
      return path;
    });
  if (!Number.isInteger(policy.timeoutMilliseconds) || policy.timeoutMilliseconds < 100 || policy.timeoutMilliseconds > 300_000 ||
    !Number.isInteger(policy.maxOutputBytes) || policy.maxOutputBytes < 1 || policy.maxOutputBytes > 10_485_760) {
    issues.push(diagnostic("POLICY_INVALID", "policy", "bounded probe timeout and output", "Invalid probe budget", "Correct the registered probe policy."));
  }
  if (probe.kind === "http") {
    check(issues, "probe.url", "PERMISSION_DENIED", "HTTP origin within the registered grant",
      "Use an authorized origin or obtain an explicit Owner policy change.", () => {
        const url = new URL(probe.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Unsupported HTTP URL");
        if (!policy.allowedHttpOrigins.includes(url.origin)) throw new Error(`HTTP probe origin is not allowed: ${url.origin}`);
      });
  } else {
    check(issues, "probe.executable", "PERMISSION_DENIED", "an executable file in the registered allowlist",
      "Select a registered executable; a plan cannot grant itself process authority.", () => {
        if (!isAbsolute(probe.executable)) throw new Error("Command probe executable is not allowed: path must be absolute");
        const path = realpathSync(probe.executable);
        if (!statSync(path).isFile() || !policy.allowedExecutables.includes(path)) throw new Error("Command probe executable must resolve to an allowed file");
        accessSync(path, constants.X_OK);
      });
    if (workspace) check(issues, "probe.cwd", "PATH_OUTSIDE_WORKSPACE", "a directory within the registered workspace",
      "Resolve cwd relative to the registered workspace and keep symlink targets inside it.", () => {
        const path = realpathSync(resolve(workspace, probe.cwd ?? "."));
        const nested = relative(workspace, path);
        if (nested === ".." || nested.startsWith("../") || isAbsolute(nested)) throw new Error("Command probe cwd is outside workspace");
        if (!statSync(path).isDirectory()) throw new Error("Command probe cwd is not a directory");
      });
  }
  const values = probe.kind === "http" ? probe.headers : probe.environment;
  for (const [key, value] of Object.entries(values ?? {}) as Array<[string, string | EnvironmentValue]>) {
    if (typeof value === "string") continue;
    if (!policy.allowedEnvironment.includes(value.environment)) issues.push(diagnostic("PERMISSION_DENIED", `probe.environment.${key}`,
      "an allowed environment reference", `Environment value is not allowed: ${value.environment}`, "Obtain explicit Owner authorization for this reference."));
    else if (environment[value.environment] === undefined) issues.push(diagnostic("ENVIRONMENT_MISSING", `probe.environment.${key}`,
      "an available environment reference", `Environment value is missing: ${value.environment}`, "Provide the credential through the execution environment."));
  }
  if (issues.length) throw new ValidationError(issues);
  return probe;
}
