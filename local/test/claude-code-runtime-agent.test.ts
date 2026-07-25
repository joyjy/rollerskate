import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentInputEvent } from "../src/core/event/model.js";
import { ClaudeCodeRuntimeAgent } from "../src/integrations/agent/claude-code.js";

test("Claude Code receives Agent launch args and resumes the exact provider Session", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "rollerskate-claude-code-runtime-"));
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
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "direct Claude result",
    session_id: "claude-provider-session"
  }));
});
`);
  chmodSync(executable, 0o700);
  const agent = new ClaudeCodeRuntimeAgent({
    executable,
    projectRoot: workspace,
    environment: {},
    timeoutMilliseconds: 3_000,
    launchArgs: ["--model", "claude-sonnet-4-6"]
  });

  const result = await agent.invoke({
    event: event(),
    providerSessionId: "claude-existing-session"
  });

  const request = JSON.parse(readFileSync(invocation, "utf8")) as {
    args: string[];
    input: string;
  };
  assert.deepEqual(request.args.slice(0, 2), ["--model", "claude-sonnet-4-6"]);
  assert.deepEqual(request.args.slice(-2), ["--resume", "claude-existing-session"]);
  assert.ok(!request.args.includes("claude"));
  assert.match(request.input, /Prompt:\nrespond directly/);
  assert.equal(result.providerSessionId, "claude-provider-session");
  assert.deepEqual(result.outcome, { kind: "message", body: "direct Claude result" });
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
