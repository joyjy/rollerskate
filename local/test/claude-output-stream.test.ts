import assert from "node:assert/strict";
import test from "node:test";
import { claudeOutputArgs, claudeOutputProtocol } from "../src/integrations/agent/claude-output-stream.js";
import type { AgentOutputEvent } from "../src/core/runtime/agent-invocation.js";

test("Claude public stream is observable before result, never persists prompt echoes or thinking", () => {
  const events: AgentOutputEvent[] = [];
  const protocol = claudeOutputProtocol({encodeRequest: () => "prompt", decodeResponse: text => JSON.parse(text)});
  const decoder = protocol.createResponseDecoder!({reportOutput: (event: AgentOutputEvent) => events.push(event)}, 1024);
  const send = (value: unknown) => decoder.push(Buffer.from(JSON.stringify(value) + "\n"));
  send({type: "user", session_id: "provider_one", message: {content: [{type: "text", text: "secret prompt"}]}});
  send({type: "stream_event", event: {delta: {type: "text_delta", text: "中文"}}});
  assert.ok(events.some(event => event.kind === "assistant.delta"));
  send({type: "stream_event", event: {delta: {type: "thinking_delta", thinking: "hidden"}}});
  send({type: "assistant", message: {content: [{type: "tool_use", id: "call", name: "Read", input: {file: "a"}}]}});
  send({type: "user", message: {content: [{type: "tool_result", tool_use_id: "call", content: "result"}]}});
  const result = {type: "result", result: "final", session_id: "provider_one"};
  send(result);
  assert.deepEqual(decoder.finish(), result);
  assert.ok(events.some(event => event.kind === "tool.result"));
  assert.ok(!JSON.stringify(events).includes("secret prompt"));
  assert.ok(!JSON.stringify(events).includes("hidden"));
  assert.deepEqual(claudeOutputArgs(["--print", "--output-format", "json"], true),
    ["--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
});

test("Claude incomplete stream never fabricates success", () => {
  const protocol = claudeOutputProtocol({encodeRequest: () => "", decodeResponse: text => JSON.parse(text)});
  const decoder = protocol.createResponseDecoder!({}, 1024);
  decoder.push(Buffer.from('{"type":"assistant","message":{"content":[]}}\n'));
  assert.throws(() => decoder.finish(), /missing terminal result/);
});
