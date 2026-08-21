import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentInputEvent, ChatDispatchEvent } from "../src/core/event/model.js";
import { KimiCodeRuntimeAgent } from "../src/integrations/agent/kimi-code.js";
import { providerPolicyObservationFromArgv } from
  "../src/integrations/agent/provider-policy.js";

const readProfile = `---
name: read
description: read
tools:
  - Read
  - Grep
  - Glob
---
`;
const writeProfile = `---
name: write
description: write
tools:
  - Read
  - Grep
  - Glob
  - Write
  - Edit
  - Bash
---
`;

test("Kimi Code uses ACP v1, exact Session resume and model configuration", async () => {
  const fixture = kimiFixture({ toolKind: "read" });
  const agent = new KimiCodeRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000,
    launchArgs: ["--model", "kimi-code/kimi-for-coding"]
  });

  assert.match(agent.adapterId, /^kimi-code-runtime-acp-v1:[a-f0-9]{64}$/u);
  assert.equal(agent.providerPolicy.controls.transport, "acp-v1");
  assert.equal(agent.providerPolicy.controls.sessionMode, "plan");

  const first = await agent.invoke({ event: runEvent(undefined, "read") });
  assert.equal(first.providerSessionId,
    "rollerskate-kimi-session-v1:read:session_fixture");
  assert.deepEqual(first.outcome, { kind: "message", body: "done" });
  assert.deepEqual(first.invocation?.toolUsage, [{ name: "Read fixture", count: 1 }]);
  const firstCommands = invocation(fixture.invocation);
  assert.deepEqual(firstCommands.args, ["acp"]);
  assert.equal(methodCount(firstCommands.messages, "session/new"), 1);
  assert.equal(methodCount(firstCommands.messages, "session/resume"), 0);
  assert.deepEqual(paramsFor(firstCommands.messages, "session/set_mode"), {
    sessionId: "session_fixture",
    modeId: "plan"
  });
  assert.deepEqual(paramsFor(firstCommands.messages, "session/set_config_option"), {
    sessionId: "session_fixture",
    configId: "model",
    value: "kimi-code/kimi-for-coding"
  });
  assert.equal(permissionOutcome(firstCommands.messages), "allow-once");

  await agent.invoke({
    event: runEvent(undefined, "read"),
    providerSessionId: first.providerSessionId
  });
  const resumed = invocation(fixture.invocation);
  assert.equal(methodCount(resumed.messages, "session/new"), 0);
  assert.deepEqual(paramsFor(resumed.messages, "session/resume"), {
    sessionId: "session_fixture",
    cwd: agent.workspace,
    mcpServers: []
  });
  assert.equal(methodCount(resumed.messages, "session/set_mode"), 0);
  assert.equal(methodCount(resumed.messages, "session/set_config_option"), 0);
});

test("Kimi Code permission policy rejects writes for read grants and allows write grants", async () => {
  const readFixture = kimiFixture({ toolKind: "edit" });
  const readAgent = new KimiCodeRuntimeAgent({
    executable: readFixture.executable,
    projectRoot: readFixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000
  });
  await readAgent.invoke({ event: runEvent(readFixture.workspace, "read") });
  const readInvocation = invocation(readFixture.invocation);
  assert.equal(permissionOutcome(readInvocation.messages), "reject-once");
  assert.equal(
    (paramsFor(readInvocation.messages, "session/prompt") as { prompt: unknown[] })
      .prompt.some((block) => JSON.stringify(block).includes("Operate read-only")),
    true
  );
  assert.equal(
    JSON.stringify(paramsFor(readInvocation.messages, "session/prompt"))
      .includes("${base_prompt}"),
    false
  );

  const writeFixture = kimiFixture({ toolKind: "edit" });
  const writeAgent = new KimiCodeRuntimeAgent({
    executable: writeFixture.executable,
    projectRoot: writeFixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000
  });
  await writeAgent.invoke({ event: runEvent(writeFixture.workspace, "write") });
  const writeInvocation = invocation(writeFixture.invocation);
  assert.equal(permissionOutcome(writeInvocation.messages), "allow-once");
  assert.deepEqual(paramsFor(writeInvocation.messages, "session/set_mode"), {
    sessionId: "session_fixture",
    modeId: "default"
  });
});

