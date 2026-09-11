import { lstatSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { contractRecord, exactContractKeys, contractText } from "../../modules/steward/contract-codec.js";

export interface FileEventSource {
  readonly kind: "file";
  readonly root: string;
  readonly recursive: boolean;
  /** Empty means every filename. Otherwise literal suffixes, not glob expressions. */
  readonly suffixes: readonly string[];
  readonly exclude: readonly string[];
  readonly debounceMilliseconds: number;
  readonly maxDelayMilliseconds: number;
}

export interface FileListenerState {
  readonly status: "watching" | "degraded" | "stopped";
  readonly observedAt: string;
  readonly error?: string;
}

export function parseFileEventSource(value: unknown): FileEventSource {
  const input = contractRecord(value, "file source");
  exactContractKeys(input, ["kind", "root", "recursive", "suffixes", "exclude",
    "debounceMilliseconds", "maxDelayMilliseconds"], "file source");
  if (input.kind !== "file" || typeof input.recursive !== "boolean") {
    throw new Error("file source requires kind=file and explicit recursive boolean");
  }
  const root = contractText(input.root, "root", 4096);
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error("root must be an absolute normalized path");
  const strings = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value) || value.length > 64) throw new Error(`${label} must contain at most 64 strings`);
    return [...new Set(value.map((item) => contractText(item, label, 256)))];
  };
  const suffixes = strings(input.suffixes, "suffixes");
  if (suffixes.some((item) => item.includes("/") || item.includes("\\"))) throw new Error("suffix must be a literal filename suffix");
  const exclude = strings(input.exclude, "exclude");
  if (exclude.some((item) => isAbsolute(item) || item.split("/").some((part) => ["", ".", ".."].includes(part)))) {
    throw new Error("exclude entries must be normalized relative paths");
  }
  const bounded = (value: unknown, label: string): number => {
    if (!Number.isInteger(value) || Number(value) < 10 || Number(value) > 60_000) throw new Error(`${label} must be between 10 and 60000`);
    return Number(value);
  };
  const debounceMilliseconds = bounded(input.debounceMilliseconds, "debounceMilliseconds");
  const maxDelayMilliseconds = bounded(input.maxDelayMilliseconds, "maxDelayMilliseconds");
  if (maxDelayMilliseconds < debounceMilliseconds) throw new Error("max delay must cover debounce");
  return { kind: "file", root, recursive: input.recursive, suffixes, exclude, debounceMilliseconds, maxDelayMilliseconds };
}

export function assertFileRoot(source: FileEventSource): void {
  if (realpathSync(source.root) !== source.root || !statSync(source.root).isDirectory()) {
    throw new Error("file source root must be a canonical directory without symlink traversal");
  }
}

/** Native listeners only invalidate. The owning Subscription phase admits work. */
export class FileEventListener {
  readonly #source: FileEventSource;
  readonly #notify: () => void;
  readonly #watchers: FSWatcher[] = [];
  #first: number | undefined;
  #last = 0;
  #key = "";
  #error: string | undefined;
  #closed = false;

  public constructor(source: FileEventSource, watchPort: typeof watch = watch, notify = (): void => {}) {
    this.#source = source;
    this.#notify = notify;
    try {
      assertFileRoot(source);
      const identity = statSync(source.root);
      const failed = (error: Error): void => { this.#error = error.message; this.close(); this.#notify(); };
      const parent = watchPort(dirname(source.root), (_event, name) => {
        if (name !== null && String(name) !== basename(source.root)) return;
        try {
          assertFileRoot(source);
          const current = statSync(source.root);
          if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error("file source root replaced");
        } catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
      });
      this.#watchers.push(parent);
      parent.on("error", failed);
      const directory = watchPort(source.root, { recursive: source.recursive }, (_event, name) => {
        try {
          if (!this.#closed && this.#matches(name === null ? undefined : String(name), _event === "rename")) this.#invalidate();
        } catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
      });
      this.#watchers.push(directory);
      directory.on("error", failed);
      assertFileRoot(source);
      const attached = statSync(source.root);
      if (attached.ino !== identity.ino || attached.dev !== identity.dev) throw new Error("file source root changed during subscription");
      // Subscribe before the startup reconciliation. No filesystem polling or content reads.
      this.#invalidate();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  public get error(): string | undefined { return this.#error; }
  public due(now = Date.now()): string | undefined {
    if (this.#closed || this.#first === undefined) return undefined;
    return now >= Math.min(this.#last + this.#source.debounceMilliseconds,
      this.#first + this.#source.maxDelayMilliseconds) ? this.#key : undefined;
  }
  public nextWaitMilliseconds(maximum: number, now = Date.now()): number {
    if (this.#closed || this.#first === undefined) return maximum;
    return Math.min(maximum, Math.max(0, Math.min(this.#last + this.#source.debounceMilliseconds,
      this.#first + this.#source.maxDelayMilliseconds) - now));
  }
  public accepted(key: string): void { if (this.#key === key) this.#first = undefined; }
  public close(): void {
    this.#closed = true;
    for (const watcher of this.#watchers.splice(0)) watcher.close();
  }
  #invalidate(): void {
    const now = Date.now();
    this.#first ??= now;
    this.#last = now;
    this.#key = randomUUID();
    this.#notify();
  }
  #matches(name: string | undefined, renamed: boolean): boolean {
    if (name === undefined) return true; // Native backend cannot identify the changed entry.
    const path = resolve(this.#source.root, name);
    const local = relative(this.#source.root, path);
    if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) return false;
    if (this.#source.exclude.some((item) => local === item || local.startsWith(`${item}${sep}`))) return false;
    // Never follow a symlink. Missing entries are valid deletion/rename notifications.
    let cursor = this.#source.root;
    for (const part of local.split(sep)) {
      cursor = join(cursor, part);
      try { if (lstatSync(cursor).isSymbolicLink()) return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    // Directory rename/delete may affect matching descendants even without a matching suffix.
    if (this.#source.recursive && renamed) return true;
    return this.#source.suffixes.length === 0 || this.#source.suffixes.some((suffix) => local.endsWith(suffix));
  }
}
