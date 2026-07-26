import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { AgentInputEvent, ChatDispatchEvent } from "../../core/event/model.js";
import type { RuntimeAgentAdapter } from "../../core/runtime/handlers.js";
import { runtimeAgentEventPrompt } from "./event-prompt.js";
import { AgentProcessClient, type AgentProcessProtocol } from "./process-client.js";

interface KimiCodeRequest {
  readonly event: AgentInputEvent | ChatDispatchEvent;
  readonly providerSessionId?: string;
}

interface KimiCodeMessage {
  readonly role?: unknown;
  readonly type?: unknown;
  readonly content?: unknown;
  readonly session_id?: unknown;
}

export interface KimiCodeRuntimeAgentOptions {
  readonly executable: string;
  readonly projectRoot: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
  readonly maxOutputBytes?: number;
  readonly launchArgs?: readonly string[];
}

export class KimiCodeRuntimeAgent implements RuntimeAgentAdapter {
  public readonly adapterId = "kimi-code-runtime-jsonl-v1";
  public readonly workspace: string;
  readonly #process: AgentProcessClient;

  public constructor(options: KimiCodeRuntimeAgentOptions) {
    this.workspace = workspace(options.projectRoot);
    this.#process = new AgentProcessClient({
      adapterId: this.adapterId,
      executable: options.executable,
      args: (request) => kimiCodeArgs(
        request as KimiCodeRequest,
        options.launchArgs ?? []
      ),
      environment: options.environment,
      workingDirectory: this.workspace,
      timeoutMilliseconds: options.timeoutMilliseconds,
      maxOutputBytes: options.maxOutputBytes ?? 1_048_576,
      protocol: kimiCodeProtocol
    });
  }

  public async invoke(input: Parameters<RuntimeAgentAdapter["invoke"]>[0]):
  Promise<Awaited<ReturnType<RuntimeAgentAdapter["invoke"]>>> {
    const result = await this.#process.invoke({
      event: input.event,
      ...(input.providerSessionId === undefined
        ? {}
        : { providerSessionId: input.providerSessionId })
    } satisfies KimiCodeRequest);
    return result.response as Awaited<ReturnType<RuntimeAgentAdapter["invoke"]>>;
  }
}

function kimiCodeArgs(
  request: KimiCodeRequest,
  launchArgs: readonly string[]
): string[] {
  return [
    ...launchArgs,
    "--prompt", runtimeAgentEventPrompt(request.event),
    "--output-format", "stream-json",
    ...(request.providerSessionId === undefined
      ? []
      : ["--session", request.providerSessionId])
  ];
}

const kimiCodeProtocol: AgentProcessProtocol = {
  encodeRequest(): string {
    return "";
  },
  decodeResponse(output: string): Awaited<ReturnType<RuntimeAgentAdapter["invoke"]>> {
    const messages = output.split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as KimiCodeMessage);
    const providerSessionId = messages.findLast((message) =>
      message.role === "meta" && message.type === "session.resume_hint" &&
      typeof message.session_id === "string")?.session_id;
    const text = messages
      .filter((message) => message.role === "assistant" &&
        typeof message.content === "string" && message.content.trim() !== "")
      .map((message) => message.content as string)
      .join("\n");
    if (typeof providerSessionId !== "string" || providerSessionId.trim() === "" ||
      text.trim() === "") {
      throw new Error("Kimi Code Runtime response is missing Session or assistant output");
    }
    return {
      providerSessionId,
      outcome: { kind: "message", body: text }
    };
  }
};

function workspace(projectRoot: string): string {
  if (!isAbsolute(projectRoot)) throw new Error("projectRoot must be absolute");
  const canonical = realpathSync(projectRoot);
  if (!statSync(canonical).isDirectory()) throw new Error("projectRoot must be a directory");
  return canonical;
}
