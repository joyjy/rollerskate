import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { agentRunTurnPrompt } from "../src/application/agent-run/prompt.js";
import type { AgentInputEvent } from "../src/core/event/model.js";
import { KimiCodeRuntimeAgent } from "../src/integrations/agent/kimi-code.js";

test("Kimi Code uses prompt JSONL mode, launch args and exact Session resume", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "rollerskate-kimi-code-runtime-"));
  const executable = join(workspace, "kimi-fixture");
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
  process.stdout.write([
    JSON.stringify({ role: "assistant", content: "checking" }),
    JSON.stringify({ role: "tool", tool_call_id: "tc_1", content: "ignored tool output" }),
    JSON.stringify({ role: "assistant", content: "done" }),
    JSON.stringify({
      role: "meta",
      type: "session.resume_hint",
      session_id: "ses_kimi",
      command: "kimi -r ses_kimi",
      content: "To resume this session: kimi -r ses_kimi"
    })
  ].join("\\n") + "\\n");
});
`);
  chmodSync(executable, 0o700);
  const agent = new KimiCodeRuntimeAgent({
    executable,
    projectRoot: workspace,
    environment: {},
    timeoutMilliseconds: 3_000,
    launchArgs: ["--model", "kimi-code/kimi-for-coding"]
  });

  const result = await agent.invoke({
    event: event(),
    providerSessionId: "ses_existing"
  });

  const request = JSON.parse(readFileSync(invocation, "utf8")) as {
    args: string[];
    input: string;
  };
  assert.deepEqual(request.args.slice(0, 2), [
    "--model",
    "kimi-code/kimi-for-coding"
  ]);
  assert.deepEqual(request.args.slice(-2), ["--session", "ses_existing"]);
  assert.equal(request.args[request.args.indexOf("--output-format") + 1], "stream-json");
  assert.match(request.args[request.args.indexOf("--prompt") + 1]!, /Prompt:\nuse Kimi/);
  assert.equal(request.input, "");
  assert.equal(result.providerSessionId, "ses_kimi");
  assert.deepEqual(result.outcome, { kind: "message", body: "checking\ndone" });
});

test("Kimi Code receives the generic Agent Run contract and workspace grant", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "rollerskate-kimi-code-review-"));
  writeFileSync(join(workspace, "tracked.txt"), "initial\n");
  git(workspace, ["init"]);
  git(workspace, ["config", "user.email", "kimi-test@example.invalid"]);
  git(workspace, ["config", "user.name", "Kimi Test"]);
  git(workspace, ["add", "tracked.txt"]);
  git(workspace, ["commit", "-m", "initial"]);
  const executable = join(workspace, "kimi-fixture");
  const invocation = join(workspace, "invocation.json");
  writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({
  args: process.argv.slice(2)
}));
process.stdout.write([
  JSON.stringify({
    role: "assistant",
    content: JSON.stringify({
      schemaVersion: "AgentTurnResult@1",
      action: "complete",
      outcome: "succeeded",
      summary: "updated",
      artifactRefs: [],
      observedWorkspaceRevision: "agent-observed"
    })
  }),
  JSON.stringify({
    role: "meta",
    type: "session.resume_hint",
    session_id: "ses_kimi_review"
  })
].join("\\n") + "\\n");
`);
  chmodSync(executable, 0o700);
  const agent = new KimiCodeRuntimeAgent({
    executable,
    projectRoot: workspace,
    environment: {},
    timeoutMilliseconds: 3_000
  });

  const result = await agent.invoke({ event: event(workspace) });

  const request = JSON.parse(readFileSync(invocation, "utf8")) as {
    args: string[];
  };
  const prompt = request.args[request.args.indexOf("--prompt") + 1]!;
  assert.match(prompt, /AgentTurnResult@1/);
  assert.match(prompt, /Invocation context:/);
  assert.match(prompt, /"access":"write"/);
  assert.match(prompt, new RegExp(escapeRegExp(workspace)));
  assert.equal(
    JSON.parse(result.outcome.kind === "message" ? result.outcome.body : "{}")
      .observedWorkspaceRevision,
    "agent-observed"
  );
});

function event(workspace?: string): AgentInputEvent {
  const eventId = "evt_019f92c9-0000-7000-8000-000000000011";
  return {
    eventId,
    type: "agent.request",
    source: { kind: "cli" },
    agentId: "prn_019f92c9-0000-7000-8000-000000000011",
    destinationIds: [],
    causality: { rootEventId: eventId, hop: 0 },
    prompt: workspace === undefined
      ? "use Kimi"
      : agentRunTurnPrompt("use Kimi", []),
    ...(workspace === undefined
      ? {}
      : {
          runContext: {
            schemaVersion: "AgentRunContext@1",
            resultContractId: "agent-turn-result@1",
            runId: "run_019f92c9-0000-7000-8000-000000000011",
            stepId: "stp_019f92c9-0000-7000-8000-000000000011",
            depth: 0,
            workspaceGrant: {
              schemaVersion: "ExternalWorkspaceGrant@1",
              root: workspace,
              access: "write",
              revision: "wrk1_initial"
            }
          }
        }),
    createdAt: "2026-07-25T00:00:00.000Z"
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function git(cwd: string, arguments_: readonly string[]): void {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
