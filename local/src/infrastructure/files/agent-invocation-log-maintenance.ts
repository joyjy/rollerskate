import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, openSync, constants, closeSync, fstatSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { withInvocationLogLock } from "./agent-invocation-log-lock.js";

const MAX_READ_BYTES = 34 * 1024 * 1024;
const MAX_PAYLOAD_READ_BYTES = 1024 * 1024 + 1;
const DAY = 24 * 60 * 60 * 1000;
const LOG_NAME = /^attempt-\d+-[0-9a-f-]{36}\.jsonl$/u;
const PAYLOAD_NAME = /^(attempt-\d+-[0-9a-f-]{36}\.jsonl)\.\d+\.payload\.json$/u;

export interface LogFileInfo { readonly runId: string; readonly path: string; readonly bytes: number; readonly modifiedAt: string; readonly sealed: boolean; readonly compressed: boolean; readonly protectedReason?: string; }
export interface LogInventory { readonly logs: readonly LogFileInfo[]; readonly totalBytes: number; readonly complete: boolean; readonly protectedGroups: readonly {runId: string; reason: string}[]; }
export interface MaintenanceOptions { readonly now?: Date; readonly compressAfterDays?: number; readonly cleanupAfterDays?: number; readonly action?: "compress" | "cleanup" | "all"; }
export interface MaintenanceAction { readonly kind: "compress" | "cleanup"; readonly runId: string; readonly paths: readonly string[]; readonly bytes: number; readonly reason: string; }
export interface MaintenancePreview { readonly revision: string; readonly actions: readonly MaintenanceAction[]; readonly protectedGroups: readonly {runId: string; reason: string}[]; readonly options: Required<MaintenanceOptions>; }
export interface MaintenanceResult { readonly revision: string; readonly actions: readonly MaintenanceAction[]; }
export interface MaintenanceAuthority { readonly isRunTerminal?: (runId: string) => boolean | undefined; }

interface Group { readonly runId: string; readonly directory: string; readonly files: string[]; readonly logs: string[]; readonly problems: string[]; latestMtime: number; }

/** Maintenance is intentionally separate from the writer and requires an authoritative run status. */
export class AgentInvocationLogMaintenance {
  readonly #runtimeDirectory: string;
  readonly #runs: string;
  readonly #isRunTerminal: ((runId: string) => boolean | undefined) | undefined;

  public constructor(runtimeDirectory: string, authority: MaintenanceAuthority = {}) {
    this.#runtimeDirectory = runtimeDirectory;
    this.#runs = join(runtimeDirectory, "runs");
    this.#isRunTerminal = authority.isRunTerminal;
  }

  public list(): LogInventory {
    const groups = this.#scan();
    const logs: LogFileInfo[] = [];
    const protectedGroups: {runId: string; reason: string}[] = [];
    for (const group of groups) {
      const reason = this.#protection(group);
      if (reason) protectedGroups.push({runId: group.runId, reason});
      for (const path of group.logs) {
        const compressed = path.endsWith(".gz");
        const seal = `${compressed ? path.slice(0, -3) : path}.sealed`;
        const info = lstatSync(path);
        logs.push({runId: group.runId, path, bytes: info.size, modifiedAt: info.mtime.toISOString(), sealed: existsSync(seal), compressed, ...(reason ? {protectedReason: reason} : {})});
      }
    }
    return {logs, totalBytes: groups.flatMap(group => group.files).reduce((total, path) => total + lstatSync(path).size, 0),
      complete: groups.every(group => group.problems.length === 0), protectedGroups};
  }

