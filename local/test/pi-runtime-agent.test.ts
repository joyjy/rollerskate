import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "./support/temp-directory.js";

import type { AgentInputEvent, ChatDispatchEvent } from "../src/core/event/model.js";
import { chatToolGrant } from
  "../src/application/chat/tool-policy.js";
import { AgentInvocationError } from "../src/core/runtime/agent-invocation.js";
import {
  PI_CHAT_TOOL_CONTEXT_ENV,
  PiRuntimeAgent
} from "../src/integrations/agent/pi.js";
import { providerPolicyObservationFromArgv } from
  "../src/integrations/agent/provider-policy.js";

test("pi provider policy fails closed on read tool-list deviations", () => {
  const helperSource = "fixture";
  const resources = {
    piReadonlyGitExtensionPath: "/trusted/pi-readonly-git.mjs",
    piReadonlyGitExtensionSource: "export const readGit = true;",
    piChatHistoryExtensionPath: "/trusted/pi-chat-history.mjs",
    piChatHistoryExtensionSource: "export const readChat = true;"
  };
  const isolation = [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files"
  ];
  assert.doesNotThrow(() => providerPolicyObservationFromArgv(
    "pi",
    [...isolation, "--mode", "rpc", "--extension", resources.piReadonlyGitExtensionPath,
      "--tools", "read,grep,find,ls,read_git_diff"],
    helperSource,
    resources
  ));
  assert.doesNotThrow(() => providerPolicyObservationFromArgv(
    "pi",
    [...isolation, "--mode", "rpc", "--extension", resources.piReadonlyGitExtensionPath,
      "--extension", resources.piChatHistoryExtensionPath, "--tools",
      "read,grep,find,ls,read_git_diff,read_chat_history"],
    helperSource,
    resources
  ));
  assert.throws(() => providerPolicyObservationFromArgv(
    "pi",
    [...isolation, "--mode", "rpc", "--tools", "read,grep,find,ls"],
    helperSource,
    resources
  ), /read provider policy is not enforced/);
  assert.doesNotThrow(() => providerPolicyObservationFromArgv(
    "pi",
    [...isolation, "--mode", "rpc", "--tools", "read,write,edit,bash,grep,find,ls"],
    helperSource,
    resources,
    "write"
  ));
  assert.throws(() => providerPolicyObservationFromArgv(
    "pi",
    [...isolation, "--mode", "rpc",
      "--tools", "read,write,edit,bash,grep,find,ls,read_git_diff"],
    helperSource,
    resources,
    "write"
  ), /write provider policy is not enforced/);
  assert.throws(() => providerPolicyObservationFromArgv(
    "pi",
    [...isolation, "--mode", "rpc", "--extension", "/tmp/untrusted.mjs",
      "--extension", resources.piReadonlyGitExtensionPath,
      "--tools", "read,grep,find,ls,read_git_diff"],
    helperSource,
    resources
  ), /read extension policy is not enforced/);
  assert.throws(() => providerPolicyObservationFromArgv(
    "pi",
    ["--mode", "rpc", "--extension", resources.piReadonlyGitExtensionPath,
      "--tools", "read,grep,find,ls,read_git_diff"],
    helperSource,
    resources
  ), /read provider policy is not enforced/);
});

test("pi provider policy identity attests bundled extension content", () => {
  const argv = [
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--no-context-files", "--mode", "rpc", "--extension", "/trusted/read.mjs",
    "--tools", "read,grep,find,ls,read_git_diff"
  ];
  const resources = {
    piReadonlyGitExtensionPath: "/trusted/read.mjs",
    piReadonlyGitExtensionSource: "export const revision = 1;",
    piChatHistoryExtensionPath: "/trusted/chat.mjs",
    piChatHistoryExtensionSource: "export const chat = true;"
  };
  const first = providerPolicyObservationFromArgv("pi", argv, "fixture", resources);
  const second = providerPolicyObservationFromArgv("pi", argv, "fixture", {
    ...resources,
    piReadonlyGitExtensionSource: "export const revision = 2;"
  });

  assert.notEqual(first.hook.helperDigest, second.hook.helperDigest);
});

