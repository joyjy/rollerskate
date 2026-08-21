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

import { serveAgentApi } from "./agent-api.js";
import { serveChatApi } from "./chat-api.js";
import { serveChannelApi } from "./channel-api.js";
import { serveEventsApi } from "./events-api.js";
import { json } from "./http.js";
import {
  ConsoleDeviceLogin,
  serveNetworkApi
} from "./network-api.js";
import {
  serveNoticeApi,
  serveRuntimeApi,
  serveRuntimeFailureApi
} from "./runtime-api.js";
import { serveScheduleApi } from "./schedule-api.js";
import { serveStewardApi } from "./steward-api.js";
import { serveSubscriptionApi } from "./subscription-api.js";
import type { UiServerHandle, UiServerOptions } from "./types.js";

export type { UiServerHandle, UiServerOptions } from "./types.js";

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
  const deviceLogin = new ConsoleDeviceLogin(options);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/api/network" || url.pathname.startsWith("/api/network/")) {
      void serveNetworkApi(options, deviceLogin, request, url, response);
      return;
    }
    if (url.pathname === "/api/runtime" || url.pathname.startsWith("/api/runtime/")) {
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
    if (url.pathname === "/api/events" ||
      url.pathname.startsWith("/api/events/")) {
      serveEventsApi(
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
      void serveAgentApi(
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
      void serveChatApi(
        options.repoRoot,
        options.runtimeDirectory,
        request,
        request.headers["x-rollerskate-request"],
        url,
        response
      );
      return;
    }
    if (url.pathname === "/api/channels" || url.pathname.startsWith("/api/channels/")) {
      void serveChannelApi(
        options.repoRoot,
        options.runtimeDirectory,
        options.fetch,
        request,
        request.headers["x-rollerskate-request"],
        url,
        response
      );
      return;
    }
    if (url.pathname === "/api/runs" || url.pathname.startsWith("/api/runs/")) {
      void serveStewardApi(
        options.repoRoot,
        options.runtimeDirectory,
        request,
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
