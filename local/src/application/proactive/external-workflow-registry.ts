import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { runtimePaths } from "../../infrastructure/runtime/config.js";
import {
  EXTERNAL_WORKFLOW_TARGET_SCHEMA,
  PROACTIVE_TARGET_SCHEMA,
  parseProactiveTarget,
  type ExternalWorkflowProactiveTarget
} from "../../modules/proactive/target.js";
import {
  boundedContractValue,
  stableContractJson
} from "../../modules/steward/contract-codec.js";

const REGISTRY_SCHEMA = "OwnerExternalWorkflowRegistry@1";
const REGISTRATION_SCHEMA = "OwnerExternalWorkflowRegistration@1";
const MAX_REGISTRY_BYTES = 262_144;

export interface RegisteredExternalWorkflow {
  readonly ref: string;
  readonly inputSchema: string;
  readonly fixedInput: unknown;
  readonly executable: string;
  readonly executableDigest: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly filesystemRoots: readonly string[];
  readonly networkAccess: true;
  readonly timeoutMilliseconds: number;
  readonly maxOutputBytes: number;
  readonly maxAttempts: number;
  readonly retryBackoffMilliseconds: number;
  readonly registrationDigest: string;
}

export class OwnerExternalWorkflowRegistry {
  readonly #byRef: ReadonlyMap<string, RegisteredExternalWorkflow>;

  public constructor(registrations: readonly RegisteredExternalWorkflow[]) {
    const byRef = new Map<string, RegisteredExternalWorkflow>();
    for (const registration of registrations) {
      if (byRef.has(registration.ref)) {
        throw new Error(`Duplicate external workflow registration: ${registration.ref}`);
      }
      byRef.set(registration.ref, registration);
    }
    this.#byRef = byRef;
  }

  public compileTarget(workflowRef: string): ExternalWorkflowProactiveTarget {
    const registration = this.require(workflowRef);
    return parseProactiveTarget({
      schemaVersion: PROACTIVE_TARGET_SCHEMA,
      kind: "external_workflow",
      workflow: {
        schemaVersion: EXTERNAL_WORKFLOW_TARGET_SCHEMA,
        workflowRef: registration.ref,
        registrationDigest: registration.registrationDigest,
        input: registration.fixedInput,
        executionPolicy: {
          schemaVersion: "ExternalWorkflowExecutionPolicy@1",
          maxAttempts: registration.maxAttempts,
          retryBackoffMilliseconds: registration.retryBackoffMilliseconds
        }
      }
    }) as ExternalWorkflowProactiveTarget;
  }

  public resolve(target: ExternalWorkflowProactiveTarget): RegisteredExternalWorkflow {
    const parsed = parseProactiveTarget(target);
    if (parsed.kind !== "external_workflow") {
      throw new Error("external workflow target is required");
    }
    const registration = this.require(parsed.workflow.workflowRef);
    if (registration.registrationDigest !== parsed.workflow.registrationDigest) {
      throw new Error("external workflow registry changed after admission");
    }
    if (stableContractJson(parsed.workflow.input) !== stableContractJson(registration.fixedInput)) {
      throw new Error("external workflow input exceeds the Owner-fixed registration");
    }
    const currentDigest = fileDigest(registration.executable);
    if (currentDigest !== registration.executableDigest) {
      throw new Error("external workflow executable changed after registration load");
    }
    return registration;
  }

  public require(ref: string): RegisteredExternalWorkflow {
    const registration = this.#byRef.get(workflowRef(ref));
    if (registration === undefined) {
      throw new Error(`External workflow is not registered: ${ref}`);
    }
    return registration;
  }
}