test("pi Runtime rejects caller-supplied extensions", () => {
  const workspace = mkdtempSync(join(tmpdir(), "rollerskate-pi-extension-policy-"));
  try {
    assert.throws(() => new PiRuntimeAgent({
      executable: "/absolute/pi",
      projectRoot: workspace,
      environment: {},
      timeoutMilliseconds: 3_000,
      launchArgs: ["--extension=/tmp/untrusted.mjs"]
    }), /resource and prompt loading is controlled by the Runtime adapter/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

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

test("pi keeps JSON events and loads the bounded Rollerskate read tools in Chat", async () => {
  const fixture = piFixture();
  const context = {
    repoRoot: fixture.workspace,
    runtimeDirectory: "/tmp/rollerskate-runtime",
    topicId: "topic-fixture",
    sourceMessageEventId: "evt_source"
  };
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000,
    chatToolGrant: chatToolGrant(),
    resolveChatToolContext: () => context
  });

  const result = await agent.invoke({ event: chatEvent() });
  const request = invocation(fixture.invocation);
  assert.deepEqual(result.outcome, { kind: "message", body: "done" });
  assert.equal(valueAfter(request.args, "--mode"), "rpc");
  assert.equal(valueAfter(request.args, "--session-id"), result.providerSessionId);
  const tools = valueAfter(request.args, "--tools")?.split(",") ?? [];
  assert.equal(tools.includes("read_chat_history"), true);
  assert.equal(tools.includes("subscription_history"), true);
  assert.equal(tools.includes("get_run"), true);
  assert.equal(tools.includes("event_trace"), true);
  assert.equal(flagValues(request.args, "--extension").some((path) =>
    /resources\/agents\/pi-chat-history\.mjs$/u.test(path)
  ), true);
  assert.deepEqual(JSON.parse(request.context ?? "null"), context);
});

test("pi read grants load the bounded git extension and exclude mutation tools", async () => {
  const fixture = piFixture();
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000
  });

  await agent.invoke({ event: runEvent() });
  const request = invocation(fixture.invocation);
  assert.equal(valueAfter(request.args, "--tools"), "read,grep,find,ls,read_git_diff");
  assert.equal(valueAfter(request.args, "--tools")?.includes("bash"), false);
  assert.equal(valueAfter(request.args, "--tools")?.includes("write"), false);
  assert.equal(valueAfter(request.args, "--tools")?.includes("edit"), false);
  assert.equal(flagValues(request.args, "--extension").some((path) =>
    /resources\/agents\/pi-readonly-git\.mjs$/u.test(path)
  ), true);
});

test("pi write grants preserve mutation tools and exclude the git extension", async () => {
  const fixture = piFixture();
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000
  });

  await agent.invoke({ event: writeRunEvent() });
  const request = invocation(fixture.invocation);
  assert.equal(valueAfter(request.args, "--tools"), "read,write,edit,bash,grep,find,ls");
  assert.equal(valueAfter(request.args, "--tools")?.includes("read_git_diff"), false);
  assert.equal(flagValues(request.args, "--extension").some((path) =>
    /pi-readonly-git\.mjs$/u.test(path)
  ), false);
});

test("pi uses the shared meaningful stall watchdog and sends RPC abort", async () => {
  const fixture = piFixture({ stall: true });
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 1_000,
    meaningfulOutputTimeoutMilliseconds: 50
  });

  await assert.rejects(agent.invoke({ event: runEvent() }), (error: unknown) => {
    assert.equal(error instanceof AgentInvocationError, true);
    const failure = (error as AgentInvocationError).failure;
    assert.equal(failure.reason, "stall");
    assert.equal(failure.protocolStop, "requested");
    return true;
  });
  assert.equal(invocation(fixture.invocation).commands?.some(
    (command) => command.type === "abort"
  ), true);
});

test("pi progress renews idle only and cannot extend the Run deadline", async () => {
  const fixture = piFixture({ meaningfulForever: true });
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 1_000,
    meaningfulOutputTimeoutMilliseconds: 3_000
  });

  await assert.rejects(
    agent.invoke({ event: runEvent(1_500) }),
    (error: unknown) => {
      assert.equal(error instanceof AgentInvocationError, true);
      const failure = (error as AgentInvocationError).failure;
      assert.equal(failure.reason, "deadline");
      assert.equal(failure.totalTimeoutMilliseconds, 1_500);
      assert.equal(failure.recovery, "explicit_read_only_resume");
      assert.deepEqual(failure.lastProgress, { kind: "assistant" });
      assert.equal(JSON.stringify(failure).includes("streamed fixture"), false);
      return true;
    }
  );
  assert.equal(invocation(fixture.invocation).commands?.some(
    (command) => command.type === "abort"
  ), true);
});

