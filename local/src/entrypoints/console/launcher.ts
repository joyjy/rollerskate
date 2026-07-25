import { existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  controlPollSubscription,
  inspectPollSubscription,
  listPollSubscriptions,
  pollSubscriptionView
} from "../../application/subscription/control.js";
import {
  runtimeOperationsView,
  type RuntimeControlResultView
} from "../../application/runtime/query.js";
import { controlRuntime } from "../../application/runtime/control.js";
import {
  eventTrace,
  listEventTraces
} from "../../application/event/query.js";
import {
  inspectRuntimeFailure,
  listRuntimeFailures
} from "../../application/runtime/failure-query.js";
import {
  addLocalAgent,
  configureLocalAgent,
  inspectAgent,
  isAgentClient,
  listAgents,
  localRuntimeSnapshot,
  renameLocalAgent,
  resumeLocalAgent,
  suspendLocalAgent
} from "../../application/agent/control.js";
import {
  dispatchLocalChatMessage,
  localChatPresenceView,
  localChatView,
  postLocalChatMessage,
  rotateLocalAgentSession,
  setLocalChatPresence
} from "../../application/chat/control.js";
import {
  inspectReviewView,
  listReviewViews,
  reviewDetailView
} from "../../application/review/query.js";
import { recoverReview } from "../../application/review/control.js";
import {
  inspectScheduleView,
  listScheduledRunViews,
  listScheduleViews,
  scheduleDetailView,
  scheduledRunView,
  traceScheduledRunView
} from "../../application/schedule/query.js";
import {
  controlSchedule,
  inspectSchedule,
  resolveUnknownScheduledRun,
  runScheduleNow
} from "../../application/schedule/control.js";
import {
  inspectNoticeView,
  noticeCenterView
} from "../../application/notice/query.js";
import {
  acknowledgeNotice,
  markNoticeRead,
  rebuildNoticeIndex
} from "../../application/notice/control.js";

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
  const indexPath = join(uiRoot, "index.html");
  if (!existsSync(indexPath)) {
    throw new Error(`Local UI source is missing: ${indexPath}`);
  }
  const vite = await loadVite(uiRoot);
  return startSourceServer({
    ...options,
    uiRoot,
    createViteServer: vite.createServer
  });
}

interface ViteDevServer {
  readonly middlewares: (
    request: IncomingMessage,
    response: ServerResponse,
    next: (error?: unknown) => void
  ) => void;
  readonly close: () => Promise<void>;
}

interface ViteModule {
  readonly createServer: (options: {
    readonly root: string;
    readonly configFile: string;
    readonly appType: "spa";
    readonly server: {
      readonly middlewareMode: true;
      readonly hmr: { readonly server: Server };
    };
    readonly optimizeDeps?: {
      readonly noDiscovery: true;
      readonly include: readonly [];
    };
  }) => Promise<ViteDevServer>;
}

interface SourceStartOptions extends UiServerOptions {
  readonly uiRoot: string;
  readonly createViteServer: ViteModule["createServer"];
}

