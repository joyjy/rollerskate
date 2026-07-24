import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { initializeRuntimeSchema } from "./runtime-schema.js";

const CONFIG_SCHEMA_VERSION = 1;

export interface LocalAppConfig {
  readonly schemaVersion: 1;
  readonly projectRoot: string;
  readonly codexExecutable: string;
  readonly matrix: {
    readonly homeserver: string;
    readonly roomId: string;
    readonly ownerUserId: string;
    readonly agentUserId: string;
    readonly mentionPrefix: string;
  };
  readonly grantExpiresAt: string;
  readonly runtime: {
    readonly codexTimeoutMilliseconds: number;
    readonly leaseSeconds: number;
    readonly syncTimeoutMilliseconds: number;
    readonly requestTimeoutMilliseconds: number;
    readonly sendTimeoutMilliseconds: number;
    readonly retryMilliseconds: number;
    readonly cycleDelayMilliseconds: number;
    readonly failureDelayMilliseconds: number;
  };
}

export interface RuntimePaths {
  readonly repoRoot: string;
  readonly runtimeDirectory: string;
  readonly config: string;
  readonly secrets: string;
  readonly deviceCredential: string;
  readonly agentConfig: string;
  readonly agentCredentials: string;
  readonly database: string;
  readonly workspace: string;
  readonly logs: string;
  readonly daemonLog: string;
  readonly loopState: string;
  readonly loopControl: string;
  readonly matrixPolicy: string;
}

export interface SetupInput {
  readonly homeserver: string;
  readonly roomId: string;
  readonly ownerUserId: string;
  readonly agentUserId: string;
  readonly matrixAccessToken: string;
  readonly projectRoot: string;
  readonly codexExecutable: string;
  readonly mentionPrefix?: string;
}

export interface LoadedLocalRuntime {
  readonly paths: RuntimePaths;
  readonly config: LocalAppConfig;
  readonly matrixAccessToken: string;
}

export function runtimePaths(repoRoot: string, configuredRuntimeDirectory?: string): RuntimePaths {
  const canonicalRoot = realpathSync(repoRoot);
  const runtimeDirectory = configuredRuntimeDirectory === undefined
    ? join(homedir(), ".rollerskate")
    : normalizeRuntimeDirectory(configuredRuntimeDirectory);
  const logs = join(runtimeDirectory, "logs");
  return {
    repoRoot: canonicalRoot,
    runtimeDirectory,
    config: join(runtimeDirectory, "config.json"),
    secrets: join(runtimeDirectory, "secrets.json"),
    deviceCredential: join(runtimeDirectory, "device-credential.json"),
    agentConfig: join(runtimeDirectory, "agent-config.json"),
    agentCredentials: join(runtimeDirectory, "agent-credentials"),
    database: join(runtimeDirectory, "runtime.db"),
    workspace: join(runtimeDirectory, "workspace"),
    logs,
    daemonLog: join(logs, "daemon.log"),
    loopState: join(runtimeDirectory, "loop-state.json"),
    loopControl: join(runtimeDirectory, "loop-control.json"),
    matrixPolicy: join(runtimeDirectory, "matrix-policy.json")
  };
}

function normalizeRuntimeDirectory(value: string): string {
  if (!isAbsolute(value)) {
    throw new Error("runtime directory must be an absolute path");
  }
  const path = resolve(value);
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isDirectory()) {
      throw new Error("runtime directory must be a regular directory");
    }
    return realpathSync(path);
  }
  return path;
}

export function setupLocalRuntime(
  repoRoot: string,
  input: SetupInput,
  setupAt = new Date().toISOString(),
  configuredRuntimeDirectory?: string
): LoadedLocalRuntime {
  let paths = runtimePaths(repoRoot, configuredRuntimeDirectory);
  mkdirSync(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
  chmodSync(paths.runtimeDirectory, 0o700);
  paths = runtimePaths(repoRoot, paths.runtimeDirectory);
  const proposed = normalizeSetup(input, setupAt);
  let config = proposed;
  if (existsSync(paths.config)) {
    const existing = readConfig(paths.config);
    assertSameSetup(existing, proposed);
    config = existing;
  }

  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  chmodSync(paths.logs, 0o700);
  initializeRuntimeSchema(paths.database);

  if (!existsSync(paths.config)) {
    writePrivateJson(paths.config, config);
  }
  writeSecret(paths, input.matrixAccessToken);
  return { paths, config, matrixAccessToken: input.matrixAccessToken };
}

export function loadLocalRuntime(
  repoRoot: string,
  configuredRuntimeDirectory?: string
): LoadedLocalRuntime {
  const paths = runtimePaths(repoRoot, configuredRuntimeDirectory);
  const config = readConfig(paths.config);
  const secret = readJson(paths.secrets) as { matrixAccessToken?: unknown };
  requireNonEmpty(secret.matrixAccessToken, "matrixAccessToken");
  const mode = statSync(paths.secrets).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(".rollerskate/secrets.json must not be accessible by group or others");
  }
  return {
    paths,
    config,
    matrixAccessToken: secret.matrixAccessToken
  };
}