test("pi progress can outlive the adapter timeout without a Run deadline", async () => {
  const fixture = piFixture({ meaningfulThenCompleteMilliseconds: 2_500 });
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 1_500
  });

  const result = await agent.invoke({ event: runEvent() });

  assert.deepEqual(result.outcome, { kind: "message", body: "done" });
  assert.equal(invocation(fixture.invocation).commands?.some(
    (command) => command.type === "abort"
  ), false);
});

test("pi classifies an early process exit without sending RPC abort", async () => {
  const fixture = piFixture({ exitBeforeSettlement: true });
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 5_000
  });

  await assert.rejects(agent.invoke({ event: runEvent() }), (error: unknown) => {
    assert.equal(error instanceof AgentInvocationError, true);
    const failure = (error as AgentInvocationError).failure;
    assert.equal(failure.reason, "protocol_exit");
    assert.equal(failure.phase, "terminated");
    assert.equal(failure.protocolStop, "unavailable");
    return true;
  });
  assert.equal(invocation(fixture.invocation).commands?.some(
    (command) => command.type === "abort"
  ), false);
});

test("pi sends prompt only after get_state settles the session", async () => {
  const fixture = piFixture({ settlementCheck: true });
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000
  });

  const result = await agent.invoke({ event: runEvent() });
  assert.deepEqual(result.outcome, { kind: "message", body: "done" });

  const commands = invocation(fixture.invocation).commands;
  assert.equal(commands?.[0]?.type, "get_state");
  assert.equal(commands?.some((command) => command.type === "prompt"), true);
  assert.equal(readFileSync(fixture.settlementMarker, "utf8"), "settled");
});

test("pi fails closed when get_state Session id does not match", async () => {
  const fixture = piFixture({ mismatchedSession: true });
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000
  });

  await assert.rejects(agent.invoke({ event: runEvent() }), (error: unknown) => {
    assert.equal(error instanceof AgentInvocationError, true);
    assert.equal((error as AgentInvocationError).failure.reason, "protocol_error");
    return true;
  });
  assert.equal(
    invocation(fixture.invocation).commands?.some((command) => command.type === "prompt"),
    false
  );
});

test("pi fails closed on a crossed get_state response id", async () => {
  const fixture = piFixture({ crossedStateId: true });
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000
  });

  await assert.rejects(agent.invoke({ event: runEvent() }), (error: unknown) => {
    assert.equal(error instanceof AgentInvocationError, true);
    assert.equal((error as AgentInvocationError).failure.reason, "protocol_error");
    return true;
  });
  assert.equal(
    invocation(fixture.invocation).commands?.some((command) => command.type === "prompt"),
    false
  );
});

test("pi fails closed on an unknown RPC response command", async () => {
  const fixture = piFixture({ unknownStateCommand: true });
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000
  });

  await assert.rejects(agent.invoke({ event: runEvent() }), (error: unknown) => {
    assert.equal(error instanceof AgentInvocationError, true);
    assert.equal((error as AgentInvocationError).failure.reason, "protocol_error");
    return true;
  });
  assert.equal(
    invocation(fixture.invocation).commands?.some((command) => command.type === "prompt"),
    false
  );
});

test("pi fails closed on a crossed prompt response id", async () => {
  const fixture = piFixture({ crossedPromptId: true });
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000
  });

  await assert.rejects(agent.invoke({ event: runEvent() }), (error: unknown) => {
    assert.equal(error instanceof AgentInvocationError, true);
    assert.equal((error as AgentInvocationError).failure.reason, "protocol_error");
    return true;
  });
  assert.equal(
    invocation(fixture.invocation).commands?.some((command) => command.type === "prompt"),
    true
  );
});

test("pi fails closed on an exact prompt response before get_state settles", async () => {
  const fixture = piFixture({ earlyPromptResponse: true });
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000
  });

  await assert.rejects(agent.invoke({ event: runEvent() }), (error: unknown) => {
    assert.equal(error instanceof AgentInvocationError, true);
    assert.equal((error as AgentInvocationError).failure.reason, "protocol_error");
    return true;
  });
  assert.equal(
    invocation(fixture.invocation).commands?.some((command) => command.type === "prompt"),
    false
  );
});

test("pi fails closed on a duplicate get_state response", async () => {
  const fixture = piFixture({ duplicateStateResponse: true });
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000
  });

  await assert.rejects(agent.invoke({ event: runEvent() }), (error: unknown) => {
    assert.equal(error instanceof AgentInvocationError, true);
    assert.equal((error as AgentInvocationError).failure.reason, "protocol_error");
    return true;
  });
});

