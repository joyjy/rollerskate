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

const MAX_DISCOVERED_FILES = 2_000;
const MAX_METADATA_BYTES = 131_072;
const MAX_PREVIEW_BYTES = 524_288;
const MAX_THREAD_SCAN_BYTES = 8_388_608;
const MAX_OUTPUT_BYTES = 65_536;

export interface CodexThreadSourceOptions {
  readonly activeRoot: string;
  readonly archivedRoot: string;
  readonly excludedSessionId?: string;
  readonly excludeStartedAtOrAfter?: string;
}

export interface CodexThreadListInput {
  readonly since: string;
  readonly until: string;
  readonly limit: number;
}

export interface CodexThreadListItem {
  readonly reference: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly state: "active" | "archived";
  readonly workspace?: string;
  readonly preview: string;
}

export interface CodexThreadCoverage {
  readonly active: "available" | "missing" | "unsupported";
  readonly archived: "available" | "missing" | "unsupported";
  readonly discovered: number;
  readonly considered: number;
  readonly excluded: number;
}

export interface CodexThreadListResult {
  readonly items: readonly CodexThreadListItem[];
  readonly coverage: CodexThreadCoverage;
  readonly truncated: boolean;
}

export interface CodexThreadReadResult {
  readonly reference: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly messages: readonly {
    readonly role: "user" | "assistant";
    readonly occurredAt?: string;
    readonly content: string;
  }[];
  readonly scannedBytes: number;
  readonly truncated: boolean;
}

interface ThreadArtifact {
  readonly path: string;
  readonly state: "active" | "archived";
  readonly sessionId: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly workspace?: string;
}

interface Discovery {
  readonly artifacts: readonly ThreadArtifact[];
  readonly coverage: CodexThreadCoverage;
  readonly truncated: boolean;
}

export class CodexThreadSource {
  readonly #options: CodexThreadSourceOptions;

  public constructor(options: CodexThreadSourceOptions) {
    this.#options = options;
    if (options.excludeStartedAtOrAfter !== undefined) {
      isoTimestamp(options.excludeStartedAtOrAfter, "excludeStartedAtOrAfter");
    }
  }

