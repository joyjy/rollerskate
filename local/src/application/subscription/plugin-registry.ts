import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runtimePaths } from "../../infrastructure/runtime/config.js";
import type { RunTriggerIntent } from
  "../../modules/steward/admission-contract.js";
import { stableContractJson } from "../../modules/steward/contract-codec.js";

const REGISTRY_SCHEMA = "SubscriptionPluginRegistry@1";
const MAX_REGISTRY_BYTES = 262_144;

export interface RegisteredSubscriptionPlugin {
  readonly ref: string;
  readonly path: string;
  readonly id: string;
  readonly artifactRevision: string;
  readonly artifactDigest: string;
  readonly authorityDigest: string;
  readonly workspaceRoot: string;
  readonly triggerKinds: readonly ("until" | "continuous")[];
  readonly allowedHttpOrigins: readonly string[];
  readonly allowedExecutables: readonly string[];
  readonly gitlabPipeline?: {
    readonly inputSchema: "GitLabPipelineInput@1";
    readonly transport: {
      readonly kind: "command";
      readonly executable: string;
      readonly cwd?: string;
    };
  };
}

export function listRegisteredSubscriptionPlugins(
  repoRoot: string,
  runtimeDirectory?: string
): readonly RegisteredSubscriptionPlugin[] {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const plugins = readPluginEntries(repoRoot, runtimeDirectory)
    .map((value, index) => parsePlugin(value, index, paths.repoRoot, paths.workspace));
  unique(plugins.map(({ ref }) => ref), "plugin ref");
  unique(plugins.map(({ id }) => id), "plugin id");
  return plugins.sort((left, right) => left.ref.localeCompare(right.ref));
}

function readPluginEntries(repoRoot: string, runtimeDirectory?: string): Record<string, unknown>[] {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  if (!existsSync(paths.subscriptionPlugins)) return [];
  const stat = statSync(paths.subscriptionPlugins);
  if (!stat.isFile() || stat.size > MAX_REGISTRY_BYTES) {
    throw new Error("Subscription plugin registry must be a bounded regular file");
  }
  const parsed = JSON.parse(readFileSync(paths.subscriptionPlugins, "utf8")) as unknown;
  const registry = record(parsed, "SubscriptionPluginRegistry@1");
  exactKeys(registry, ["schemaVersion", "plugins"], "SubscriptionPluginRegistry@1");
  if (registry.schemaVersion !== REGISTRY_SCHEMA || !Array.isArray(registry.plugins)) {
    throw new Error("SubscriptionPluginRegistry@1 is required");
  }
  if (registry.plugins.length > 64) {
    throw new Error("Subscription plugin registry exceeds 64 plugins");
  }
  return registry.plugins.map((value, index) => record(value, `plugins[${index}]`));
}

export function resolveRegisteredSubscriptionPlugin(
  repoRoot: string,
  ref: string,
  runtimeDirectory?: string
): RegisteredSubscriptionPlugin | undefined {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const entries = readPluginEntries(repoRoot, runtimeDirectory);
  const index = entries.findIndex((plugin) => plugin.ref === ref);
  if (index === -1) return undefined;
  const plugin = parsePlugin(entries[index], index, paths.repoRoot, paths.workspace);
  if (entries.filter((entry) => entry.ref === plugin.ref || entry.pluginId === plugin.id).length !== 1) {
    throw new Error("Selected plugin ref and id must be unique");
  }
  return plugin;
}

export function registeredPluginsForTrigger(
  repoRoot: string,
  triggerKind: RunTriggerIntent,
  runtimeDirectory?: string
): readonly RegisteredSubscriptionPlugin[] {
  if (triggerKind !== "until" && triggerKind !== "continuous") return [];
  return listRegisteredSubscriptionPlugins(repoRoot, runtimeDirectory)
    .filter(({ triggerKinds }) => triggerKinds.includes(triggerKind));
}

function parsePlugin(
  value: unknown,
  index: number,
  repoRoot: string,
  localWorkspace: string
): RegisteredSubscriptionPlugin {
  const label = `plugins[${index}]`;
  const plugin = record(value, label);
  exactKeys(plugin, [
    "ref", "pluginPath", "pluginId", "workspaceRef", "triggerKinds",
    "allowedHttpOrigins", "allowedExecutables", "gitlabPipeline"
  ], label, ["gitlabPipeline"]);
  const ref = text(plugin.ref, `${label}.ref`, 256);
  if (!/^plugin:[a-z0-9][a-z0-9._-]*@[1-9][0-9]*$/.test(ref)) {
    throw new Error(`${label}.ref must be a stable versioned plugin ref`);
  }
  const path = resolvePluginPath(
    text(plugin.pluginPath, `${label}.pluginPath`, 4_096),
    repoRoot
  );
  const bytes = readFileSync(path);
  const artifactDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const registered = {
    ref,
    path,
    id: text(plugin.pluginId, `${label}.pluginId`, 128),
    artifactRevision: artifactDigest,
    artifactDigest,
    workspaceRoot: resolveWorkspace(
      text(plugin.workspaceRef, `${label}.workspaceRef`, 4_096),
      repoRoot,
      localWorkspace
    ),
    triggerKinds: [...triggerKinds(plugin.triggerKinds, `${label}.triggerKinds`)].sort(),
    allowedHttpOrigins: stringList(
      plugin.allowedHttpOrigins,
      `${label}.allowedHttpOrigins`,
      64
    ).map((origin) => canonicalOrigin(origin, label)).sort(),
    allowedExecutables: stringList(
      plugin.allowedExecutables,
      `${label}.allowedExecutables`,
      64
    ).map((executable) => canonicalFile(executable, `${label}.allowedExecutables`)).sort()
  };
  const gitlabPipeline = plugin.gitlabPipeline === undefined ? undefined : parseGitLabPipeline(
    plugin.gitlabPipeline,
    label,
    registered.allowedExecutables
  );
  return {
    ...registered,
    authorityDigest: `sha256:${createHash("sha256")
      .update(stableContractJson({...registered, ...(gitlabPipeline === undefined ? {} : {gitlabPipeline})})).digest("hex")}`,
    ...(gitlabPipeline === undefined ? {} : { gitlabPipeline })
  };
}

