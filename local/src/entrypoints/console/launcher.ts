import { createReadStream, existsSync, lstatSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";

import {
  controlPollSubscription,
  inspectPollSubscription,
  listPollSubscriptions,
  pollSubscriptionView
} from "../../application/subscription-control.js";
import {
  runtimeConsoleView,
  type RuntimeControlResultView
} from "../../application/runtime-console.js";
import { reconcileRuntime, setLoopPaused } from "../../application/loop-control.js";
import { runtimeTrace, runtimeTraces } from "../../application/runtime-audit.js";
import {
  addLocalAgent,
  agentConsoleList,
  localRuntimeSnapshot,
  renameLocalAgent,
  resumeLocalAgent,
  suspendLocalAgent
} from "../../application/local-agent-control.js";
import {
  dispatchLocalChatMessage,
  localChatView,
  postLocalChatMessage,
  rotateLocalAgentSession
} from "../../application/local-chat-control.js";

export interface UiServerOptions {
  readonly repoRoot: string;
  readonly runtimeDirectory?: string;
  readonly port: number;
  readonly signal: AbortSignal;
  readonly output?: { readonly write: (text: string) => void };
}

export interface UiServerHandle {
  readonly url: string;
  readonly close: () => Promise<void>;
}

export async function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  const uiRoot = resolve(options.repoRoot, "local", "ui");
  const distDir = join(uiRoot, "dist");

  if (existsSync(distDir) && lstatSync(distDir).isDirectory()) {
    return startStaticServer({ ...options, distDir });
  }

  throw new Error(
    "Local UI build is missing; run npm --prefix local/ui install && npm run build"
  );
}

interface StaticStartOptions extends UiServerOptions {
  readonly distDir: string;
}

function startStaticServer(options: StaticStartOptions): Promise<UiServerHandle> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/api/runtime" || url.pathname.startsWith("/api/runtime/")) {
        if (url.pathname !== "/api/runtime/events" &&
          !url.pathname.startsWith("/api/runtime/events/")) {
          serveRuntimeApi(
            options.repoRoot,
            options.runtimeDirectory,
            request.method ?? "GET",
            request.headers["x-rollerskate-request"],
            request.headers.host ?? "127.0.0.1",
            url,
            response
          );
          return;
        }
      }
      if (url.pathname === "/api/runtime/events" ||
        url.pathname.startsWith("/api/runtime/events/")) {
        serveRuntimeAuditApi(
          options.repoRoot,
          options.runtimeDirectory,
          request.method ?? "GET",
          url,
          response
        );
        return;
      }
      if (url.pathname === "/api/subscriptions" || url.pathname.startsWith("/api/subscriptions/")) {
        serveSubscriptionApi(
          options.repoRoot,
          options.runtimeDirectory,
          request.method ?? "GET",
          request.headers["x-rollerskate-request"],
          url,
          response
        );
        return;
      }
      if (url.pathname === "/api/local" || url.pathname === "/api/agents" ||
        url.pathname.startsWith("/api/agents/")) {
        void serveLocalAgentApi(
          options.repoRoot,
          options.runtimeDirectory,
          request,
          request.headers["x-rollerskate-request"],
          url,
          response
        );
        return;
      }
      if (url.pathname === "/api/chat" || url.pathname.startsWith("/api/chat/")) {
        void serveLocalChatApi(
          options.repoRoot,
          options.runtimeDirectory,
          request,
          request.headers["x-rollerskate-request"],
          url,
          response
        );
        return;
      }
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        json(response, 404, { error: "not_found" });
        return;
      }
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/") pathname = "/index.html";
      if (pathname === "/console/") pathname = "/console/index.html";
      if (pathname.startsWith("/console/")) pathname = pathname.slice("/console".length);
      const filePath = join(options.distDir, pathname);

      if (!isInside(options.distDir, filePath)) {
        response.writeHead(403).end("Forbidden");
        return;
      }

      const serveFile = (targetPath: string, fallback = true): void => {
        const stream = createReadStream(targetPath);
        stream.on("error", () => {
          if (fallback) {
            const indexPath = join(options.distDir, "index.html");
            if (existsSync(indexPath)) {
              response.writeHead(200, { "Content-Type": "text/html" });
              createReadStream(indexPath).pipe(response);
              return;
            }
          }
          response.writeHead(404).end("Not found");
        });
        stream.on("open", () => {
          const contentType = guessContentType(targetPath);
          response.writeHead(200, { "Content-Type": contentType });
          stream.pipe(response);
        });
      };

      serveFile(filePath);
    });

    const abortHandler = (): void => {
      server.close();
    };
    options.signal.addEventListener("abort", abortHandler, { once: true });

    server.listen(options.port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolvePromise({
        url: `http://localhost:${address.port}/console/`,
        close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      });
    });

    server.once("error", (error) => rejectPromise(error));
  });
}