  public list(input: CodexThreadListInput): CodexThreadListResult {
    const since = isoTimestamp(input.since, "since");
    const until = isoTimestamp(input.until, "until");
    if (Date.parse(since) >= Date.parse(until)) {
      throw new Error("Codex thread list requires since before until");
    }
    if (Date.parse(until) - Date.parse(since) > 31 * 24 * 60 * 60 * 1_000) {
      throw new Error("Codex thread list window exceeds 31 days");
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
      throw new Error("Codex thread list limit must be between 1 and 50");
    }
    const discovery = this.#discover();
    const matches = discovery.artifacts.filter((artifact) =>
      inWindow(artifact.startedAt, since, until) ||
      inWindow(artifact.updatedAt, since, until));
    const items = matches
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) ||
        right.startedAt.localeCompare(left.startedAt))
      .slice(0, input.limit)
      .map((artifact) => ({
        reference: reference(artifact.sessionId),
        startedAt: artifact.startedAt,
        updatedAt: artifact.updatedAt,
        state: artifact.state,
        ...(artifact.workspace === undefined ? {} : { workspace: artifact.workspace }),
        preview: preview(artifact.path)
      }));
    return {
      items,
      coverage: discovery.coverage,
      truncated: discovery.truncated || matches.length > input.limit
    };
  }

  public read(referenceValue: string): CodexThreadReadResult {
    if (!/^codex-thread:[a-f0-9]{24}$/.test(referenceValue)) {
      throw new Error("Codex thread reference is malformed or belongs to another client");
    }
    const discovery = this.#discover();
    const artifact = discovery.artifacts.find((candidate) =>
      reference(candidate.sessionId) === referenceValue);
    if (artifact === undefined) throw new Error("Codex thread reference is unavailable");
    const messages: Array<{
      role: "user" | "assistant";
      occurredAt?: string;
      content: string;
    }> = [];
    const scan = scanLines(artifact.path, MAX_THREAD_SCAN_BYTES, (line) => {
      const message = visibleMessage(line);
      if (message !== undefined) messages.push(message);
    });
    const selected = selectMessages(messages);
    return {
      reference: referenceValue,
      startedAt: artifact.startedAt,
      updatedAt: artifact.updatedAt,
      messages: selected,
      scannedBytes: scan.scannedBytes,
      truncated: scan.truncated || selected.length < messages.length
    };
  }

  #discover(): Discovery {
    const active = discoverRoot(this.#options.activeRoot, "active");
    const archived = discoverRoot(this.#options.archivedRoot, "archived");
    if (active.state !== "available" && archived.state !== "available") {
      throw new Error("Codex thread sources are unavailable or unsupported");
    }
    const candidates = [...active.paths, ...archived.paths];
    const bySession = new Map<string, ThreadArtifact>();
    let excluded = 0;
    for (const candidate of candidates) {
      const metadata = threadMetadata(candidate.path, candidate.state);
      if (metadata === undefined) continue;
      if (metadata.sessionId === this.#options.excludedSessionId ||
        (this.#options.excludeStartedAtOrAfter !== undefined &&
          metadata.startedAt >= this.#options.excludeStartedAtOrAfter)) {
        excluded += 1;
        continue;
      }
      const existing = bySession.get(metadata.sessionId);
      if (existing === undefined || existing.state === "archived") {
        bySession.set(metadata.sessionId, metadata);
      }
    }
    return {
      artifacts: [...bySession.values()],
      coverage: {
        active: active.state,
        archived: archived.state,
        discovered: candidates.length,
        considered: bySession.size,
        excluded
      },
      truncated: active.truncated || archived.truncated
    };
  }
}

function discoverRoot(
  root: string,
  state: "active" | "archived"
): {
  readonly state: "available" | "missing" | "unsupported";
  readonly paths: readonly { readonly path: string; readonly state: "active" | "archived" }[];
  readonly truncated: boolean;
} {
  if (!existsSync(root)) return { state: "missing", paths: [], truncated: false };
  if (lstatSync(root).isSymbolicLink() || !statSync(root).isDirectory()) {
    return { state: "unsupported", paths: [], truncated: false };
  }
  const paths: Array<{ path: string; state: "active" | "archived" }> = [];
  const pending = [root];
  while (pending.length > 0 && paths.length < MAX_DISCOVERED_FILES) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        paths.push({ path, state });
        if (paths.length === MAX_DISCOVERED_FILES) break;
      }
    }
  }
  return {
    state: "available",
    paths,
    truncated: pending.length > 0 || paths.length === MAX_DISCOVERED_FILES
  };
}

function threadMetadata(
  path: string,
  state: "active" | "archived"
): ThreadArtifact | undefined {
  let metadata: ThreadArtifact | undefined;
  scanLines(path, MAX_METADATA_BYTES, (line) => {
    if (metadata !== undefined) return;
    const value = parseRecord(line);
    const payload = record(value?.payload) ? value.payload : undefined;
    if (value?.type !== "session_meta" || payload === undefined) return;
    const sessionId = typeof payload.id === "string"
      ? payload.id
      : typeof payload.session_id === "string"
        ? payload.session_id
        : undefined;
    const timestamp = typeof payload.timestamp === "string"
      ? payload.timestamp
      : typeof value.timestamp === "string"
        ? value.timestamp
        : undefined;
    if (sessionId === undefined || timestamp === undefined ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId) ||
      Number.isNaN(Date.parse(timestamp))) return;
    const updatedAt = statSync(path).mtime.toISOString();
    const cwd = typeof payload.cwd === "string" && payload.cwd.trim() !== ""
      ? basename(payload.cwd)
      : undefined;
    metadata = {
      path,
      state,
      sessionId: sessionId.toLowerCase(),
      startedAt: new Date(timestamp).toISOString(),
      updatedAt: updatedAt < timestamp ? new Date(timestamp).toISOString() : updatedAt,
      ...(cwd === undefined ? {} : { workspace: redact(cwd, 128) })
    };
  });
  return metadata;
}

