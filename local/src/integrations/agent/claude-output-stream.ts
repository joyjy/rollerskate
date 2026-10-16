import type { AgentOutputEvent } from "../../core/runtime/agent-invocation.js";
import type { AgentProcessProtocol } from "./process-client.js";
import { JsonLineResponseDecoder } from "./json-line-decoder.js";

export interface ClaudeOutputRequest {
  readonly reportOutput?: (event: AgentOutputEvent) => void;
}

/** Keep the existing terminal-result decoder authoritative, while retaining only
 * public stream blocks. User prompt echoes and hidden thinking are never copied. */
export function claudeOutputProtocol(protocol: AgentProcessProtocol): AgentProcessProtocol {
  return {...protocol, createResponseDecoder(request, maxOutputBytes) {
    const output = (request as ClaudeOutputRequest).reportOutput;
    let result: unknown;
    return new JsonLineResponseDecoder({
      maxLineBytes: Math.max(maxOutputBytes, 16 * 1024 * 1024),
      onDiscardedLine: () => { throw new Error("Claude output protocol record exceeds limit"); },
      onMessage(value) {
        if (!record(value)) return false;
        if (typeof value.session_id === "string") {
          // Session metadata also lets a crash trace retain the provider identity.
          output?.({kind: "tool.update", data: {providerSessionId: value.session_id, phase: "provider_session"}});
        }
        if (value.type === "result") {
          const encoded = JSON.stringify(value);
          if (Buffer.byteLength(encoded) > maxOutputBytes) throw new Error("Claude result exceeds output limit");
          result = value;
          return true;
        }
        if (value.type === "stream_event" && record(value.event)) {
          const event = value.event;
          if (record(event.delta) && event.delta.type === "text_delta" && typeof event.delta.text === "string") {
            output?.({kind: "assistant.delta", data: {text: event.delta.text}});
          } else if (record(event.delta) && ["thinking_delta", "signature_delta"].includes(String(event.delta.type))) {
            output?.({kind: "thought"});
          } else if (record(event.content_block) && event.content_block.type === "tool_use") {
            output?.({kind: "tool.call", data: event.content_block});
          } else if (record(event.delta) && event.delta.type === "input_json_delta") {
            output?.({kind: "tool.update", data: {index: event.index, phase: "tool_input_delta"}});
          }
        }
        if ((value.type === "assistant" || value.type === "user") && record(value.message) && Array.isArray(value.message.content)) {
          for (const block of value.message.content) {
            if (!record(block)) continue;
            if (value.type === "assistant" && block.type === "text") output?.({kind: "assistant.message", data: {text: block.text}});
            else if (value.type === "assistant" && block.type === "tool_use") output?.({kind: "tool.call", data: block});
            else if (block.type === "tool_result") output?.({kind: "tool.result", data: block});
            else if (block.type === "thinking") output?.({kind: "thought"});
          }
        }
        return true;
      },
      complete() {
        if (result === undefined) throw new Error("Claude stream is missing terminal result");
        return protocol.decodeResponse!(JSON.stringify(result), request);
      }
    });
  }};
}

export function claudeOutputArgs(args: readonly string[], stream: boolean): string[] {
  if (!stream) return [...args];
  return [...args.map((value, index) => index > 0 && args[index - 1] === "--output-format" ? "stream-json" : value),
    "--verbose", "--include-partial-messages"];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
