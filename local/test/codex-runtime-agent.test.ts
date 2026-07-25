import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentInputEvent } from "../src/core/event/model.js";
import { CodexRuntimeAgent } from "../src/integrations/agent/codex.js";

test("Codex preserves user config only when resuming an existing provider Session", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "rollerskate-codex-runtime-"));
  const executable = join(workspace, "codex-fixture");
  const invocations = join(workspace, "invocations.jsonl");
writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.resume();
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({
    args: process.argv.slice(2),
    input
  }) + "\\n");
  process.stdout.write([
    JSON.stringify({ type: "thread.started", thread_id: "provider-session" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })
  ].join("\\n") + "\\n");
});
`);
  chmodSync(executable, 0o700);
  const agent = new CodexRuntimeAgent({
    executable,
    projectRoot: workspace,
    environment: {},
    timeoutMilliseconds: 3_000
  });

  await agent.invoke({ event: event("evt_019f92c9-0000-7000-8000-000000000001") });
  await agent.invoke({
    event: subscriptionEvent("evt_019f92c9-0000-7000-8000-000000000002"),
    providerSessionId: "desktop-session"
  });

  const [fresh, resumed] = readFileSync(invocations, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; input: string });
  assert.ok(fresh!.args.includes("--ignore-user-config"));
  assert.ok(!resumed!.args.includes("--ignore-user-config"));
  assert.deepEqual(resumed!.args.slice(-3), ["resume", "desktop-session", "-"]);
  assert.ok(resumed!.args.includes("approval_policy=\"never\""));
  assert.ok(resumed!.args.includes("read-only"));
  assert.match(resumed!.input, /Terminal observation:/);
  assert.match(resumed!.input, /"terminal":"success"/);
  assert.match(resumed!.input, /"status":"passed"/);
});

function event(eventId: string): AgentInputEvent {
  return {
    eventId,
    type: "agent.request",
    source: { kind: "cli" },
    agentId: "prn_019f92c9-0000-7000-8000-000000000001",
    destinationIds: [],
    causality: { rootEventId: eventId, hop: 0 },
    prompt: "respond",
    createdAt: "2026-07-24T00:00:00.000Z"
  };
}

function subscriptionEvent(eventId: string): AgentInputEvent {
  return {
    ...event(eventId),
    type: "subscription.fire",
    source: { kind: "subscription", externalId: "sub_fixture" },
    observation: {
      version: "pipeline-1:passed",
      facts: { status: "passed" },
      terminal: "success",
      summary: "Pipeline passed"
    }
  };
}