function preview(path: string): string {
  let result: string | undefined;
  scanLines(path, MAX_PREVIEW_BYTES, (line) => {
    if (result !== undefined) return;
    const message = visibleMessage(line);
    if (message?.role === "user") result = redact(message.content, 512);
  });
  return result ?? "[thread preview unavailable]";
}

function visibleMessage(line: string): {
  readonly role: "user" | "assistant";
  readonly occurredAt?: string;
  readonly content: string;
} | undefined {
  const value = parseRecord(line);
  const payload = record(value?.payload) ? value.payload : undefined;
  if (value?.type !== "event_msg" || payload === undefined ||
    (payload.type !== "user_message" && payload.type !== "agent_message")) return undefined;
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (message === "") return undefined;
  const occurredAt = typeof value.timestamp === "string" && !Number.isNaN(Date.parse(value.timestamp))
    ? new Date(value.timestamp).toISOString()
    : undefined;
  return {
    role: payload.type === "user_message" ? "user" : "assistant",
    ...(occurredAt === undefined ? {} : { occurredAt }),
    content: redact(message, 4_096)
  };
}

function selectMessages(
  messages: readonly {
    readonly role: "user" | "assistant";
    readonly occurredAt?: string;
    readonly content: string;
  }[]
): typeof messages {
  const candidates = messages.length <= 24
    ? messages
    : [...messages.slice(0, 6), ...messages.slice(-18)];
  const selected: typeof messages[number][] = [];
  let bytes = 0;
  for (const message of candidates) {
    const size = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (bytes + size > MAX_OUTPUT_BYTES) break;
    selected.push(message);
    bytes += size;
  }
  return selected;
}

function scanLines(
  path: string,
  maxBytes: number,
  visit: (line: string) => void
): { readonly scannedBytes: number; readonly truncated: boolean } {
  const size = statSync(path).size;
  const file = openSync(path, "r");
  const buffer = Buffer.alloc(65_536);
  let position = 0;
  let carry = Buffer.alloc(0);
  try {
    while (position < Math.min(size, maxBytes)) {
      const length = Math.min(buffer.length, maxBytes - position, size - position);
      const read = readSync(file, buffer, 0, length, position);
      if (read === 0) break;
      const chunk = Buffer.concat([carry, buffer.subarray(0, read)]);
      let start = 0;
      let newline = chunk.indexOf(0x0a, start);
      while (newline !== -1) {
        visit(chunk.subarray(start, newline).toString("utf8"));
        start = newline + 1;
        newline = chunk.indexOf(0x0a, start);
      }
      carry = Buffer.from(chunk.subarray(start));
      position += read;
    }
    if (position >= size && carry.length > 0) visit(carry.toString("utf8"));
    return { scannedBytes: position, truncated: position < size };
  } finally {
    closeSync(file);
  }
}

function reference(sessionId: string): string {
  return `codex-thread:${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
}

function redact(value: string, limit: number): string {
  return value
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_CREDENTIAL]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer [REDACTED]")
    .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, limit);
}

function isoTimestamp(value: string, field: string): string {
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    Number.isNaN(Date.parse(value))) {
    throw new Error(
      `Codex thread ${field} must be an ISO-8601 timestamp with Z or an explicit offset`
    );
  }
  return new Date(value).toISOString();
}

function inWindow(value: string, since: string, until: string): boolean {
  return Date.parse(value) >= Date.parse(since) && Date.parse(value) < Date.parse(until);
}

function parseRecord(line: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return record(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