async function startSourceServer(options: SourceStartOptions): Promise<UiServerHandle> {
  let viteServer: ViteDevServer | undefined;
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
        url.pathname.startsWith("/api/runtime/events/") ||
        url.pathname === "/api/events" ||
        url.pathname.startsWith("/api/events/")) {
        serveEventApi(
          options.repoRoot,
          options.runtimeDirectory,
          request.method ?? "GET",
          url,
          response
        );
        return;
      }
      if (url.pathname === "/api/failures" || url.pathname.startsWith("/api/failures/")) {
        serveRuntimeFailureApi(
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
      if (url.pathname === "/api/reviews" || url.pathname.startsWith("/api/reviews/")) {
        serveReviewApi(
          options.repoRoot,
          options.runtimeDirectory,
          request.method ?? "GET",
          request.headers["x-rollerskate-request"],
          url,
          response
        );
        return;
      }
      if (url.pathname === "/api/schedules" || url.pathname.startsWith("/api/schedules/")) {
        void serveScheduleApi(
          options.repoRoot,
          options.runtimeDirectory,
          request,
          request.headers["x-rollerskate-request"],
          url,
          response
        );
        return;
      }
      if (url.pathname === "/api/notices" || url.pathname.startsWith("/api/notices/")) {
        serveNoticeApi(
          options.repoRoot,
          options.runtimeDirectory,
          request.method ?? "GET",
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
      if (url.pathname === "/") {
        response.writeHead(302, { Location: "/console/" }).end();
        return;
      }
      if (viteServer === undefined) {
        response.writeHead(503).end("Console source runtime is starting");
        return;
      }
      viteServer.middlewares(request, response, (error) => {
        if (response.writableEnded) return;
        if (error !== undefined) {
          options.output?.write(
            `Console source request failed: ${error instanceof Error ? error.message : String(error)}\n`
          );
          response.writeHead(500).end("Console source request failed");
          return;
        }
        response.writeHead(404).end("Not found");
      });
    });
  try {
    viteServer = await options.createViteServer({
      root: options.uiRoot,
      configFile: join(options.uiRoot, "vite.config.ts"),
      appType: "spa",
      server: {
        middlewareMode: true,
        hmr: { server }
      },
      ...(options.port === 0
        ? { optimizeDeps: { noDiscovery: true, include: [] } }
        : {})
    });
    await listen(server, options.port);
  } catch (error) {
    await viteServer?.close();
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= closeSourceServer(server, viteServer!);
    return closePromise;
  };
  const abortHandler = (): void => {
    void close();
  };
  options.signal.addEventListener("abort", abortHandler, { once: true });
  if (options.signal.aborted) await close();
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error("Console source runtime stopped during startup");
  return {
    url: `http://localhost:${address.port}/console/`,
    close: async () => {
      options.signal.removeEventListener("abort", abortHandler);
      await close();
    }
  };
}

async function loadVite(uiRoot: string): Promise<ViteModule> {
  try {
    const requireFromUi = createRequire(join(uiRoot, "package.json"));
    const entry = requireFromUi.resolve("vite");
    const vite = await import(pathToFileURL(entry).href) as Partial<ViteModule>;
    if (typeof vite.createServer !== "function") {
      throw new Error("Vite createServer export is unavailable");
    }
    return vite as ViteModule;
  } catch (error) {
    throw new Error(
      "Console source runtime requires Vite; run npm install at the repository root",
      { cause: error }
    );
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectPromise(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function closeSourceServer(server: Server, vite: ViteDevServer): Promise<void> {
  await vite.close();
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
  });
}

function serveNoticeApi(
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
      const limitValue = url.searchParams.get("limit");
      const limit = limitValue === null
        ? 100
        : parseBoundedQueryInteger(limitValue, "notice limit", 1, 1_000);
      json(response, 200, noticeCenterView(repoRoot, runtimeDirectory, limit));
      return;
    }
    if (parts.length === 3 && parts[2] === "rebuild" && method === "POST") {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      json(response, 200, rebuildNoticeIndex(repoRoot, runtimeDirectory));
      return;
    }
    const noticeId = parts[2];
    if (noticeId === undefined) {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (parts.length === 3 && method === "GET") {
      json(response, 200, inspectNoticeView(repoRoot, noticeId, runtimeDirectory));
      return;
    }
    if (requestMarker !== "console") {
      json(response, 403, { error: "console_request_marker_required" });
      return;
    }
    const action = parts[3];
    if (parts.length === 4 && method === "POST" &&
      (action === "mark-read" || action === "ack")) {
      json(response, 200, action === "mark-read"
        ? markNoticeRead(repoRoot, noticeId, runtimeDirectory)
        : acknowledgeNotice(repoRoot, noticeId, runtimeDirectory));
      return;
    }
    json(response, method === "GET" ? 404 : 405, {
      error: method === "GET" ? "not_found" : "method_not_allowed"
    });
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

function serveReviewApi(
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
      const limitValue = url.searchParams.get("limit");
      const limit = limitValue === null
        ? 100
        : parseBoundedQueryInteger(limitValue, "review limit", 1, 200);
      json(response, 200, listReviewViews(repoRoot, runtimeDirectory, limit));
      return;
    }
    const rootEventId = parts[2];
    if (rootEventId === undefined) {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (parts.length === 3 && method === "GET") {
      json(response, 200, inspectReviewView(repoRoot, rootEventId, runtimeDirectory));
      return;
    }
    if (parts.length === 4 && parts[3] === "recover" && method === "POST") {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      json(response, 200, reviewDetailView(
        recoverReview(repoRoot, rootEventId, runtimeDirectory)
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

async function serveScheduleApi(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  request: import("node:http").IncomingMessage,
  requestMarker: string | readonly string[] | undefined,
  url: URL,
  response: import("node:http").ServerResponse
): Promise<void> {
  const method = request.method ?? "GET";
  try {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length === 2 && method === "GET") {
      json(response, 200, listScheduleViews(repoRoot, runtimeDirectory));
      return;
    }
    const scheduleId = parts[2];
    if (scheduleId === undefined) {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (parts.length === 3 && method === "GET") {
      json(response, 200, inspectScheduleView(repoRoot, scheduleId, runtimeDirectory));
      return;
    }
    if (parts.length === 4 && parts[3] === "runs" && method === "GET") {
      const limitValue = url.searchParams.get("limit");
      const limit = limitValue === null
        ? 100
        : parseBoundedQueryInteger(limitValue, "scheduled run limit", 1, 200);
      json(response, 200, listScheduledRunViews(
        repoRoot,
        scheduleId,
        runtimeDirectory,
        limit
      ));
      return;
    }
    const runId = parts[4];
    if (parts.length === 5 && parts[3] === "runs" && runId !== undefined &&
      method === "GET") {
      const run = traceScheduledRunView(repoRoot, runId, runtimeDirectory);
      if (run.scheduleId !== scheduleId) throw new Error("run does not belong to Schedule");
      json(response, 200, run);
      return;
    }
    if (requestMarker !== "console") {
      json(response, 403, { error: "console_request_marker_required" });
      return;
    }
    const action = parts[3];
    if (parts.length === 4 && method === "POST" &&
      (action === "pause" || action === "resume" || action === "cancel")) {
      json(response, 200, scheduleDetailView(
        controlSchedule(repoRoot, scheduleId, action, runtimeDirectory)
      ));
      return;
    }
    if (parts.length === 4 && method === "POST" && action === "run-now") {
      const body = await readJsonBody(request);
      const receipt = runScheduleNow(
        repoRoot,
        scheduleId,
        requireString(body, "requestId"),
        runtimeDirectory
      );
      json(response, 200, {
        receipt,
        schedule: inspectScheduleView(repoRoot, scheduleId, runtimeDirectory)
      });
      return;
    }
    if (parts.length === 6 && parts[3] === "runs" && runId !== undefined &&
      parts[5] === "resolve" && method === "POST") {
      const body = await readJsonBody(request);
      const outcome = requireString(body, "outcome");
      if (outcome !== "succeeded" && outcome !== "failed") {
        throw new Error("outcome must be succeeded or failed");
      }
      const run = resolveUnknownScheduledRun(
        repoRoot,
        runId,
        outcome,
        runtimeDirectory
      );
      if (run.run.scheduleId !== scheduleId) {
        throw new Error("run does not belong to Schedule");
      }
      json(response, 200, {
        run: scheduledRunView(run),
        schedule: scheduleDetailView(
          inspectSchedule(repoRoot, scheduleId, runtimeDirectory)
        )
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
      const beforeEventId = url.searchParams.get("before") ?? undefined;
      const limitValue = url.searchParams.get("limit");
      const limit = limitValue === null
        ? undefined
        : parseBoundedQueryInteger(limitValue, "chat history limit", 1, 200);
      json(response, 200, localChatView(repoRoot, options, {
        ...(beforeEventId === undefined ? {} : { beforeEventId }),
        ...(limit === undefined ? {} : { limit })
      }));
      return;
    }
    if (url.pathname === "/api/chat/presence" && method === "GET") {
      json(response, 200, localChatPresenceView(repoRoot, options));
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
      parts[1] === "chat" && parts[2] === "agents" && parts[4] === "presence") {
      const body = await readJsonBody(request);
      const mode = requireString(body, "mode");
      json(response, 200, setLocalChatPresence(
        repoRoot,
        parts[3]!,
        {
          scope: "topic",
          mode,
          ...(mode === "snoozed" ? { until: requireString(body, "until") } : {}),
          wakeKeywords: []
        },
        options
      ));
      return;
    }
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

function parseBoundedQueryInteger(
  value: string,
  field: string,
  minimum: number,
  maximum: number
): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
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
      json(response, 200, listAgents(repoRoot, options));
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (method === "GET" && parts.length === 3 && parts[1] === "agents") {
      json(response, 200, inspectAgent(repoRoot, parts[2]!, options));
      return;
    }
    if (requestMarker !== "console") {
      json(response, 403, { error: "console_request_marker_required" });
      return;
    }
    if (url.pathname === "/api/agents" && method === "POST") {
      const body = await readJsonBody(request);
      const client = requireString(body, "client");
      if (!isAgentClient(client)) {
        throw new Error("client must be codex, claude-code or kimi-code");
      }
      const agent = addLocalAgent(
        repoRoot,
        requireString(body, "handle"),
        client,
        options,
        optionalStringArray(body, "launchArgs")
      );
      json(response, 201, inspectAgent(repoRoot, agent.principalId, options));
      return;
    }
    const principalId = parts[2];
    const action = parts[3];
    if (method === "POST" && principalId !== undefined && action !== undefined &&
      parts.length === 4) {
      if (action === "rename") {
        const body = await readJsonBody(request);
        renameLocalAgent(
          repoRoot,
          principalId,
          requireString(body, "handle"),
          options
        );
        json(response, 200, inspectAgent(repoRoot, principalId, options));
        return;
      }
      if (action === "configure") {
        const body = await readJsonBody(request);
        configureLocalAgent(
          repoRoot,
          principalId,
          optionalStringArray(body, "launchArgs"),
          options
        );
        json(response, 200, inspectAgent(repoRoot, principalId, options));
        return;
      }
      if (action === "suspend") {
        suspendLocalAgent(repoRoot, principalId, options);
        json(response, 200, inspectAgent(repoRoot, principalId, options));
        return;
      }
      if (action === "resume") {
        resumeLocalAgent(repoRoot, principalId, options);
        json(response, 200, inspectAgent(repoRoot, principalId, options));
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

function optionalStringArray(
  value: Readonly<Record<string, unknown>>,
  field: string
): readonly string[] {
  const candidate = value[field];
  if (candidate === undefined) return [];
  if (!Array.isArray(candidate) ||
    !candidate.every((item): item is string => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings`);
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
      json(response, 200, runtimeOperationsView(
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
      const controlResult: RuntimeControlResultView = controlRuntime(
        repoRoot,
        action,
        runtimeDirectory
      );
      json(response, 200, runtimeOperationsView(
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

function serveEventApi(
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
    const legacy = parts[1] === "runtime";
    const listLength = legacy ? 3 : 2;
    const detailLength = legacy ? 4 : 3;
    if (parts.length === listLength) {
      json(response, 200, listEventTraces(repoRoot, runtimeDirectory));
      return;
    }
    if (parts.length === detailLength) {
      json(response, 200, eventTrace(
        repoRoot,
        parts[detailLength - 1]!,
        runtimeDirectory
      ));
      return;
    }
    json(response, 404, { error: "not_found" });
  } catch (error) {
    json(response, 404, { error: error instanceof Error ? error.message : String(error) });
  }
}

function serveRuntimeFailureApi(
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
    if (parts.length === 2) {
      const limitValue = url.searchParams.get("limit");
      const limit = limitValue === null
        ? 100
        : parseBoundedQueryInteger(limitValue, "failure limit", 1, 200);
      json(response, 200, listRuntimeFailures(repoRoot, runtimeDirectory, limit));
      return;
    }
    if (parts.length === 3) {
      json(response, 200, inspectRuntimeFailure(
        repoRoot,
        parts[2]!,
        runtimeDirectory
      ));
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
