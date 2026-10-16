import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync
} from "node:fs";
import { basename, join } from "node:path";

export type ProviderActivityClient = "codex" | "claude-code" | "kimi-code" | "pi";

export interface ProviderActivityRecord {
  readonly source: ProviderActivityClient;
  readonly sessionId: string;
  readonly occurredAt: string;
  readonly summary: string;
  readonly reference: string;
}

export interface ProviderActivityCoverage {
  readonly source: ProviderActivityClient;
  readonly state: "available" | "unavailable" | "unsupported";
  readonly detail: string;
}

const MAX_DISCOVERED_FILES = 1_000;
const MAX_READ_BYTES = 65_536;
const MAX_SUMMARY_BYTES = 4_096;
const MAX_SEARCH_BYTES = 33_554_432;

export interface ProviderActivityRead {
  readonly records: readonly ProviderActivityRecord[];
  readonly coverage: ProviderActivityCoverage;
}

export interface ProviderActivitySearch {
  readonly records: readonly ProviderActivityRecord[];
  readonly truncated: boolean;
}

export interface ProviderActivitySearchOptions {
  readonly excludedSessionIds?: ReadonlySet<string>;
}

export class ProviderActivitySource {
  readonly #client: ProviderActivityClient;
  readonly #root: string;
  readonly #acceptPath: (path: string) => boolean;

  public constructor(
    client: ProviderActivityClient,
    root: string,
    acceptPath: (path: string) => boolean = () => true
  ) {
    this.#client = client;
    this.#root = root;
    this.#acceptPath = acceptPath;
  }

