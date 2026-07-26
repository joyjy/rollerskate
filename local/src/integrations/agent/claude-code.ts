import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type { AgentInputEvent, ChatDispatchEvent } from "../../core/event/model.js";
import type { RuntimeAgentAdapter } from "../../core/runtime/handlers.js";
import { runtimeAgentEventPrompt } from "./event-prompt.js";
import { AgentProcessClient, type AgentProcessProtocol } from "./process-client.js";

interface ClaudeCodeRequest {
  readonly event: AgentInputEvent | ChatDispatchEvent;
  readonly providerSessionId?: string;
}

interface ClaudeCodeResult {
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly is_error?: unknown;
  readonly result?: unknown;
  readonly structured_output?: unknown;
  readonly session_id?: unknown;
}

export interface ClaudeCodeRuntimeAgentOptions {
  readonly executable: string;
  readonly projectRoot: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMilliseconds: number;
  readonly maxOutputBytes?: number;
  readonly launchArgs?: readonly string[];
}

export class ClaudeCodeRuntimeAgent implements RuntimeAgentAdapter {
  public readonly adapterId = "claude-code-runtime-json-v1";
  public readonly workspace: string;
  readonly #process: AgentProcessClient;

  public constructor(options: ClaudeCodeRuntimeAgentOptions) {
    this.workspace = workspace(options.projectRoot);
    this.#process = new AgentProcessClient({
      adapterId: this.adapterId,
      executable: options.executable,
      args: (request) => claudeCodeArgs(
        request as ClaudeCodeRequest,
        options.launchArgs ?? []
      ),
      environment: options.environment,
      workingDirectory: this.workspace,
      timeoutMilliseconds: options.timeoutMilliseconds,
      maxOutputBytes: options.maxOutputBytes ?? 1_048_576,
      protocol: claudeCodeProtocol
    });
  }

  public async invoke(input: Parameters<RuntimeAgentAdapter["invoke"]>[0]):
  Promise<Awaited<ReturnType<RuntimeAgentAdapter["invoke"]>>> {
    const result = await this.#process.invoke({
      event: input.event,
      ...(input.providerSessionId === undefined
        ? {}
        : { providerSessionId: input.providerSessionId })
    } satisfies ClaudeCodeRequest);
    return result.response as Awaited<ReturnType<RuntimeAgentAdapter["invoke"]>>;
  }
}

function claudeCodeArgs(
  request: ClaudeCodeRequest,
  launchArgs: readonly string[]
): string[] {
  const access = request.event.type === "agent.request"
    ? request.event.runContext?.workspaceGrant?.access
    : undefined;
  const options = [
    ...launchArgs,
    "--print",
    "--output-format", "json",
    ...(access === "write"
      ? ["--permission-mode", "acceptEdits", "--tools", "Read,Glob,Grep,Edit,Write,Bash"]
      : ["--permission-mode", "plan", "--tools", "Read,Glob,Grep"])
  ];
  return request.providerSessionId === undefined
    ? options
    : [...options, "--resume", request.providerSessionId];
}

const claudeCodeProtocol: AgentProcessProtocol = {
  encodeRequest(request: unknown): string {
    return runtimeAgentEventPrompt((request as ClaudeCodeRequest).event);
  },
  decodeResponse(output: string): Awaited<ReturnType<RuntimeAgentAdapter["invoke"]>> {
    const parsed = JSON.parse(output) as ClaudeCodeResult;
    if (parsed.type !== "result" || parsed.subtype !== "success" ||
      parsed.is_error !== false || typeof parsed.session_id !== "string" ||
      parsed.session_id.trim() === "") {
      throw new Error("Claude Code Runtime response is missing a successful Session result");
    }
    const text = typeof parsed.result === "string"
      ? parsed.result
      : JSON.stringify(parsed.structured_output ?? parsed.result);
    if (text.trim() === "") throw new Error("Claude Code Runtime response is empty");
    return {
      providerSessionId: parsed.session_id,
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