test("Kimi Code ignores oversized ACP trace content and keeps the terminal result", async () => {
  const fixture = kimiFixture({ toolKind: "read", oversizedTraceBytes: 2_000_000 });
  const agent = new KimiCodeRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000,
    maxOutputBytes: 256
  });

  const result = await agent.invoke({ event: runEvent() });

  assert.deepEqual(result.outcome, { kind: "message", body: "done" });
});

test("Kimi Code keeps multiple assistant messages for Chat and only the last for Run", async () => {
  const fixture = kimiFixture({ toolKind: "read", multipleMessages: true });
  const agent = new KimiCodeRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000
  });

  const run = await agent.invoke({ event: runEvent() });
  const chat = await agent.invoke({ event: chatEvent() });

  assert.deepEqual(run.outcome, { kind: "message", body: "done" });
  assert.deepEqual(chat.outcome, { kind: "message", body: "checking\ndone" });
});

test("Kimi Code stalls when ACP emits only non-meaningful updates", async () => {
  const fixture = kimiFixture({ stall: true });
  const agent = new KimiCodeRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 1_000,
    meaningfulOutputTimeoutMilliseconds: 50
  });

  await assert.rejects(
    agent.invoke({ event: runEvent() }),
    /stalled without meaningful output/
  );
});

test("Kimi ACP policy fingerprint covers both bundled prompt policies", () => {
  const argv = ["acp"];
  const first = providerPolicyObservationFromArgv(
    "kimi-code",
    argv,
    "fixture-helper",
    { kimiReadOnlyAgent: readProfile, kimiWritableAgent: writeProfile }
  );
  const changed = providerPolicyObservationFromArgv(
    "kimi-code",
    argv,
    "fixture-helper",
    {
      kimiReadOnlyAgent: `${readProfile}changed prompt\n`,
      kimiWritableAgent: writeProfile
    }
  );
  assert.notEqual(first.hook.helperDigest, changed.hook.helperDigest);
  assert.equal(first.controls.permissionPolicy, "read-only-kinds");
  assert.throws(() => providerPolicyObservationFromArgv(
    "kimi-code",
    ["--prompt", "unsafe"],
    "fixture-helper",
    { kimiReadOnlyAgent: readProfile, kimiWritableAgent: writeProfile }
  ), /ACP provider policy is not enforced/);
});

test("Kimi ACP launch args reject controls other than model selection", () => {
  const workspace = mkdtempSync(join(tmpdir(), "rollerskate-kimi-acp-policy-"));
  assert.throws(() => new KimiCodeRuntimeAgent({
    executable: "/absolute/kimi",
    projectRoot: workspace,
    environment: {},
    timeoutMilliseconds: 3_000,
    launchArgs: ["--yolo"]
  }), /only support --model/);
});

