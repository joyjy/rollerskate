import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { AgentInputEvent } from "../../core/event/model.js";
import type { RuntimeAgentAdapter } from "../../core/runtime/handlers.js";
import { AgentProcessClient, type AgentProcessProtocol } from "./process-client.js";

interface CodexRequest {
  readonly event: AgentInputEvent;
  readonly providerSessionId?: string;
}

interface CodexEvent {
  readonly type?: unknown;
  readonly thread_id?: unknown;
  readonly item?: { readonly type?: unknown; readonly text?: unknown };
}

export interface CodexRuntimeAgentOptions {
  readonly executable: string;
  readonly projectRoot: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
  readonly maxOutputBytes?: number;
}

export class CodexRuntimeAgent implements RuntimeAgentAdapter {
  public readonly adapterId = "codex-runtime-jsonl-v1";
  public readonly workspace: string;
  readonly #process: AgentProcessClient;

  public constructor(options: CodexRuntimeAgentOptions) {
    this.workspace = workspace(options.projectRoot);
    this.#process = new AgentProcessClient({
      adapterId: this.adapterId,
      executable: options.executable,
      args: (request) => codexArgs(request as CodexRequest, this.workspace),
      environment: options.environment,
      timeoutMilliseconds: options.timeoutMilliseconds,
      maxOutputBytes: options.maxOutputBytes ?? 1_048_576,
      protocol: codexProtocol
    });
  }

  public async invoke(input: Parameters<RuntimeAgentAdapter["invoke"]>[0]):
  Promise<Awaited<ReturnType<RuntimeAgentAdapter["invoke"]>>> {
    const result = await this.#process.invoke({
      event: input.event,
      ...(input.providerSessionId === undefined
        ? {}
        : { providerSessionId: input.providerSessionId })
    } satisfies CodexRequest);
    return result.response as Awaited<ReturnType<RuntimeAgentAdapter["invoke"]>>;
  }
}

function codexArgs(request: CodexRequest, projectRoot: string): string[] {
  const options = [
    "--json",
    "--ignore-user-config",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "-C", projectRoot
  ];
  return request.providerSessionId === undefined
    ? ["exec", ...options, "-"]
    : ["exec", ...options, "resume", request.providerSessionId, "-"];
}

const codexProtocol: AgentProcessProtocol = {
  encodeRequest(request: unknown): string {
    return encodeRequest(request as CodexRequest);
  },
  decodeResponse(output: string): Awaited<ReturnType<RuntimeAgentAdapter["invoke"]>> {
    const events = output.split("\n").filter((line) => line.trim() !== "").map((line) =>
      JSON.parse(line) as CodexEvent);
    const providerSessionId = events.findLast((event) =>
      event.type === "thread.started" && typeof event.thread_id === "string")?.thread_id;
    const text = events.findLast((event) =>
      event.type === "item.completed" && event.item?.type === "agent_message" &&
      typeof event.item.text === "string")?.item?.text;
    if (typeof providerSessionId !== "string" || typeof text !== "string" || text.trim() === "") {
      throw new Error("Codex Runtime response is missing Session or final message");
    }
    return { providerSessionId, output: text };
  }
};

function encodeRequest(request: CodexRequest): string {
  return [
    "You are handling one fixed-schema Rollerskate Local Runtime Event.",
    "Follow the prompt and return the useful result as plain text.",
    `Event type: ${request.event.type}`,
    `Causal root: ${request.event.causality.rootEventId}`,
    `Causal hop: ${request.event.causality.hop}`,
    "Prompt:",
    request.event.prompt
  ].join("\n");
}

function workspace(projectRoot: string): string {
  if (!isAbsolute(projectRoot)) throw new Error("projectRoot must be absolute");
  const canonical = realpathSync(projectRoot);
  if (!statSync(canonical).isDirectory()) throw new Error("projectRoot must be a directory");
  return canonical;
}