function normalizeSetup(input: SetupInput, setupAt: string): LocalAppConfig {
  for (const [field, value] of Object.entries(input)) {
    if (field !== "mentionPrefix") {
      requireNonEmpty(value, field);
    }
  }
  const homeserver = new URL(input.homeserver);
  if (homeserver.protocol !== "https:") {
    throw new Error("homeserver must use https");
  }
  if (!isAbsolute(input.projectRoot) || !isAbsolute(input.codexExecutable)) {
    throw new Error("projectRoot and codexExecutable must be absolute paths");
  }
  const projectRoot = realpathSync(input.projectRoot);
  if (!statSync(projectRoot).isDirectory()) {
    throw new Error("projectRoot must be a directory");
  }
  const codexExecutable = realpathSync(input.codexExecutable);
  if (!statSync(codexExecutable).isFile()) {
    throw new Error("codexExecutable must be a file");
  }
  const setupTimestamp = Date.parse(setupAt);
  if (Number.isNaN(setupTimestamp)) {
    throw new Error("setupAt must be an ISO-8601 timestamp");
  }
  const mentionPrefix = input.mentionPrefix ?? "Rollerskate ";
  requireNonEmpty(mentionPrefix, "mentionPrefix");
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    projectRoot,
    codexExecutable,
    matrix: {
      homeserver: homeserver.origin,
      roomId: input.roomId,
      ownerUserId: input.ownerUserId,
      agentUserId: input.agentUserId,
      mentionPrefix
    },
    grantExpiresAt: new Date(
      setupTimestamp + 365 * 24 * 60 * 60 * 1_000
    ).toISOString(),
    runtime: {
      codexTimeoutMilliseconds: 300_000,
      leaseSeconds: 600,
      syncTimeoutMilliseconds: 30_000,
      requestTimeoutMilliseconds: 35_000,
      sendTimeoutMilliseconds: 10_000,
      retryMilliseconds: 5_000,
      cycleDelayMilliseconds: 50,
      failureDelayMilliseconds: 1_000
    }
  };
}

function assertSameSetup(existing: LocalAppConfig, proposed: LocalAppConfig): void {
  const stableExisting = {
    projectRoot: existing.projectRoot,
    codexExecutable: existing.codexExecutable,
    matrix: existing.matrix
  };
  const stableProposed = {
    projectRoot: proposed.projectRoot,
    codexExecutable: proposed.codexExecutable,
    matrix: proposed.matrix
  };
  if (JSON.stringify(stableExisting) !== JSON.stringify(stableProposed)) {
    throw new Error(
      ".rollerskate is already configured differently; preserve it and use " +
      "the low-level CLI for migration"
    );
  }
  if (Date.parse(existing.grantExpiresAt) <= Date.now()) {
    throw new Error("the configured Matrix owner grant has expired");
  }
}

function readConfig(path: string): LocalAppConfig {
  const value = readJson(path);
  if (!isRecord(value) || value.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new Error(".rollerskate/config.json has an unsupported schema");
  }
  const config = value as unknown as LocalAppConfig;
  requireNonEmpty(config.projectRoot, "projectRoot");
  requireNonEmpty(config.codexExecutable, "codexExecutable");
  requireNonEmpty(config.matrix?.homeserver, "matrix.homeserver");
  requireNonEmpty(config.matrix?.roomId, "matrix.roomId");
  requireNonEmpty(config.matrix?.ownerUserId, "matrix.ownerUserId");
  requireNonEmpty(config.matrix?.agentUserId, "matrix.agentUserId");
  requireNonEmpty(config.matrix?.mentionPrefix, "matrix.mentionPrefix");
  requireNonEmpty(config.grantExpiresAt, "grantExpiresAt");
  return config;
}

function readJson(path: string): unknown {
  if (!existsSync(path)) {
    throw new Error(`missing runtime file: ${path}`);
  }
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`runtime file must not be a symlink: ${path}`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function writeSecret(paths: RuntimePaths, matrixAccessToken: string): void {
  requireNonEmpty(matrixAccessToken, "matrixAccessToken");
  writePrivateJson(paths.secrets, { matrixAccessToken });
}

function writePrivateJson(path: string, value: unknown): void {
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
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
}