export function loadOwnerExternalWorkflowRegistry(
  repoRoot: string,
  runtimeDirectory?: string
): OwnerExternalWorkflowRegistry {
  const path = runtimePaths(repoRoot, runtimeDirectory).externalWorkflows;
  if (!existsSync(path)) return new OwnerExternalWorkflowRegistry([]);
  const link = lstatSync(path);
  const stat = statSync(path);
  if (link.isSymbolicLink() || !stat.isFile() || stat.size > MAX_REGISTRY_BYTES ||
    (stat.mode & 0o077) !== 0) {
    throw new Error("Owner external workflow registry must be a bounded mode-0600 file");
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const registry = record(parsed, REGISTRY_SCHEMA);
  exactKeys(registry, ["schemaVersion", "workflows"], REGISTRY_SCHEMA);
  if (registry.schemaVersion !== REGISTRY_SCHEMA || !Array.isArray(registry.workflows)) {
    throw new Error(`${REGISTRY_SCHEMA} is required`);
  }
  if (registry.workflows.length > 32) {
    throw new Error("Owner external workflow registry exceeds 32 workflows");
  }
  return new OwnerExternalWorkflowRegistry(
    registry.workflows.map((value, index) => parseRegistration(value, index))
  );
}

function parseRegistration(value: unknown, index: number): RegisteredExternalWorkflow {
  const label = `workflows[${index}]`;
  const input = record(value, label);
  exactKeys(input, [
    "schemaVersion", "ref", "inputSchema", "fixedInput", "command", "authority",
    "retry"
  ], label);
  if (input.schemaVersion !== REGISTRATION_SCHEMA) {
    throw new Error(`${label}.schemaVersion must be ${REGISTRATION_SCHEMA}`);
  }
  const command = record(input.command, `${label}.command`);
  exactKeys(command, [
    "executable", "arguments", "cwd", "environment", "timeoutMilliseconds",
    "maxOutputBytes"
  ], `${label}.command`);
  const authority = record(input.authority, `${label}.authority`);
  exactKeys(authority, ["filesystemRoots", "networkAccess"], `${label}.authority`);
  const retry = record(input.retry, `${label}.retry`);
  exactKeys(retry, ["maxAttempts", "backoffMilliseconds"], `${label}.retry`);
  const executable = canonicalFile(
    fileReference(command.executable, `${label}.command.executable`),
    `${label}.command.executable`
  );
  const cwd = canonicalDirectory(
    fileReference(command.cwd, `${label}.command.cwd`),
    `${label}.command.cwd`
  );
  const filesystemRoots = stringList(
    authority.filesystemRoots,
    `${label}.authority.filesystemRoots`,
    16
  ).map((item) => canonicalDirectory(fileReference(item, label), label)).sort();
  if (!filesystemRoots.some((root) => within(root, executable)) ||
    !filesystemRoots.some((root) => within(root, cwd))) {
    throw new Error(`${label} executable and cwd must be inside its filesystem authority`);
  }
  if (authority.networkAccess !== true) {
    throw new Error(`${label}.authority.networkAccess must truthfully declare host network access`);
  }
  const fixedInput = boundedContractValue(input.fixedInput, `${label}.fixedInput`);
  const registration = {
    ref: workflowRef(input.ref),
    inputSchema: versionedToken(input.inputSchema, `${label}.inputSchema`),
    fixedInput,
    executable,
    executableDigest: fileDigest(executable),
    arguments: stringList(command.arguments, `${label}.command.arguments`, 128),
    cwd,
    environment: environment(command.environment, `${label}.command.environment`),
    filesystemRoots,
    networkAccess: true as const,
    timeoutMilliseconds: integer(
      command.timeoutMilliseconds,
      `${label}.command.timeoutMilliseconds`,
      1_000,
      3_600_000
    ),
    maxOutputBytes: integer(
      command.maxOutputBytes,
      `${label}.command.maxOutputBytes`,
      1_024,
      262_144
    ),
    maxAttempts: integer(retry.maxAttempts, `${label}.retry.maxAttempts`, 1, 5),
    retryBackoffMilliseconds: integer(
      retry.backoffMilliseconds,
      `${label}.retry.backoffMilliseconds`,
      1_000,
      3_600_000
    )
  };
  return {
    ...registration,
    registrationDigest: `sha256:${createHash("sha256")
      .update(stableContractJson({
        schemaVersion: REGISTRATION_SCHEMA,
        ...registration
      }))
      .digest("hex")}`
  };
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${field} has unknown field: ${unknown}`);
  const missing = allowed.find((key) => !(key in value));
  if (missing !== undefined) throw new Error(`${field} is missing field: ${missing}`);
}

function workflowRef(value: unknown): string {
  const ref = text(value, "workflowRef", 256);
  if (!/^workflow:[a-z0-9][a-z0-9._/-]*@[1-9][0-9]*$/u.test(ref)) {
    throw new Error("workflowRef must be a stable versioned workflow ref");
  }
  return ref;
}

function versionedToken(value: unknown, field: string): string {
  const token = text(value, field, 256);
  if (!/^[A-Za-z][A-Za-z0-9._/-]*@[1-9][0-9]*$/u.test(token)) {
    throw new Error(`${field} must be a versioned token`);
  }
  return token;
}

function fileReference(value: unknown, field: string): string {
  const ref = text(value, field, 4_096);
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    throw new Error(`${field} must be an absolute file URL`);
  }
  if (url.protocol !== "file:" || url.hostname !== "") {
    throw new Error(`${field} must be an absolute file URL`);
  }
  return fileURLToPath(url);
}

function canonicalFile(path: string, field: string): string {
  if (!isAbsolute(path)) throw new Error(`${field} must resolve to an absolute path`);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isFile()) throw new Error(`${field} must resolve to a file`);
  return canonical;
}

function canonicalDirectory(path: string, field: string): string {
  if (!isAbsolute(path)) throw new Error(`${field} must resolve to an absolute path`);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error(`${field} must resolve to a directory`);
  return canonical;
}

function within(root: string, target: string): boolean {
  const nested = relative(root, target);
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

function environment(value: unknown, field: string): Readonly<Record<string, string>> {
  const input = record(value, field);
  if (Object.keys(input).length > 32) throw new Error(`${field} exceeds 32 entries`);
  const result: Record<string, string> = {};
  for (const [name, raw] of Object.entries(input).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name) || typeof raw !== "string" || raw.length > 8_192) {
      throw new Error(`${field}.${name} is invalid`);
    }
    if (name === "NODE_OPTIONS" || name === "NODE_PATH" || name === "LD_PRELOAD" ||
      name.startsWith("DYLD_") || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/u.test(name)) {
      throw new Error(`${field}.${name} may alter the executor or contain a secret`);
    }
    result[name] = raw;
  }
  return result;
}

function stringList(value: unknown, field: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum ||
    value.some((item) => typeof item !== "string" || item.length > 4_096)) {
    throw new Error(`${field} must be a bounded string array`);
  }
  return value as readonly string[];
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new Error(`${field} must be a non-empty bounded string`);
  }
  return value;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function fileDigest(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}