test("pi fails closed on a duplicate prompt response", async () => {
  const fixture = piFixture({ duplicatePromptResponse: true });
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 3_000
  });

  await assert.rejects(agent.invoke({ event: runEvent() }), (error: unknown) => {
    assert.equal(error instanceof AgentInvocationError, true);
    assert.equal((error as AgentInvocationError).failure.reason, "protocol_error");
    return true;
  });
});

test("pi never re-arms a watchdog after settlement", async () => {
  const fixture = piFixture({ postSettlementBatch: true });
  const agent = new PiRuntimeAgent({
    executable: fixture.executable,
    projectRoot: fixture.workspace,
    environment: {},
    timeoutMilliseconds: 5_000,
    meaningfulOutputTimeoutMilliseconds: 60_000
  });

  await assert.rejects(agent.invoke({ event: runEvent() }), (error: unknown) => {
    assert.equal(error instanceof AgentInvocationError, true);
    assert.equal((error as AgentInvocationError).failure.reason, "protocol_error");
    return true;
  });
  assert.equal(
    process.getActiveResourcesInfo().includes("Timeout"),
    false,
    "a watchdog timer was re-armed after settlement"
  );
});

function piFixture(options: {
  readonly stall?: boolean;
  readonly meaningfulForever?: boolean;
  readonly meaningfulThenCompleteMilliseconds?: number;
  readonly exitBeforeSettlement?: boolean;
  readonly settlementCheck?: boolean;
  readonly mismatchedSession?: boolean;
  readonly crossedStateId?: boolean;
  readonly crossedPromptId?: boolean;
  readonly unknownStateCommand?: boolean;
  readonly earlyPromptResponse?: boolean;
  readonly duplicateStateResponse?: boolean;
  readonly duplicatePromptResponse?: boolean;
  readonly postSettlementBatch?: boolean;
} = {}): {
  readonly workspace: string;
  readonly executable: string;
  readonly invocation: string;
  readonly settlementMarker: string;
} {
  const workspace = temporaryDirectory("rollerskate-pi-runtime-");
  const executable = join(workspace, "pi-fixture");
  const invocation = join(workspace, "invocation.json");
  const settlementMarker = join(workspace, "settlement-order.txt");
  const sessionIdExpression = options.mismatchedSession === true
    ? 'sessionId + "-mismatch"'
    : "sessionId";
  const getStateResponseId = options.crossedStateId === true ? '"prompt"' : "command.id";
  const getStateResponseCommand = options.unknownStateCommand === true
    ? '"bogus"'
    : '"get_state"';
  const getStateResponse = `JSON.stringify({
    id: ${getStateResponseId},
    type: "response",
    command: ${getStateResponseCommand},
    success: true,
    data: { sessionId: ${sessionIdExpression} }
  })`;
  const writeStateResponse = `process.stdout.write(${getStateResponse} + "\\n");`;
  const stateResponseWrites = options.duplicateStateResponse === true
    ? `${writeStateResponse}\n      ${writeStateResponse}`
    : writeStateResponse;
  const getStateHandler = options.settlementCheck === true
    ? `setTimeout(() => {
        stateResponded = true;
        fs.writeFileSync(${JSON.stringify(settlementMarker)}, commands.some((c) => c.type === "prompt") ? "early" : "settled");
        ${stateResponseWrites}
      }, 100);`
    : stateResponseWrites;
  const earlyPromptResponse = options.earlyPromptResponse === true
    ? `process.stdout.write(JSON.stringify({
        id: "prompt",
        type: "response",
        command: "prompt",
        success: true
      }) + "\\n");`
    : "";
  const earlyPromptGuard = options.settlementCheck === true
    ? `if (!stateResponded) fs.writeFileSync(${JSON.stringify(settlementMarker)}, "early");`
    : "";
  const promptResponseId = options.crossedPromptId === true ? '"state"' : "command.id";
  const writePromptResponse = `process.stdout.write(JSON.stringify({
        id: ${promptResponseId},
        type: "response",
        command: "prompt",
        success: true
      }) + "\\n");`;
  const promptResponseWrites = options.duplicatePromptResponse === true
    ? `${writePromptResponse}\n      ${writePromptResponse}`
    : writePromptResponse;
  const promptTail = options.postSettlementBatch === true
    ? `process.stdout.write([
      JSON.stringify({ id: "prompt", type: "response", command: "prompt", success: true }),
      JSON.stringify({ id: "prompt", type: "response", command: "prompt", success: true }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "late" }] } }),
      JSON.stringify({ type: "agent_settled" })
    ].join("\\n") + "\\n");`
    : `${promptResponseWrites}
      ${options.exitBeforeSettlement === true ? "process.exit(143);" : options.stall === true ? "" : `if (args.includes("--emit-large-trace")) process.stdout.write(JSON.stringify({
        type: "tool_execution_end",
        toolName: "Bash",
        output: "x".repeat(512)
      }) + "\\n");
      ${options.meaningfulThenCompleteMilliseconds !== undefined ? `const updates = setInterval(() => process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "thinking fixture" } }) + "\\n"), 50);
      setTimeout(() => {
        clearInterval(updates);
        process.stdout.write(JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] }
        }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      }, ${options.meaningfulThenCompleteMilliseconds});` : options.meaningfulForever === true ? `setInterval(() => process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streamed fixture" } }) + "\\n"), 5);` : `process.stdout.write(JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] }
      }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");`}`}`;
  writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const commands = [];
const save = () => fs.writeFileSync(${JSON.stringify(invocation)}, JSON.stringify({
  args, commands, context: process.env.${PI_CHAT_TOOL_CONTEXT_ENV}
}));
save();
let input = "";
let stateResponded = false;
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (input.includes("\\n")) {
    const index = input.indexOf("\\n");
    const line = input.slice(0, index);
    input = input.slice(index + 1);
    if (line === "") continue;
    const command = JSON.parse(line);
    commands.push(command);
    save();
    const sessionId = valueAfter("--session-id");
    if (command.type === "get_state") {
      ${earlyPromptResponse}
      ${getStateHandler}
    }
    if (command.type === "prompt") {
      ${earlyPromptGuard}
      ${promptTail}
    }
    if (command.type === "abort") process.exit(0);
  }
});
`);
  chmodSync(executable, 0o700);
  return { workspace, executable, invocation, settlementMarker };
}

function invocation(path: string): {
  readonly args: string[];
  readonly commands?: Array<Record<string, unknown>>;
  readonly context?: string;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    readonly args: string[];
    readonly commands?: Array<Record<string, unknown>>;
    readonly context?: string;
  };
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && index + 1 < args.length) {
      values.push(args[index + 1]!);
    }
  }
  return values;
}

function writeRunEvent(): AgentInputEvent {
  const eventId = "evt_019f92c9-0000-7000-8000-000000000022";
  return {
    eventId,
    type: "agent.request",
    source: { kind: "cli" },
    agentId: "prn_019f92c9-0000-7000-8000-000000000020",
    destinationIds: [],
    causality: { rootEventId: eventId, hop: 0 },
    prompt: "respond directly",
    runContext: {
      schemaVersion: "AgentRunContext@1" as const,
      resultContractId: "agent-turn-result@1",
      runId: "run_019f92c9-0000-7000-8000-000000000022",
      stepId: "stp_019f92c9-0000-7000-8000-000000000022",
      depth: 0,
      workspaceGrant: {
        schemaVersion: "ExternalWorkspaceGrant@1" as const,
        root: "/tmp/rollerskate-write-workspace",
        access: "write" as const,
        revision: "rev_write"
      }
    },
    createdAt: "2026-07-25T00:00:00.000Z"
  };
}

function runEvent(totalTimeoutMilliseconds?: number): AgentInputEvent {
  const eventId = "evt_019f92c9-0000-7000-8000-000000000020";
  return {
    eventId,
    type: "agent.request",
    source: { kind: "cli" },
    agentId: "prn_019f92c9-0000-7000-8000-000000000020",
    destinationIds: [],
    causality: { rootEventId: eventId, hop: 0 },
    prompt: "respond directly",
    ...(totalTimeoutMilliseconds === undefined ? {} : {
      runContext: {
        schemaVersion: "AgentRunContext@1" as const,
        resultContractId: "agent-turn-result@1",
        runId: "run_019f92c9-0000-7000-8000-000000000020",
        stepId: "stp_019f92c9-0000-7000-8000-000000000020",
        depth: 0,
        invocationBudget: {
          schemaVersion: "AgentInvocationBudget@1" as const,
          totalTimeoutMilliseconds
        }
      }
    }),
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