  /** Returns completed JSONL records. A final partial line is ignored for an active writer. */
  public read(path: string): readonly unknown[] {
    const plain = path.endsWith(".gz") ? path.slice(0, -3) : path;
    if (!LOG_NAME.test(basename(plain))) throw new Error("Invalid invocation log path");
    this.#assertInsideRuns(plain);
    const source = existsSync(plain) ? plain : `${plain}.gz`;
    let actualSource = source;
    let bytes: Buffer;
    try { bytes = this.#readBoundedRegular(source); }
    catch (error) {
      if (source !== plain || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      actualSource = `${plain}.gz`;
      bytes = this.#readBoundedRegular(actualSource);
    }
    const body = actualSource.endsWith(".gz") ? gunzipSync(bytes, {maxOutputLength: MAX_READ_BYTES}) : bytes;
    if (body.length > MAX_READ_BYTES) throw new Error("Invocation log exceeds read limit");
    const end = body.lastIndexOf(0x0a);
    if (end < 0) return [];
    return body.subarray(0, end).toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as unknown);
  }

  /** Resolves the writer's logical payload filename across plain and gzip storage. */
  public readPayload(path: string): unknown {
    const plain = path.endsWith(".gz") ? path.slice(0, -3) : path;
    if (!PAYLOAD_NAME.test(basename(plain))) throw new Error("Invalid invocation payload path");
    this.#assertInsideRuns(plain);
    const source = existsSync(plain) ? plain : `${plain}.gz`;
    let actualSource = source;
    let bytes: Buffer;
    try { bytes = this.#readBoundedRegular(source, source.endsWith(".gz") ? MAX_READ_BYTES : MAX_PAYLOAD_READ_BYTES); }
    catch (error) {
      if (source !== plain || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      actualSource = `${plain}.gz`;
      bytes = this.#readBoundedRegular(actualSource, MAX_READ_BYTES);
    }
    const body = actualSource.endsWith(".gz") ? gunzipSync(bytes, {maxOutputLength: MAX_PAYLOAD_READ_BYTES}) : bytes;
    if (body.length > MAX_PAYLOAD_READ_BYTES || body.at(-1) !== 0x0a) throw new Error("Invalid invocation payload size or terminator");
    return JSON.parse(body.subarray(0, -1).toString("utf8")) as unknown;
  }

  public preview(options: MaintenanceOptions = {}): MaintenancePreview {
    return this.#preview(options, false);
  }

  #preview(options: MaintenanceOptions, ownLock: boolean): MaintenancePreview {
    const resolved = resolveOptions(options);
    const groups = this.#scan(ownLock);
    const protectedGroups: {runId: string; reason: string}[] = [];
    const actions: MaintenanceAction[] = [];
    for (const group of groups) {
      const reason = this.#protection(group);
      if (reason) { protectedGroups.push({runId: group.runId, reason}); continue; }
      const age = resolved.now.getTime() - group.latestMtime;
      const bytes = group.files.reduce((sum, path) => sum + lstatSync(path).size, 0);
      if (resolved.action !== "compress" && age >= resolved.cleanupAfterDays * DAY) {
        actions.push({kind: "cleanup", runId: group.runId, paths: [...group.files], bytes, reason: "terminal_run_past_retention"});
      } else if (resolved.action !== "cleanup" && age >= resolved.compressAfterDays * DAY) {
        for (const log of group.logs.filter(path => !path.endsWith(".gz"))) {
          actions.push({kind: "compress", runId: group.runId, paths: [log], bytes: lstatSync(log).size, reason: "sealed_log_past_cold_age"});
        }
        for (const payload of group.files.filter(path => PAYLOAD_NAME.test(basename(path)))) {
          actions.push({kind: "compress", runId: group.runId, paths: [payload], bytes: lstatSync(payload).size, reason: "sealed_payload_past_cold_age"});
        }
      }
    }
    return {revision: fingerprint(groups, this.#isRunTerminal, resolved, actions), actions, protectedGroups, options: resolved};
  }

  /** Rechecks every file and run status before mutation; a stale preview never partially applies. */
  public apply(preview: MaintenancePreview): MaintenanceResult {
    this.#assertRegularAncestry(this.#runs);
    let mutationStarted = false;
    return withInvocationLogLock(this.#runtimeDirectory, () => {
      const current = this.#preview(preview.options, true);
      if (current.revision !== preview.revision || JSON.stringify(current.actions) !== JSON.stringify(preview.actions)) {
        throw new Error("Invocation log maintenance preview is stale");
      }
      for (const action of current.actions) {
        mutationStarted = true;
        if (action.kind === "compress") this.#compress(action.paths[0]!);
        else for (const path of action.paths) rmSync(path);
      }
      return {revision: current.revision, actions: current.actions};
    }, {preserveOnError: () => mutationStarted});
  }

  #compress(path: string): void {
    const maxBytes = PAYLOAD_NAME.test(basename(path)) ? MAX_PAYLOAD_READ_BYTES : MAX_READ_BYTES;
    const original = this.#readBoundedRegular(path, maxBytes);
    const compressed = gzipSync(original);
    if (!gunzipSync(compressed, {maxOutputLength: maxBytes}).equals(original)) throw new Error("Compressed invocation log failed verification");
    const temporary = `${path}.${randomUUID()}.tmp`;
    const target = `${path}.gz`;
    const mode = statSync(path).mode & 0o777;
    const mtime = statSync(path).mtime;
    writeFileSync(temporary, compressed, {flag: "wx", mode});
    utimesSync(temporary, mtime, mtime);
    try {
      if (existsSync(target)) throw new Error("Compressed invocation log already exists");
      renameSync(temporary, target);
      rmSync(path);
    } catch (error) { if (existsSync(temporary)) rmSync(temporary); throw error; }
  }

  #scan(ownLock = false): Group[] {
    if (!existsSync(this.#runs)) return [];
    this.#assertRegularAncestry(this.#runs);
    const groups: Group[] = [];
    const entries = readdirSync(this.#runs, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name));
    const locked = !ownLock && entries.some(entry => entry.name === ".maintenance.lock");
    for (const runEntry of entries) {
      if (runEntry.name === ".maintenance.lock") continue;
      const runDirectory = join(this.#runs, runEntry.name);
      if (!runEntry.isDirectory() || runEntry.isSymbolicLink()) { groups.push({runId: runEntry.name, directory: runDirectory, files: [], logs: [], problems: ["unknown_run_entry"], latestMtime: 0}); continue; }
      const group: Group = {runId: runEntry.name, directory: runDirectory, files: [], logs: [], problems: locked ? ["maintenance_locked"] : [], latestMtime: 0};
      const walk = (directory: string, depth: number): void => {
        for (const entry of readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
          const path = join(directory, entry.name);
          if (entry.isSymbolicLink()) { group.problems.push("symlink"); continue; }
          if (entry.isDirectory()) {
            if ((depth === 0 && entry.name === "executions") || (depth === 1 && /^[a-zA-Z0-9_-]{1,200}$/u.test(entry.name))) walk(path, depth + 1);
            else group.problems.push("unknown_directory");
            continue;
          }
          if (!entry.isFile()) { group.problems.push("unknown_file_type"); continue; }
          if (depth === 0 && entry.name === "progress.json") continue;
          if (depth !== 2 || !knownName(entry.name)) group.problems.push("unknown_file");
          group.files.push(path);
          const info = lstatSync(path);
          group.latestMtime = Math.max(group.latestMtime, info.mtimeMs);
          if (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.gz")) group.logs.push(path);
        }
      };
      walk(runDirectory, 0);
      groups.push(group);
    }
    return groups;
  }

  #protection(group: Group): string | undefined {
    if (group.problems.length) return group.problems[0];
    if (group.runId === "unbound") return "unbound_run_status_unknown";
    if (!this.#isRunTerminal || this.#isRunTerminal(group.runId) !== true) return "run_not_confirmed_terminal";
    if (group.logs.length === 0) return "no_invocation_logs";
    for (const log of group.logs) {
      const plain = log.endsWith(".gz") ? log.slice(0, -3) : log;
      const seal = `${plain}.sealed`;
      if (!group.files.includes(seal)) return "unsealed_invocation_log";
      try {
        const value = JSON.parse(this.#readBoundedRegular(seal).toString("utf8")) as {schemaVersion?: unknown};
        if (value.schemaVersion !== "AgentInvocationSeal@1") return "invalid_invocation_seal";
      } catch { return "invalid_invocation_seal"; }
      if (group.files.includes(plain) && group.files.includes(`${plain}.gz`)) return "duplicate_log_representations";
    }
    for (const file of group.files) {
      const name = basename(file);
      const payload = PAYLOAD_NAME.exec(name.endsWith(".gz") ? name.slice(0, -3) : name);
      if (payload && !group.logs.some(log => basename(log) === payload[1] || basename(log) === `${payload[1]}.gz`)) return "orphan_payload";
      if (payload && group.files.includes(name.endsWith(".gz") ? file.slice(0, -3) : `${file}.gz`)) return "duplicate_payload_representations";
      if (name.endsWith(".sealed") && !group.logs.some(log => basename(log) === name.slice(0, -7) || basename(log) === `${name.slice(0, -7)}.gz`)) return "orphan_seal";
    }
    return undefined;
  }

  #assertInsideRuns(path: string): void {
    if (!isAbsolute(path)) throw new Error("Invocation log path must be absolute");
    const rel = relative(this.#runs, path);
    if (rel.startsWith("..") || rel === "" || isAbsolute(rel)) throw new Error("Invocation log path outside runtime");
  }

  #assertRegularAncestry(path: string): void {
    this.#assertInsideRuns(path === this.#runs ? join(path, "sentinel") : path);
    let cursor = path;
    while (cursor !== dirname(this.#runs)) {
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("Invocation log path contains symlink");
      if (cursor === this.#runs) break;
      cursor = dirname(cursor);
    }
  }

  #readBoundedRegular(path: string, maxBytes = MAX_READ_BYTES): Buffer {
    this.#assertRegularAncestry(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > maxBytes) throw new Error("Invocation log exceeds read limit");
      const bytes = readFileSync(fd);
      if (bytes.length > maxBytes) throw new Error("Invocation log exceeds read limit");
      return bytes;
    } finally { closeSync(fd); }
  }
}

function knownName(name: string): boolean {
  return LOG_NAME.test(name) || (name.endsWith(".gz") && LOG_NAME.test(name.slice(0, -3))) ||
    (name.endsWith(".sealed") && LOG_NAME.test(name.slice(0, -7))) || PAYLOAD_NAME.test(name) ||
    (name.endsWith(".gz") && PAYLOAD_NAME.test(name.slice(0, -3)));
}

function resolveOptions(options: MaintenanceOptions): Required<MaintenanceOptions> {
  const resolved = {now: options.now ?? new Date(), compressAfterDays: options.compressAfterDays ?? 7, cleanupAfterDays: options.cleanupAfterDays ?? 30, action: options.action ?? "all" as "compress" | "cleanup" | "all"};
  if (!Number.isFinite(resolved.now.getTime()) || !Number.isFinite(resolved.compressAfterDays) || !Number.isFinite(resolved.cleanupAfterDays) ||
    resolved.compressAfterDays < 0 || resolved.cleanupAfterDays < resolved.compressAfterDays) throw new Error("Invalid invocation maintenance age");
  return resolved;
}

function fingerprint(groups: readonly Group[], isRunTerminal: ((runId: string) => boolean | undefined) | undefined,
  options: Required<MaintenanceOptions>, actions: readonly MaintenanceAction[]): string {
  const digest = createHash("sha256");
  digest.update(JSON.stringify({action: options.action, compressAfterDays: options.compressAfterDays, cleanupAfterDays: options.cleanupAfterDays, actions}));
  // A live writer in an unrelated protected Run must not invalidate a cold Run's preview.
  // The action set still binds every selected group and changes when eligibility expands.
  const selected = new Set(actions.map(action => action.runId));
  for (const group of [...groups].filter(group => selected.has(group.runId)).sort((a, b) => a.runId.localeCompare(b.runId))) {
    digest.update(group.runId);
    digest.update(String(isRunTerminal?.(group.runId)));
    for (const path of [...group.files].sort()) {
      const info = lstatSync(path);
      digest.update(path).update(String(info.mode)).update(String(info.size)).update(String(info.mtimeMs));
      if (info.size <= MAX_READ_BYTES && knownName(basename(path))) digest.update(readFileSync(path));
    }
    for (const problem of group.problems) digest.update(problem);
  }
  return digest.digest("hex");
}
