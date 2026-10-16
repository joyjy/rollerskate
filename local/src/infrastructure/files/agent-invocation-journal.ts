import { withInvocationLogLock } from "./agent-invocation-log-lock.js";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentInvocationJournal } from "../../core/runtime/agent-invocation.js";
import type { AgentInputEvent, ChatDispatchEvent } from "../../core/event/model.js";
import type { RuntimeExecution } from "../../core/runtime/model.js";

const INLINE_BYTES = 32 * 1024;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 1024 * 1024;

/** Invocation evidence, never an execution authority or a provider resume transcript. */
export class FileAgentInvocationJournal implements AgentInvocationJournal {
  public readonly path: string;
  readonly #directory: string;
  readonly #identity: Record<string, unknown>;
  readonly #secrets: readonly string[];
  readonly #onError: (error: unknown) => void;
  #fd: number | undefined;
  #sequence = 0;
  #bytes = 0;
  #limited = false;
  #terminal = false;
  #healthy = true;
  #providerSessionId: string | undefined;

  public constructor(runtimeDirectory: string, execution: RuntimeExecution,
    event: AgentInputEvent | ChatDispatchEvent, adapterId: string,
    options: {readonly secrets?: readonly string[]; readonly onError?: (error: unknown) => void} = {}) {
    this.#secrets = options.secrets ?? [];
    this.#onError = options.onError ?? ((error) => console.error("agent.invocation_journal_failed", error instanceof Error ? error.message : String(error)));
    const run = event.type === "agent.request" ? event.runContext : undefined;
    const directory = join(runtimeDirectory, "runs");
    privateDirectory(directory);
    const ownerDirectory = join(directory, safeSegment(run?.runId ?? "unbound"));
    privateDirectory(ownerDirectory);
    const executionsDirectory = join(ownerDirectory, "executions");
    privateDirectory(executionsDirectory);
    this.#directory = join(executionsDirectory, safeSegment(execution.executionId));
    privateDirectory(this.#directory);
    this.path = join(this.#directory, `attempt-${execution.attemptCount}-${randomUUID()}.jsonl`);
    this.#identity = {executionId: execution.executionId, attempt: execution.attemptCount,
      eventId: event.eventId, agentId: event.agentId, adapterId, sessionId: event.sessionId,
      runId: run?.runId, stepId: run?.stepId, cycleId: run?.cycleId, parentStepId: run?.parentStepId, rootEventId: event.causality.rootEventId};
    this.#fd = withInvocationLogLock(runtimeDirectory, () => openSync(this.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
  }

  public append(kind: string, data?: unknown): void {
    if (this.#fd === undefined) return;
    try {
      if (data !== null && typeof data === "object" && "providerSessionId" in data && typeof data.providerSessionId === "string") {
        this.#providerSessionId = data.providerSessionId;
      }
      const terminal = kind === "invocation.completed" || kind === "invocation.failed" || kind === "execution.state";
      if (this.#limited && !terminal) return;
      // Reasoning content is intentionally excluded even if a caller passes data.
      const serialized = JSON.stringify(redact(kind === "thought" ? undefined : data, this.#secrets));
      let payload: unknown = serialized === undefined ? undefined : JSON.parse(serialized);
      const bytes = Buffer.byteLength(serialized ?? "", "utf8");
      if (!terminal && this.#bytes + bytes > MAX_BYTES) {
        this.#limited = true;
        this.#write("output.truncated", {reason: "invocation_byte_limit", maxBytes: MAX_BYTES});
        return;
      }
      if (bytes > MAX_PAYLOAD_BYTES) {
        payload = {omitted: true, reason: "payload_byte_limit", originalBytes: bytes};
      } else if (bytes > INLINE_BYTES) {
        const name = `${this.path.slice(this.path.lastIndexOf("/") + 1)}.${this.#sequence + 1}.payload.json`;
        const fd = openSync(join(this.#directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeAll(fd, `${serialized}\n`); fsyncSync(fd); } finally { closeSync(fd); }
        payload = {file: name, bytes};
        this.#bytes += bytes;
      }
      this.#write(kind, payload);
      if (terminal) this.#terminal = true;
    } catch (error) {
      // Never turn a diagnostic disk failure after tool execution into a retry.
      this.#healthy = false;
      this.close();
      this.#onError(error);
    }
  }

  public close(): void {
    if (this.#fd === undefined) return;
    const fd = this.#fd;
    this.#fd = undefined;
    let flushed = false;
    try { fsyncSync(fd); flushed = true; }
    catch (error) { this.#onError(error); }
    finally { try { closeSync(fd); } catch (error) { flushed = false; this.#onError(error); } }
    if (flushed && this.#terminal && this.#healthy) {
      try { writeFileSync(`${this.path}.sealed`, JSON.stringify({schemaVersion: "AgentInvocationSeal@1"}), {flag: "wx", mode: 0o600}); }
      catch (error) { this.#onError(error); }
    }
  }

  #write(kind: string, data: unknown): void {
    const line = JSON.stringify({schemaVersion: "AgentInvocationLog@1", ...this.#identity,
      providerSessionId: this.#providerSessionId, sequence: ++this.#sequence, at: new Date().toISOString(), kind, data}) + "\n";
    writeAll(this.#fd!, line);
    // writeSync makes complete records visible during execution and after process death.
    // close() fsyncs before sealing; power loss can still lose an active tail.
    this.#bytes += Buffer.byteLength(line, "utf8");
  }
}

function writeAll(fd: number, value: string): void {
  const bytes = Buffer.from(value);
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

function privateDirectory(path: string): void {
  try { mkdirSync(path, {mode: 0o700}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Invocation log directory must be private and regular: ${path}`);
  }
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,200}$/u.test(value)) throw new Error("Invalid invocation log identity");
  return value;
}

function redact(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 30) return "[depth limit]";
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join("[REDACTED]");
    return text.replace(/\bBearer\s+[^\s"'<>]+/giu, "Bearer [REDACTED]")
      .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{20,})\b/gu, "[REDACTED]")
      .replace(/((?:api[_-]?key|(?:access[_-]?)?token|password|secret)["']?\s*[=:]\s*["']?)[^\s,;"']+/giu, "$1[REDACTED]")
      .replace(/(\b(?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/giu, "$1[REDACTED]")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[REDACTED]@");
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets, depth + 1));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /(?:authorization|cookie|password|secret|token|api[_-]?key|credential|thinking|reasoning)/iu.test(key)
      ? "[REDACTED]" : redact(item, secrets, depth + 1)]));
  return value;
}