  public read(
    allowedSessionIds: ReadonlySet<string> | undefined,
    limit: number,
    excludedSessionIds: ReadonlySet<string> | undefined = undefined
  ): ProviderActivityRead {
    if (!existsSync(this.#root)) return {
      records: [],
      coverage: { source: this.#client, state: "unavailable", detail: "source root is absent" }
    };
    if (lstatSync(this.#root).isSymbolicLink() || !statSync(this.#root).isDirectory()) {
      return {
        records: [],
        coverage: { source: this.#client, state: "unsupported", detail: "source root is not regular" }
      };
    }
    try {
      const files = discover(this.#root, this.#client).filter(this.#acceptPath);
      const records = files.flatMap((path) => {
        const sessionId = providerSessionId(path, this.#client);
        if (sessionId === undefined ||
          excludedSessionIds?.has(sessionId) ||
          (allowedSessionIds !== undefined && !allowedSessionIds.has(sessionId))) return [];
        const occurredAt = statSync(path).mtime.toISOString();
        return [{
          source: this.#client,
          sessionId,
          occurredAt,
          summary: redact(extractSummary(readTail(path))),
          reference: `${this.#client}:${digest(path)}`
        } satisfies ProviderActivityRecord];
      }).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, limit);
      return {
        records,
        coverage: {
          source: this.#client,
          state: "available",
          detail: `discovered ${files.length} bounded session artifact(s)`
        }
      };
    } catch (error) {
      return {
        records: [],
        coverage: {
          source: this.#client,
          state: "unsupported",
          detail: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  public readReference(reference: string): ProviderActivityRecord | undefined {
    const match = reference.match(/^([a-z-]+):([a-f0-9]{24})(?::([a-f0-9]{1,16}))?$/);
    if (match?.[1] !== this.#client) {
      throw new Error("Client history reference belongs to another client");
    }
    if (!existsSync(this.#root)) {
      throw new Error("Client history source is unavailable");
    }
    if (lstatSync(this.#root).isSymbolicLink() || !statSync(this.#root).isDirectory()) {
      throw new Error("Client history source is unsupported");
    }
    for (const path of discover(this.#root, this.#client).filter(this.#acceptPath)) {
      if (digest(path) !== match[2]) continue;
      const sessionId = providerSessionId(path, this.#client);
      if (sessionId === undefined) return undefined;
      const offset = match[3] === undefined ? undefined : Number.parseInt(match[3], 16);
      return {
        source: this.#client,
        sessionId,
        occurredAt: statSync(path).mtime.toISOString(),
        summary: redact(extractSummary(offset === undefined
          ? readTail(path)
          : readWindow(path, offset))),
        reference
      };
    }
    return undefined;
  }

  public search(
    query: string,
    limit: number,
    options: ProviderActivitySearchOptions = {}
  ): ProviderActivitySearch {
    if (query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new Error("Client history search is malformed");
    }
    if (!existsSync(this.#root)) {
      throw new Error("Client history source is unavailable");
    }
    if (lstatSync(this.#root).isSymbolicLink() || !statSync(this.#root).isDirectory()) {
      throw new Error("Client history source is unsupported");
    }
    const needle = query.normalize("NFKC").toLocaleLowerCase("und");
    if (needle === "") {
      const read = this.read(undefined, limit + 1, options.excludedSessionIds);
      return { records: read.records.slice(0, limit), truncated: read.records.length > limit };
    }
    const records: ProviderActivityRecord[] = [];
    let scannedBytes = 0;
    const files = discover(this.#root, this.#client)
      .filter(this.#acceptPath)
      .filter((path) => {
        const sessionId = providerSessionId(path, this.#client);
        return sessionId !== undefined && !options.excludedSessionIds?.has(sessionId);
      })
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    for (const path of files) {
      if (scannedBytes >= MAX_SEARCH_BYTES || records.length > limit) break;
      const match = searchFile(path, needle, MAX_SEARCH_BYTES - scannedBytes);
      scannedBytes += match.scannedBytes;
      if (match.summary === undefined) continue;
      const sessionId = providerSessionId(path, this.#client);
      if (sessionId === undefined) continue;
      records.push({
        source: this.#client,
        sessionId,
        occurredAt: statSync(path).mtime.toISOString(),
        summary: redact(match.summary),
        reference: `${this.#client}:${digest(path)}:${match.offset.toString(16)}`
      });
    }
    return {
      records: records.slice(0, limit),
      truncated: records.length > limit || scannedBytes >= MAX_SEARCH_BYTES
    };
  }
}

function discover(root: string, client: ProviderActivityClient): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < MAX_DISCOVERED_FILES) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile() && isSessionArtifact(path, client)) {
        files.push(path);
        if (files.length === MAX_DISCOVERED_FILES) break;
      }
    }
  }
  return files;
}

function isSessionArtifact(path: string, client: ProviderActivityClient): boolean {
  if (client === "kimi-code") return basename(path) === "wire.jsonl";
  return path.endsWith(".jsonl") && !path.includes("/memory/");
}

function providerSessionId(path: string, client: ProviderActivityClient): string | undefined {
  if (client === "kimi-code") {
    return path.match(/\/session_([^/]+)\//)?.[1];
  }
  const name = basename(path, ".jsonl");
  if (client === "codex" || client === "pi") {
    return name.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i)?.[1];
  }
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(name) ? name : undefined;
}

function readTail(path: string): string {
  const size = statSync(path).size;
  const length = Math.min(size, MAX_READ_BYTES);
  const buffer = Buffer.alloc(length);
  const file = openSync(path, "r");
  try {
    readSync(file, buffer, 0, length, Math.max(0, size - length));
  } finally {
    closeSync(file);
  }
  return buffer.toString("utf8");
}

function readWindow(path: string, offset: number): string {
  const size = statSync(path).size;
  const start = Math.max(0, Math.min(size, offset) - 8_192);
  const length = Math.min(MAX_READ_BYTES, size - start);
  const buffer = Buffer.alloc(length);
  const file = openSync(path, "r");
  try {
    readSync(file, buffer, 0, length, start);
  } finally {
    closeSync(file);
  }
  return buffer.toString("utf8");
}

function searchFile(
  path: string,
  needle: string,
  byteBudget: number
): { readonly summary?: string; readonly offset: number; readonly scannedBytes: number } {
  const file = openSync(path, "r");
  const buffer = Buffer.alloc(65_536);
  let position = 0;
  let carry = Buffer.alloc(0);
  try {
    while (position < byteBudget) {
      const length = Math.min(buffer.length, byteBudget - position);
      const read = readSync(file, buffer, 0, length, position);
      if (read === 0) break;
      const chunk = Buffer.concat([carry, buffer.subarray(0, read)]);
      const chunkStart = position - carry.length;
      let lineStart = 0;
      let newline = chunk.indexOf(0x0a, lineStart);
      while (newline !== -1) {
        const line = chunk.subarray(lineStart, newline).toString("utf8");
        const summary = extractSummary(line);
        if (summary.normalize("NFKC").toLocaleLowerCase("und").includes(needle)) {
          return {
            summary,
            offset: chunkStart + lineStart,
            scannedBytes: position + read
          };
        }
        lineStart = newline + 1;
        newline = chunk.indexOf(0x0a, lineStart);
      }
      carry = Buffer.from(chunk.subarray(lineStart));
      position += read;
    }
    const trailing = extractSummary(carry.toString("utf8"));
    if (trailing.normalize("NFKC").toLocaleLowerCase("und").includes(needle)) {
      return {
        summary: trailing,
        offset: position - carry.length,
        scannedBytes: position
      };
    }
    return { offset: position, scannedBytes: position };
  } finally {
    closeSync(file);
  }
}

function extractSummary(content: string): string {
  const lines = content.split("\n").filter((line) => line.trim() !== "").slice(-50);
  const texts: string[] = [];
  for (const line of lines) {
    try {
      collectText(JSON.parse(line) as unknown, texts, "");
    } catch {
      continue;
    }
    if (Buffer.byteLength(texts.join("\n"), "utf8") >= MAX_SUMMARY_BYTES) break;
  }
  const summary = texts.join("\n").slice(0, MAX_SUMMARY_BYTES);
  return summary === "" ? "[session content unavailable]" : summary;
}

function collectText(value: unknown, output: string[], key: string): void {
  if (output.length >= 20 || /tool|output|credential|token|secret/i.test(key)) return;
  if (typeof value === "string") {
    if (/^(text|content|message|result|summary)$/i.test(key) && value.trim() !== "") {
      output.push(value.trim());
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output, key);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [childKey, child] of Object.entries(value)) collectText(child, output, childKey);
  }
}

export function redact(value: string, maxLength = MAX_SUMMARY_BYTES): string {
  return value
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_CREDENTIAL]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer [REDACTED]")
    .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, maxLength);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