async function serveLocalChatApi(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  request: import("node:http").IncomingMessage,
  requestMarker: string | readonly string[] | undefined,
  url: URL,
  response: import("node:http").ServerResponse
): Promise<void> {
  const method = request.method ?? "GET";
  const options = runtimeDirectory === undefined ? {} : { runtimeDirectory };
  try {
    if (url.pathname === "/api/chat" && method === "GET") {
      json(response, 200, localChatView(repoRoot, options));
      return;
    }
    if (requestMarker !== "console") {
      json(response, 403, { error: "console_request_marker_required" });
      return;
    }
    if (url.pathname === "/api/chat/messages" && method === "POST") {
      const body = await readJsonBody(request);
      json(response, 201, postLocalChatMessage(
        repoRoot,
        requireString(body, "body"),
        options
      ));
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (method === "POST" && parts.length === 5 &&
      parts[1] === "chat" && parts[2] === "messages" && parts[4] === "dispatch") {
      const body = await readJsonBody(request);
      json(response, 200, dispatchLocalChatMessage(
        repoRoot,
        parts[3]!,
        requireString(body, "principalId"),
        options
      ));
      return;
    }
    if (method === "POST" && parts.length === 5 &&
      parts[1] === "chat" && parts[2] === "agents" && parts[4] === "new-session") {
      json(response, 200, {
        generation: rotateLocalAgentSession(repoRoot, parts[3]!, options)
      });
      return;
    }
    json(response, method === "GET" ? 404 : 405, {
      error: method === "GET" ? "not_found" : "method_not_allowed"
    });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function serveLocalAgentApi(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  request: import("node:http").IncomingMessage,
  requestMarker: string | readonly string[] | undefined,
  url: URL,
  response: import("node:http").ServerResponse
): Promise<void> {
  const method = request.method ?? "GET";
  const options = runtimeDirectory === undefined ? {} : { runtimeDirectory };
  try {
    if (url.pathname === "/api/local" && method === "GET") {
      json(response, 200, localRuntimeSnapshot(repoRoot, options));
      return;
    }
    if (url.pathname === "/api/agents" && method === "GET") {
      json(response, 200, agentConsoleList(repoRoot, options));
      return;
    }
    if (requestMarker !== "console") {
      json(response, 403, { error: "console_request_marker_required" });
      return;
    }
    if (url.pathname === "/api/agents" && method === "POST") {
      const body = await readJsonBody(request);
      const client = requireString(body, "client");
      if (client !== "codex") {
        throw new Error("client must be codex");
      }
      json(response, 201, addLocalAgent(
        repoRoot,
        requireString(body, "handle"),
        client,
        options
      ));
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const principalId = parts[2];
    const action = parts[3];
    if (method === "POST" && principalId !== undefined && action !== undefined &&
      parts.length === 4) {
      if (action === "rename") {
        const body = await readJsonBody(request);
        json(response, 200, renameLocalAgent(
          repoRoot,
          principalId,
          requireString(body, "handle"),
          options
        ));
        return;
      }
      if (action === "suspend") {
        json(response, 200, suspendLocalAgent(repoRoot, principalId, options));
        return;
      }
      if (action === "resume") {
        json(response, 200, resumeLocalAgent(repoRoot, principalId, options));
        return;
      }
    }
    json(response, method === "GET" ? 404 : 405, {
      error: method === "GET" ? "not_found" : "method_not_allowed"
    });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

async function readJsonBody(
  request: import("node:http").IncomingMessage
): Promise<Readonly<Record<string, unknown>>> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (Buffer.byteLength(body, "utf8") > 65_536) {
      throw new Error("request_body_too_large");
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(body || "{}") as unknown;
  } catch {
    throw new Error("request_body_must_be_json");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("request_body_must_be_object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: Readonly<Record<string, unknown>>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return candidate;
}

function serveRuntimeApi(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  method: string,
  requestMarker: string | readonly string[] | undefined,
  consoleAddress: string,
  url: URL,
  response: import("node:http").ServerResponse
): void {
  try {
    if (url.pathname === "/api/runtime" && method === "GET") {
      json(response, 200, runtimeConsoleView(
        repoRoot,
        runtimeDirectory,
        consoleAddress
      ));
      return;
    }
    const action = url.pathname.split("/").filter(Boolean)[2];
    if (method === "POST" && (action === "pause" || action === "resume" || action === "recover")) {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      let controlResult: RuntimeControlResultView;
      if (action === "recover") {
        const recovered = reconcileRuntime(repoRoot, runtimeDirectory);
        controlResult = {
          kind: "recover",
          status: "succeeded",
          message: `Reconciled ${recovered} interrupted item(s).`,
          recovered,
          leftUnknown: 0,
          failed: 0
        };
      } else {
        setLoopPaused(repoRoot, action === "pause", runtimeDirectory);
        controlResult = {
          kind: action,
          status: "succeeded",
          message: action === "pause"
            ? "Durable pause requested; in-flight provider calls may still finish."
            : "Durable pause cleared; the next loop cycle may claim work."
        };
      }
      json(response, 200, runtimeConsoleView(
        repoRoot,
        runtimeDirectory,
        consoleAddress,
        controlResult
      ));
      return;
    }
    json(response, method === "GET" ? 404 : 405, {
      error: method === "GET" ? "not_found" : "method_not_allowed"
    });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function serveRuntimeAuditApi(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  method: string,
  url: URL,
  response: import("node:http").ServerResponse
): void {
  if (method !== "GET") {
    json(response, 405, { error: "method_not_allowed" });
    return;
  }
  try {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length === 3) {
      json(response, 200, runtimeTraces(repoRoot, runtimeDirectory));
      return;
    }
    if (parts.length === 4) {
      json(response, 200, runtimeTrace(repoRoot, parts[3]!, runtimeDirectory));
      return;
    }
    json(response, 404, { error: "not_found" });
  } catch (error) {
    json(response, 404, { error: error instanceof Error ? error.message : String(error) });
  }
}

function serveSubscriptionApi(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  method: string,
  requestMarker: string | readonly string[] | undefined,
  url: URL,
  response: import("node:http").ServerResponse
): void {
  try {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length === 2 && method === "GET") {
      json(response, 200, listPollSubscriptions(repoRoot, runtimeDirectory)
        .map(pollSubscriptionView));
      return;
    }
    const subscriptionId = parts[2];
    if (subscriptionId === undefined) {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (parts.length === 3 && method === "GET") {
      json(response, 200, pollSubscriptionView(
        inspectPollSubscription(repoRoot, subscriptionId, runtimeDirectory)
      ));
      return;
    }
    const action = parts[3];
    if (parts.length === 4 && method === "POST" &&
      (action === "pause" || action === "resume" || action === "cancel")) {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      const subscription = controlPollSubscription(
        repoRoot,
        subscriptionId,
        action,
        runtimeDirectory
      );
      json(response, 200, pollSubscriptionView(subscription));
      return;
    }
    json(response, 405, { error: "method_not_allowed" });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function json(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function isInside(base: string, target: string): boolean {
  const relative = target.slice(base.length);
  return target.startsWith(base) && !relative.startsWith("..") && !relative.startsWith("/..") && !relative.includes("/../");
}

function guessContentType(filePath: string): string {
  const map: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
  };
  return map[extname(filePath).toLowerCase()] || "application/octet-stream";
}
