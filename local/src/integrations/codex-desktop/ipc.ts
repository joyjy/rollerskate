import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_FRAME = 2 * 1024 * 1024;
export const MAX_PUSH_BYTES = 65_536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Malformed IPC response");
  return value as ObjectValue;
}
function nonempty(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Missing IPC identity");
  return value;
}
class Rejected extends Error {}
class InactiveTurn extends Error {}

class DesktopConnection {
  readonly socket: Socket;
  readonly connected: Promise<void>;
  clientId: string | undefined;
  attempted = false;
  private buffer: Buffer = Buffer.alloc(0);
  private failure: Error | undefined;
  private pending: { requestId: string; resolve: (reply: ObjectValue) => void; reject: (error: Error) => void } | undefined;
  private readonly timer: NodeJS.Timeout;
  private unrelatedFrames = 0;

  constructor(path: string, timeoutMilliseconds: number) {
    this.socket = createConnection(path);
    this.connected = new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.socket.on("error", error => this.fail(error));
    this.socket.on("close", () => this.fail(new Error("IPC closed before receipt")));
    this.socket.on("data", chunk => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const size = this.buffer.readUInt32LE(0);
          if (size === 0 || size > MAX_FRAME) throw new Error("IPC frame exceeds response limit");
          if (this.buffer.length < size + 4) break;
          const reply = object(JSON.parse(this.buffer.subarray(4, size + 4).toString("utf8")));
          this.buffer = this.buffer.subarray(size + 4);
          if (this.pending !== undefined && reply.type === "response" && reply.requestId === this.pending.requestId) {
            const pending = this.pending;
            this.pending = undefined;
            pending.resolve(reply);
          } else if (++this.unrelatedFrames > 256) throw new Error("IPC exceeded unrelated frame limit");
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    this.timer = setTimeout(() => this.socket.destroy(new Error("IPC receipt deadline exceeded")), timeoutMilliseconds);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.pending?.reject(error);
    this.pending = undefined;
    this.socket.destroy();
  }

  async request(method: string, version: number, params: ObjectValue, target?: string, mutation = false): Promise<ObjectValue> {
    if (this.failure !== undefined) throw this.failure;
    const requestId = randomUUID();
    const data = Buffer.from(JSON.stringify({ type: "request", requestId, sourceClientId: this.clientId ?? null,
      version, method, params, timeoutMs: 15000, ...(target === undefined ? {} : { targetClientId: target }) }));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(data.length);
    const reply = await new Promise<ObjectValue>((resolve, reject) => {
      this.pending = { requestId, resolve, reject };
      // A write failure may follow a complete send. Never replay uncertain input.
      this.attempted ||= mutation;
      this.socket.write(Buffer.concat([prefix, data]));
    });
    if (reply.resultType !== "success") {
      const detail = JSON.stringify(reply).slice(0, 2000);
      if (reply.resultType === "error" && method === "thread-follower-steer-turn" && target !== undefined &&
          (reply.handledByClientId === undefined || reply.handledByClientId === target) &&
          reply.error === `Cannot steer conversation ${String(params.conversationId)} because its active turn already ended`) {
        // Desktop raises this exact error before submitting input; start once on that owner.
        throw new InactiveTurn(detail);
      }
      if (reply.resultType === "error" && (!mutation || ["no-client-found", "request-version-mismatch", "no-handler-for-request"].includes(String(reply.error)))) {
        throw new Rejected(detail);
      }
      throw new Error(detail);
    }
    if (reply.method !== method || (target !== undefined && reply.handledByClientId !== target)) throw new Error("IPC receipt owner or method mismatch");
    return reply;
  }

  close(): void {
    clearTimeout(this.timer);
    this.socket.destroy();
  }
}

export interface CodexPushReceipt {
  readonly schema: "CodexPushReceipt@1";
  readonly threadId: string;
  readonly messageId: string;
  status: "accepted" | "not_sent" | "rejected" | "unknown";
  ownerClientId?: string;
  turnId?: string;
  error?: string;
}

export interface CodexDesktopTransportOptions {
  readonly socketPath?: string;
  readonly timeoutMilliseconds?: number;
}

async function connectDesktopTarget(threadId: string, options: CodexDesktopTransportOptions) {
  if (!UUID.test(threadId)) throw new Error("threadId must be a full UUID");
  const timeout = options.timeoutMilliseconds ?? 20_000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60_000) throw new Error("timeout must be in (0,60000] milliseconds");
  const path = options.socketPath ?? join(homedir(), ".codex", "ipc", "ipc.sock");
  const [info, parent] = await Promise.all([stat(path), stat(dirname(path))]);
  const uid = process.getuid?.();
  if (uid === undefined || !info.isSocket() || info.uid !== uid || parent.uid !== uid || ((info.mode | parent.mode) & 0o022) !== 0) {
    throw new Error("IPC socket must be owned by this user and not writable by others");
  }
  const ipc = new DesktopConnection(path, timeout);
  try {
    await ipc.connected;
    ipc.clientId = nonempty(object((await ipc.request("initialize", 0, { clientType: "rollerskate-codex-desktop" })).result).clientId);
    const discovery = await ipc.request("thread-owner-discovery", 1, { hostId: "local", conversationId: threadId });
    const owner = nonempty(discovery.handledByClientId);
    if (object(discovery.result).supportsUntrustedAppInput !== true) throw new Error("No compatible local owner for this exact thread");
    return { ipc, owner };
  } catch (error) { ipc.close(); throw error; }
}

/** Discovery only. It neither steers nor starts a turn. */
export async function inspectCodexDesktopTarget(threadId: string, options: CodexDesktopTransportOptions = {}) {
  const { ipc, owner } = await connectDesktopTarget(threadId, options);
  try { return { threadId, ownerClientId: owner, supportsUntrustedAppInput: true as const }; }
  finally { ipc.close(); }
}

export async function pushToCodexDesktop(threadId: string, message: string, options: CodexDesktopTransportOptions = {}): Promise<CodexPushReceipt> {
  const receipt: CodexPushReceipt = { schema: "CodexPushReceipt@1", threadId, messageId: randomUUID(), status: "not_sent" };
  let ipc: DesktopConnection | undefined;
  try {
    if (!UUID.test(threadId)) throw new Error("threadId must be a full UUID");
    if (!message.trim() || Buffer.byteLength(message) > MAX_PUSH_BYTES) throw new Error("Message must contain 1..65536 UTF-8 bytes");
    const connected = await connectDesktopTarget(threadId, options);
    ipc = connected.ipc;
    const owner = connected.owner;
    receipt.ownerClientId = owner;
    const input = [{ type: "text", text: message, text_elements: [] }];
    try {
      const reply = await ipc.request("thread-follower-steer-turn", 1, { conversationId: threadId, input,
        restoreMessage: { context: {} }, clientUserMessageId: receipt.messageId }, owner, true);
      receipt.turnId = nonempty(object(object(reply.result).result).turnId);
    } catch (error) {
      if (!(error instanceof InactiveTurn)) throw error;
      const reply = await ipc.request("thread-follower-start-turn", 2, { conversationId: threadId,
        turnStart: { request: { threadId, input }, context: { inheritThreadSettings: true } } }, owner, true);
      receipt.turnId = nonempty(object(object(object(reply.result).result).turn).id);
    }
    receipt.status = "accepted";
  } catch (error) {
    receipt.status = error instanceof Rejected ? "rejected" : ipc?.attempted ? "unknown" : "not_sent";
    receipt.error = error instanceof Error ? error.message : String(error);
  } finally { ipc?.close(); }
  return receipt;
}
