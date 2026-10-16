import { createInterface } from "node:readline";

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface StdioMcpToolServer {
  readonly name: string;
  readonly version: string;
  readonly tools: readonly Record<string, unknown>[];
  call(name: string, args: unknown, signal?: AbortSignal): unknown | Promise<unknown>;
  close?(): void;
}

export async function runStdioMcpToolServer(server: StdioMcpToolServer): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = Promise.resolve();
  const calls = new Map<string | number | null, AbortController>();
  input.on("line", (line) => {
    try {
      const message: unknown = JSON.parse(line);
      if (record(message) && message.method === "notifications/cancelled" && record(message.params)) {
        const id = message.params.requestId;
        if (typeof id === "string" || typeof id === "number") calls.get(id)?.abort();
        return;
      }
      if (record(message) && message.method === "tools/call" &&
        (typeof message.id === "string" || typeof message.id === "number" || message.id === null)) {
        if (!calls.has(message.id)) calls.set(message.id, new AbortController());
      }
    } catch { /* Normal request handling reports malformed JSON. */ }
    pending = pending.then(() => handleLine(line, server, calls));
  });
  await new Promise<void>((resolve) => input.once("close", () => {
    for (const controller of calls.values()) controller.abort();
    resolve();
  }));
  await pending;
  server.close?.();
}

async function handleLine(line: string, server: StdioMcpToolServer, calls: Map<string | number | null, AbortController>): Promise<void> {
  let request: JsonRpcRequest;
  try {
    const value = JSON.parse(line) as unknown;
    if (!record(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
      throw new Error("invalid request");
    }
    request = value as unknown as JsonRpcRequest;
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (request.id === undefined) return;
  try {
    if (request.method === "initialize") {
      const params = record(request.params) ? request.params : {};
      write({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: typeof params.protocolVersion === "string"
            ? params.protocolVersion
            : "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: server.name, version: server.version }
        }
      });
      return;
    }
    if (request.method === "ping") {
      write({ jsonrpc: "2.0", id: request.id, result: {} });
      return;
    }
    if (request.method === "tools/list") {
      write({ jsonrpc: "2.0", id: request.id, result: { tools: server.tools } });
      return;
    }
    if (request.method === "tools/call") {
      const params = record(request.params) ? request.params : {};
      if (typeof params.name !== "string") throw new Error("tools/call name is required");
      try {
        const result = await server.call(params.name, params.arguments, calls.get(request.id)?.signal);
        write({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: record(result) ? result : { result },
            isError: false
          }
        });
      } catch (error) {
        write({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [{ type: "text", text: safeMcpError(error) }],
            isError: true
          }
        });
      }
      calls.delete(request.id);
      return;
    }
    write({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Method not found" }
    });
  } catch (error) {
    write({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32602, message: safeMcpError(error) }
    });
  }
}

export function safeMcpError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
