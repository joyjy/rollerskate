import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
  assert.deepEqual(agent.reviewCapabilities, {
    resultSchemas: ["ImplementerResult@1"],
    workspaceAccess: ["write"]
  });
});

test("Kimi Code maps a Review Implementer invocation to the fixed result contract", async () => {
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
      schemaVersion: "ImplementerResult@1",
      boundedSummary: "updated",
      findingReplies: [],
      implementationRevision: "runtime"
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
  assert.match(prompt, /Return only JSON conforming to ImplementerResult@1/);
  assert.match(prompt, /Workspace access: write/);
  assert.match(prompt, /implementationRevision to the literal "runtime"/);
  assert.match(prompt, new RegExp(`Authorized writable root: ${escapeRegExp(workspace)}`));
  assert.notEqual(
    JSON.parse(result.outcome.kind === "message" ? result.outcome.body : "{}")
      .implementationRevision,
    "runtime"
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
    prompt: "use Kimi",
    ...(workspace === undefined
      ? {}
      : {
          reviewInvocation: {
            schemaVersion: "review-invocation@1",
            role: "implementer",
            rootEventId: eventId,
            cycleIndex: 0,
            subject: {
              kind: "acceptance",
              ref: join(workspace, "plan.md"),
              revision: "sub_1"
            },
            artifactRef: join(workspace, "plan.md.review.yaml"),
            artifactRevision: "art_1",
            evidence: [{
              kind: "workspace",
              ref: workspace,
              revision: "wrk1_initial"
            }],
            implementationRevision: "wrk1_initial",
            workspaceAccess: "write",
            writableRoot: workspace,
            resultSchema: "ImplementerResult@1"
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