function parseGitLabPipeline(
  value: unknown,
  label: string,
  allowedExecutables: readonly string[]
): NonNullable<RegisteredSubscriptionPlugin["gitlabPipeline"]> {
  const declaration = record(value, `${label}.gitlabPipeline`);
  exactKeys(declaration, ["inputSchema", "transport"], `${label}.gitlabPipeline`);
  if (declaration.inputSchema !== "GitLabPipelineInput@1") {
    throw new Error(`${label}.gitlabPipeline.inputSchema must be GitLabPipelineInput@1`);
  }
  const transport = record(declaration.transport, `${label}.gitlabPipeline.transport`);
  exactKeys(transport, ["kind", "executable", "cwd"], `${label}.gitlabPipeline.transport`, ["cwd"]);
  if (transport.kind !== "command") throw new Error(`${label}.gitlabPipeline.transport.kind must be command`);
  const executable = canonicalFile(text(transport.executable, `${label}.gitlabPipeline.transport.executable`, 4_096), `${label}.gitlabPipeline.transport.executable`);
  if (!allowedExecutables.includes(executable)) {
    throw new Error(`${label}.gitlabPipeline.transport.executable must be in allowedExecutables`);
  }
  return {
    inputSchema: "GitLabPipelineInput@1",
    transport: {
      kind: "command",
      executable,
      ...(transport.cwd === undefined ? {} : { cwd: text(transport.cwd, `${label}.gitlabPipeline.transport.cwd`, 4_096) })
    }
  };
}

function resolvePluginPath(ref: string, repoRoot: string): string {
  const input = ref.startsWith("project:")
    ? projectPath(repoRoot, ref.slice("project:".length))
    : filePath(ref, "pluginPath");
  const canonical = canonicalFile(input, "pluginPath");
  if (ref.startsWith("project:")) {
    const nested = relative(realpathSync(repoRoot), canonical);
    if (nested === ".." || nested.startsWith("../") || isAbsolute(nested)) throw new Error("project pluginPath symlink escapes the project root");
  }
  return canonical;
}

function resolveWorkspace(ref: string, repoRoot: string, localWorkspace: string): string {
  const input = ref === "project:self"
    ? repoRoot
    : ref === "local:workspace"
      ? localWorkspace
      : filePath(ref, "workspaceRef");
  const canonical = realpathSync(input);
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`Subscription plugin workspace is not a directory: ${ref}`);
  }
  return canonical;
}

function projectPath(repoRoot: string, value: string): string {
  if (value === "" || isAbsolute(value)) {
    throw new Error("project pluginPath requires a relative path");
  }
  const candidate = resolve(repoRoot, value);
  const nested = relative(repoRoot, candidate);
  if (nested === "" || nested.startsWith("..") || isAbsolute(nested)) {
    throw new Error("project pluginPath escapes the project root");
  }
  return candidate;
}

function filePath(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be a supported stable reference`);
  }
  if (url.protocol !== "file:" || url.hostname !== "") {
    throw new Error(`${field} must be a local file URL`);
  }
  return fileURLToPath(url);
}

function canonicalFile(value: string, field: string): string {
  if (!isAbsolute(value)) throw new Error(`${field} must resolve to an absolute path`);
  const canonical = realpathSync(value);
  if (!statSync(canonical).isFile()) throw new Error(`${field} must resolve to a file`);
  return canonical;
}

function canonicalOrigin(value: string, label: string): string {
  const origin = new URL(value);
  if ((origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.origin !== value) {
    throw new Error(`${label}.allowedHttpOrigins must contain canonical HTTP origins`);
  }
  return origin.origin;
}

function triggerKinds(value: unknown, field: string): readonly ("until" | "continuous")[] {
  return stringList(value, field, 2).map((kind) => {
    if (kind !== "until" && kind !== "continuous") {
      throw new Error(`${field} contains an unsupported trigger kind`);
    }
    return kind;
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string,
  optional: readonly string[] = []
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${field} has unknown field: ${unknown}`);
  const missing = allowed.find((key) => value[key] === undefined && !optional.includes(key));
  if (missing !== undefined) throw new Error(`${field} is missing field: ${missing}`);
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new Error(`${field} must be a non-empty bounded string`);
  }
  return value;
}

function stringList(value: unknown, field: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum ||
    value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${field} must be a bounded string array`);
  }
  const result = value as string[];
  unique(result, field);
  return result;
}

function unique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
}

export function registeredSubscriptionProbe(plugin: RegisteredSubscriptionPlugin, config: unknown) {
  return {
    plugin: {
    path: plugin.path,
    id: plugin.id,
    schemaVersion: 1 as const,
    config: config
    },
    policy: {
    workspaceRoot: plugin.workspaceRoot,
    allowedHttpOrigins: plugin.allowedHttpOrigins,
    allowedExecutables: plugin.allowedExecutables,
    allowedEnvironment: [] as string[],
    timeoutMilliseconds: 30_000,
    maxOutputBytes: 65_536
    }
  };
}
