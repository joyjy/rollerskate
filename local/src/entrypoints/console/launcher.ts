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
        .map(({ subscription }) => pollSubscriptionView(subscription)));
      return;
    }
    const subscriptionId = parts[2];
    if (subscriptionId === undefined) {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (parts.length === 3 && method === "GET") {
      json(response, 200, pollSubscriptionView(
        inspectPollSubscription(repoRoot, subscriptionId, runtimeDirectory).subscription
      ));
      return;
    }
    const action = parts[3];
    if (parts.length === 4 && method === "POST" &&
      (action === "pause" || action === "resume" || action === "cancel" || action === "revoke")) {
      if (requestMarker !== "console") {
        json(response, 403, { error: "console_request_marker_required" });
        return;
      }
      const subscription = controlPollSubscription(
        repoRoot,
        subscriptionId,
        action,
        runtimeDirectory
      ).subscription;
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
