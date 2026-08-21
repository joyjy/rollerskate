import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentInputEvent, ChatDispatchEvent } from "../src/core/event/model.js";
import {
  PI_CHAT_HISTORY_CONTEXT_ENV,
  PiRuntimeAgent
} from "../src/integrations/agent/pi.js";

test("pi discards oversized JSON trace and keeps a short Run result", async () => {
  const fixture = piFixture();
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000,
    maxOutputBytes: 256,
    launchArgs: ["--emit-large-trace"]
  });

  const first = await agent.invoke({ event: runEvent() });
  const firstRequest = invocation(fixture.invocation);
  assert.deepEqual(first.outcome, { kind: "message", body: "done" });
  assert.match(first.providerSessionId, /^[0-9a-f-]{36}$/u);
  assert.equal(valueAfter(firstRequest.args, "--mode"), "rpc");
  assert.equal(firstRequest.args.includes("--print"), false);
  assert.equal(valueAfter(firstRequest.args, "--session-id"), first.providerSessionId);
  assert.equal(firstRequest.args.includes("--session"), false);

  await agent.invoke({ event: runEvent(), providerSessionId: first.providerSessionId });
  const resumed = invocation(fixture.invocation);
  assert.equal(valueAfter(resumed.args, "--session-id"), first.providerSessionId);
  assert.equal(resumed.args.includes("--session"), false);
});

test("pi keeps JSON events and the bounded history extension in Chat", async () => {
  const fixture = piFixture();
  const context = {
    runtimeDirectory: "/tmp/rollerskate-runtime",
    topicId: "topic-fixture",
    sourceMessageEventId: "evt_source"
  };
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000,
    resolveChatHistoryContext: () => context
  });

  const result = await agent.invoke({ event: chatEvent() });
  const request = invocation(fixture.invocation);
  assert.deepEqual(result.outcome, { kind: "message", body: "done" });
  assert.equal(valueAfter(request.args, "--mode"), "rpc");
  assert.equal(valueAfter(request.args, "--session-id"), result.providerSessionId);
  assert.equal(valueAfter(request.args, "--tools")?.includes("read_chat_history"), true);
  assert.match(
    valueAfter(request.args, "--extension") ?? "",
    /resources\/agents\/pi-chat-history\.mjs$/u
  );
  assert.deepEqual(JSON.parse(request.context ?? "null"), context);
});

function piFixture(): {
  readonly workspace: string;
  readonly executable: string;
  readonly invocation: string;
} {
  const workspace = mkdtempSync(join(tmpdir(), "rollerskate-pi-runtime-"));
  const executable = join(workspace, "pi-fixture");
  const invocation = join(workspace, "invocation.json");
  writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
fs.writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({
  args,
  context: process.env.${PI_CHAT_HISTORY_CONTEXT_ENV}
}));
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (input.includes("\\n")) {
    const index = input.indexOf("\\n");
    const line = input.slice(0, index);
    input = input.slice(index + 1);
    if (line === "") continue;
    const command = JSON.parse(line);
    const sessionId = valueAfter("--session-id");
    if (command.type === "get_state") {
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId }
      }) + "\\n");
    }
    if (command.type === "prompt") {
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true
      }) + "\\n");
      if (args.includes("--emit-large-trace")) process.stdout.write(JSON.stringify({
        type: "tool_execution_end",
        toolName: "Bash",
        output: "x".repeat(512)
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] }
      }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
  }
});
`);
  chmodSync(executable, 0o700);
  return { workspace, executable, invocation };
}

function invocation(path: string): { readonly args: string[]; readonly context?: string } {
  return JSON.parse(readFileSync(path, "utf8")) as {
    readonly args: string[];
    readonly context?: string;
  };
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function runEvent(): AgentInputEvent {
  const eventId = "evt_019f92c9-0000-7000-8000-000000000020";
  return {
    eventId,
    type: "agent.request",
    source: { kind: "cli" },
    agentId: "prn_019f92c9-0000-7000-8000-000000000020",
    destinationIds: [],
    causality: { rootEventId: eventId, hop: 0 },
    prompt: "respond directly",
    createdAt: "2026-07-25T00:00:00.000Z"
  };
}

function chatEvent(): ChatDispatchEvent {
  const eventId = "evt_019f92c9-0000-7000-8000-000000000021";
  return {
    eventId,
    type: "chat.dispatch",
    source: { kind: "handler" },
    agentId: "prn_019f92c9-0000-7000-8000-000000000020",
    topicId: "topic-local",
    sourceAttentionEventId: eventId,
    targetHandleSnapshot: "pi",
    promptResourceId: "rollerskate.chat.free-turn.v1",
    prompt: "reply in Chat",
    destinationIds: [],
    causality: { rootEventId: eventId, hop: 1 },
    createdAt: "2026-07-25T00:00:00.000Z"
  };
}
