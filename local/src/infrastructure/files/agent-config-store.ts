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
import { isAbsolute } from "node:path";

export interface AgentRuntimeConfig {
  readonly workspaceRoot: string;
}

interface StoredAgentRuntimeConfig extends AgentRuntimeConfig {
  readonly schemaVersion: 1;
}

export class AgentConfigStore {
  readonly #path: string;

  public constructor(path: string) {
    this.#path = path;
  }

  public configure(workspaceRoot: string): AgentRuntimeConfig {
    if (!isAbsolute(workspaceRoot)) {
      throw new Error("workspace root must be an absolute path");
    }
    mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
    const canonicalRoot = realpathSync(workspaceRoot);
    if (!statSync(canonicalRoot).isDirectory()) {
      throw new Error("workspace root must be a directory");
    }
    const existing = this.load();
    if (existing !== undefined) {
      if (existing.workspaceRoot !== canonicalRoot) {
        throw new Error("Agent workspace root is already configured differently");
      }
      return existing;
    }
    const config: AgentRuntimeConfig = { workspaceRoot: canonicalRoot };
    writePrivateJson(this.#path, {
      schemaVersion: 1,
      ...config
    } satisfies StoredAgentRuntimeConfig);
    return config;
  }

  public load(): AgentRuntimeConfig | undefined {
    if (!existsSync(this.#path)) {
      return undefined;
    }
    assertRegularPrivateFile(this.#path);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
    } catch (error) {
      throw new Error(
        `invalid Agent config file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!isRecord(value) || value.schemaVersion !== 1 ||
      typeof value.workspaceRoot !== "string" || value.workspaceRoot === "") {
      throw new Error("Agent config file has an unsupported schema");
    }
    if (!isAbsolute(value.workspaceRoot) || realpathSync(value.workspaceRoot) !== value.workspaceRoot) {
      throw new Error("Agent workspace root must remain a canonical absolute path");
    }
    return { workspaceRoot: value.workspaceRoot };
  }
}

function writePrivateJson(path: string, value: unknown): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("Agent config file must not be a symlink");
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
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
  }
}

function assertRegularPrivateFile(path: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error("Agent config file must not be a symlink");
  }
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new Error("Agent config path must be a regular file");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("Agent config file must not be accessible by group or others");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
