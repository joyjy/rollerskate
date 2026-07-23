import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { createContext, SourceTextModule } from "node:vm";

import type {
  PollPluginContext,
  PollProbeResult,
  SubscriptionProbePlugin
} from "./plugin-contract.js";

interface HostRequest {
  readonly pluginPath: string;
  readonly phase: "plan" | "evaluate";
  readonly config: unknown;
  readonly context: PollPluginContext;
  readonly result?: PollProbeResult;
}

async function main(): Promise<void> {
  const input = await readStdin();
  const request = parseRequest(JSON.parse(input) as unknown);
  const plugin = await loadPlugin(request.pluginPath);
  const value = request.phase === "plan"
    ? await plugin.plan(request.config, request.context)
    : await plugin.evaluate(
        request.config,
        requireResult(request.result),
        request.context
      );
  process.stdout.write(`${JSON.stringify({
    pluginId: plugin.id,
    schemaVersion: plugin.schemaVersion,
    value
  })}\n`);
}

async function loadPlugin(path: string): Promise<SubscriptionProbePlugin> {
  const source = stripTypeScriptTypes(await readFile(path, "utf8"), {
    mode: "strip",
    sourceMap: false
  });
  const context = createContext({
    console: Object.freeze({
      log: (..._values: unknown[]) => undefined,
      warn: (..._values: unknown[]) => undefined,
      error: (..._values: unknown[]) => undefined
    }),
    JSON,
    URL,
    TextEncoder,
    TextDecoder
  });
  const module = new SourceTextModule(source, {
    context,
    identifier: path,
    initializeImportMeta(meta) {
      meta.url = `file://${path}`;
    },
    importModuleDynamically() {
      throw new Error("Poll plugins cannot import runtime modules");
    }
  });
  await module.link(() => {
    throw new Error("Poll plugins may use type-only imports but cannot import runtime modules");
  });
  await module.evaluate({ timeout: 1_000 });
  const candidate = (module.namespace as Record<string, unknown>)["default"];
  if (!isRecord(candidate) || candidate.kind !== "subscription.probe" ||
    typeof candidate.id !== "string" ||
    candidate.schemaVersion !== 1 || typeof candidate.plan !== "function" ||
    typeof candidate.evaluate !== "function") {
    throw new Error("Poll plugin default export is malformed");
  }
  return candidate as unknown as SubscriptionProbePlugin;
}

function parseRequest(value: unknown): HostRequest {
  if (!isRecord(value) || typeof value.pluginPath !== "string" ||
    (value.phase !== "plan" && value.phase !== "evaluate") ||
    !isRecord(value.context)) {
    throw new Error("Poll plugin host request is malformed");
  }
  return value as unknown as HostRequest;
}

function requireResult(value: PollProbeResult | undefined): PollProbeResult {
  if (value === undefined) throw new Error("evaluate requires a probe result");
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
