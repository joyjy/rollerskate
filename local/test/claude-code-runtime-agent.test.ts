import type { AgentOutputEvent } from "../src/core/runtime/agent-invocation.js";
import { temporaryDirectory } from "./support/temp-directory.js";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { AgentInputEvent, ChatDispatchEvent } from "../src/core/event/model.js";
import { ClaudeCodeRuntimeAgent } from "../src/integrations/agent/claude-code.js";

test("Claude Code receives Agent launch args and resumes the exact provider Session", async () => {
  const workspace = temporaryDirectory("rollerskate-claude-code-runtime-");
  const executable = join(workspace, "claude-fixture");
  const invocation = join(workspace, "invocation.json");
  writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({
    args: process.argv.slice(2),
    input
  }));
  process.stdout.write(JSON.stringify({type: "stream_event", session_id: "stream-session", event: {delta: {type: "text_delta", text: "live public text"}}}) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "direct Claude result",
    session_id: "claude-existing-session",
    usage: { input_tokens: 9, output_tokens: 3 },
    num_turns: 2,
    total_cost_usd: 0.01
  }));
});
`);
  chmodSync(executable, 0o700);
  let webSearch = false;
  const agent = new ClaudeCodeRuntimeAgent({
    executable,
    projectRoot: workspace,
    environment: {},
    timeoutMilliseconds: 3_000,
    launchArgs: ["--model", "claude-sonnet-4-6"],
    resolveWebSearch: () => webSearch,
    resolveMcpServers: () => [{
      name: "rollerskate_chat",
      command: process.execPath,
      args: ["chat-history.js"],
      tools: ["read_chat_history"]
    }, {
      name: "rollerskate_read",
      command: process.execPath,
      args: ["chat-read-tools.js"],
      tools: ["describe_capabilities", "get_run"]
    }]
  });
  assert.equal(agent.providerPolicy.client, "claude-code");
  assert.equal(agent.providerPolicy.hook.state, "enforced");

  const output: AgentOutputEvent[] = [];
  const result = await agent.invoke({
    reportOutput: event => output.push(event),
    event: event(),
    providerSessionId: "claude-existing-session"
  });

  assert.ok(output.some(event => event.kind === "assistant.delta"));
  const request = JSON.parse(readFileSync(invocation, "utf8")) as {
    args: string[];
    input: string;
  };
  assert.deepEqual(request.args.slice(0, 2), ["--model", "claude-sonnet-4-6"]);
  assert.equal(request.args[request.args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(request.args.includes("--include-partial-messages"));
  assert.deepEqual(request.args.slice(-2), ["--resume", "claude-existing-session"]);
  assert.ok(request.args.includes("--strict-mcp-config"));
  assert.deepEqual(request.args.slice(
    request.args.indexOf("--allowedTools") + 1,
    request.args.indexOf("--resume")
  ), [
    "mcp__rollerskate_chat__read_chat_history",
    "mcp__rollerskate_read__describe_capabilities",
    "mcp__rollerskate_read__get_run"
  ]);
  assert.ok(!request.args.includes("claude"));
  assert.match(request.input, /Prompt:\nrespond directly/);
  assert.equal(result.providerSessionId, "claude-existing-session");
  assert.deepEqual(result.outcome, { kind: "message", body: "direct Claude result" });
  assert.deepEqual(result.invocation?.tokenUsage, {
    inputTokens: 9,
    outputTokens: 3,
    totalTokens: 12,
    costUsd: 0.01
  });
  assert.equal(result.invocation?.turnCount, 2);
  assert.equal(result.invocation?.toolUsage, undefined);
  const chat: ChatDispatchEvent = {
    ...event(), type: "chat.dispatch", source: {kind: "handler"},
    topicId: "topic-local", sourceAttentionEventId: "attention-fixture",
    targetHandleSnapshot: "alice", promptResourceId: "rollerskate.chat.free-turn.v1"
  };
  for (const enabled of [true, false]) {
    webSearch = enabled;
    await agent.invoke({event: chat, providerSessionId: "desktop-session"});
    const next = JSON.parse(readFileSync(invocation, "utf8")) as {args: string[]; input: string};
    assert.equal(next.args[next.args.indexOf("--tools") + 1], enabled ? "Read,Glob,Grep,WebSearch" : "Read,Glob,Grep");
    assert.equal(next.args.includes("WebSearch"), enabled);
    assert.ok(next.args.includes("mcp__rollerskate_chat__read_chat_history"));
    assert.deepEqual(next.args.slice(-2), ["--resume", "desktop-session"]);
    assert.match(next.input, enabled ? /Owner enabled.*web search/ : /Owner has not enabled/);
  }

});

function event(): AgentInputEvent {
  const eventId = "evt_019f92c9-0000-7000-8000-000000000010";
  return {
    eventId,
    type: "agent.request",
    source: { kind: "cli" },
    agentId: "prn_019f92c9-0000-7000-8000-000000000010",
    destinationIds: [],
    causality: { rootEventId: eventId, hop: 0 },
    prompt: "respond directly",
    createdAt: "2026-07-25T00:00:00.000Z"
  };
}