function kimiFixture(options: {
  readonly toolKind?: "read" | "edit";
  readonly oversizedTraceBytes?: number;
  readonly multipleMessages?: boolean;
  readonly stall?: boolean;
}): { readonly workspace: string; readonly executable: string; readonly invocation: string } {
  const workspace = mkdtempSync(join(tmpdir(), "rollerskate-kimi-acp-"));
  const executable = join(workspace, "kimi-fixture");
  const invocationPath = join(workspace, "invocation.json");
  writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
const messages = [];
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({ args, messages }));
let input = "";
let promptRequest;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const update = (value) => send({ jsonrpc: "2.0", method: "session/update", params: {
  sessionId: "session_fixture", update: value
}});
const completePrompt = () => {
  ${options.multipleMessages === true ? `update({ sessionUpdate: "agent_message_chunk", messageId: "first", content: { type: "text", text: "checking" } });` : ""}
  update({ sessionUpdate: "agent_message_chunk", messageId: "final", content: { type: "text", text: "done" } });
  send({ jsonrpc: "2.0", id: promptRequest.id, result: { stopReason: "end_turn" } });
};
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (input.includes("\\n")) {
    const index = input.indexOf("\\n");
    const line = input.slice(0, index);
    input = input.slice(index + 1);
    if (line === "") continue;
    const message = JSON.parse(line);
    messages.push(message);
    save();
    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }
    }});
    if (message.method === "session/new") send({ jsonrpc: "2.0", id: message.id, result: {
      sessionId: "session_fixture"
    }});
    if (message.method === "session/resume") send({ jsonrpc: "2.0", id: message.id, result: {
      modes: { currentModeId: "plan", availableModes: [] },
      configOptions: [{
        id: "model", name: "Model", type: "select",
        currentValue: "kimi-code/kimi-for-coding", options: []
      }]
    }});
    if (["session/set_mode", "session/set_config_option"].includes(message.method)) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
    if (message.method === "session/prompt") {
      promptRequest = message;
      ${options.stall === true ? `setInterval(() => update({ sessionUpdate: "session_info_update", title: "noise" }), 5);` : `
      update({ sessionUpdate: "tool_call", toolCallId: "tool_1", title: "Read fixture", kind: ${JSON.stringify(options.toolKind ?? "read")}, status: "pending"${options.oversizedTraceBytes === undefined ? "" : `, rawInput: "x".repeat(${options.oversizedTraceBytes})`} });
      send({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: {
        sessionId: "session_fixture",
        toolCall: { toolCallId: "tool_1", kind: ${JSON.stringify(options.toolKind ?? "read")} },
        options: [
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" }
        ]
      }});`}
    }
    if (message.id === "permission" && message.result) completePrompt();
  }
});
`);
  chmodSync(executable, 0o700);
  return { workspace, executable, invocation: invocationPath };
}

function invocation(path: string): {
  readonly args: string[];
  readonly messages: Array<Record<string, unknown>>;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    readonly args: string[];
    readonly messages: Array<Record<string, unknown>>;
  };
}

function methodCount(messages: readonly Record<string, unknown>[], method: string): number {
  return messages.filter((message) => message.method === method).length;
}

function paramsFor(
  messages: readonly Record<string, unknown>[],
  method: string
): Record<string, unknown> {
  return messages.find((message) => message.method === method)?.params as Record<string, unknown>;
}

function permissionOutcome(messages: readonly Record<string, unknown>[]): string | undefined {
  const response = messages.find((message) => message.id === "permission");
  return (response?.result as { outcome?: { optionId?: string } } | undefined)
    ?.outcome?.optionId;
}

function runEvent(workspace?: string, access: "read" | "write" = "write"): AgentInputEvent {
  const eventId = "evt_019f92c9-0000-7000-8000-000000000011";
  return {
    eventId,
    type: "agent.request",
    source: { kind: "cli" },
    agentId: "prn_019f92c9-0000-7000-8000-000000000011",
    destinationIds: [],
    causality: { rootEventId: eventId, hop: 0 },
    prompt: "use Kimi",
    ...(workspace === undefined ? {} : {
      runContext: {
        schemaVersion: "AgentRunContext@1",
        resultContractId: "agent-turn-result@1",
        runId: "run_019f92c9-0000-7000-8000-000000000011",
        stepId: "stp_019f92c9-0000-7000-8000-000000000011",
        depth: 0,
        workspaceGrant: {
          schemaVersion: "ExternalWorkspaceGrant@1",
          root: workspace,
          access,
          revision: "wrk1_initial"
        }
      }
    }),
    createdAt: "2026-07-25T00:00:00.000Z"
  };
}

function chatEvent(): ChatDispatchEvent {
  const eventId = "evt_019f92c9-0000-7000-8000-000000000012";
  return {
    eventId,
    type: "chat.dispatch",
    source: { kind: "handler" },
    agentId: "prn_019f92c9-0000-7000-8000-000000000011",
    topicId: "topic-local",
    sourceAttentionEventId: eventId,
    targetHandleSnapshot: "kimi",
    promptResourceId: "rollerskate.chat.free-turn.v1",
    prompt: "reply in Chat",
    destinationIds: [],
    causality: { rootEventId: eventId, hop: 1 },
    createdAt: "2026-07-25T00:00:00.000Z"
  };
}
