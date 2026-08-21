import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentInputEvent, ChatDispatchEvent } from "../src/core/event/model.js";
import { CodexRuntimeAgent } from "../src/integrations/agent/codex.js";
import { CodexAppServerRunner } from
  "../src/integrations/agent/runner/codex-app-server.js";
import { admitSameClientHistoryPolicy } from
  "../src/modules/agent/activity-policy.js";

test("Codex uses app-server Threads, bounded events and protocol policy", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "rollerskate-codex-runtime-"));
  const executable = join(workspace, "codex-fixture");
  const invocations = join(workspace, "invocations.jsonl");
  writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const messages = [];
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  const message = JSON.parse(line);
  messages.push(message);
  if (message.id === 0) send({ id: 0, result: { userAgent: "fixture" } });
  if (message.id === 1) send({ id: 1, result: { thread: {
    id: message.params.threadId || "provider-session"
  } } });
  if (message.id === 2) {
    send({ id: 2, result: { turn: {
      id: "turn-fixture", items: [], status: "inProgress"
    } } });
    send({ method: "item/agentMessage/delta", params: {
      threadId: message.params.threadId,
      turnId: "turn-fixture", itemId: "message-fixture", delta: "done"
    } });
    send({ method: "item/completed", params: {
      threadId: message.params.threadId,
      turnId: "turn-fixture", completedAtMs: Date.now(),
      item: { id: "command-fixture", type: "commandExecution", status: "completed" }
    } });
    const usage = {
      inputTokens: 12, cachedInputTokens: 3, outputTokens: 4,
      reasoningOutputTokens: 0, totalTokens: 16
    };
    send({ method: "thread/tokenUsage/updated", params: {
      threadId: message.params.threadId,
      turnId: "turn-fixture", tokenUsage: { last: usage, total: usage }
    } });
    send({ method: "turn/completed", params: {
      threadId: message.params.threadId,
      turn: { id: "turn-fixture", items: [], status: "completed" }
    } });
  }
});

rl.on("close", () => {
  fs.appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({
    args: process.argv.slice(2), messages,
    policy: process.env.ROLLERSKATE_CLIENT_HISTORY_POLICY
  }) + "\\n");
});
`);
  chmodSync(executable, 0o700);
  const agent = new CodexRuntimeAgent({
    executable,
    projectRoot: workspace,
    environment: {},
    timeoutMilliseconds: 3_000,
    resolveMcpServers: ({ event }) => event.type === "chat.dispatch"
      ? [{
          name: "rollerskate_client_history",
          command: process.execPath,
          args: ["/tool/client-history.js", "--agent-id", event.agentId]
        }]
      : [],
    serializeMcpPolicy: (observation) =>
      JSON.stringify(admitSameClientHistoryPolicy(observation))
  });
  assert.equal(agent.providerPolicy.client, "codex");
  assert.equal(agent.providerPolicy.controls.transport, "app-server");

  const freshResult = await agent.invoke({
    event: event("evt_019f92c9-0000-7000-8000-000000000001")
  });
  await agent.invoke({
    event: subscriptionEvent("evt_019f92c9-0000-7000-8000-000000000002", workspace),
    providerSessionId: "desktop-session"
  });
  await agent.invoke({
    event: chatEvent("evt_019f92c9-0000-7000-8000-000000000003"),
    providerSessionId: "desktop-session"
  });
  await agent.invoke({
    event: networkRunEvent("evt_019f92c9-0000-7000-8000-000000000004", workspace)
  });

  type Invocation = {
    args: string[];
    messages: Array<{ id?: number; method: string; params?: Record<string, unknown> }>;
    policy?: string;
  };
  const [fresh, resumed, withTools, networkRun] = readFileSync(invocations, "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as Invocation);
  assert.deepEqual(fresh!.args, ["app-server", "--stdio"]);
  assert.deepEqual(resumed!.args, ["app-server", "--stdio"]);
  const freshThread = message(fresh!, "thread/start");
  const resumedThread = message(resumed!, "thread/resume");
  assert.equal(freshThread.params!.approvalPolicy, "never");
  assert.equal(freshThread.params!.sandbox, "read-only");
  assert.equal(resumedThread.params!.threadId, "desktop-session");
  assert.equal(resumedThread.params!.sandbox, "workspace-write");
  assert.deepEqual(
    (resumedThread.params!.config as Record<string, unknown>).sandbox_workspace_write,
    { network_access: true }
  );
  const resumedTurn = message(resumed!, "turn/start");
  assert.match(JSON.stringify(resumedTurn.params), /Terminal observation:/);
  assert.match(JSON.stringify(resumedTurn.params), /terminal/);
  assert.equal(message(networkRun!, "thread/start").params!.sandbox, "workspace-write");
  assert.equal(fresh!.policy, undefined);
  assert.equal(resumed!.policy, undefined);

  const toolConfig = message(withTools!, "thread/resume").params!.config as {
    mcp_servers: Record<string, { args: string[]; env_vars: string[] }>;
    shell_environment_policy: { exclude: string[] };
  };
  const history = toolConfig.mcp_servers.rollerskate_client_history!;
  assert.deepEqual(history.args, [
    "/tool/client-history.js", "--agent-id", chatEvent("ignored").agentId
  ]);
  assert.deepEqual(history.env_vars, ["ROLLERSKATE_CLIENT_HISTORY_POLICY"]);
  assert.deepEqual(toolConfig.shell_environment_policy.exclude,
    ["ROLLERSKATE_CLIENT_HISTORY_POLICY"]);
  const policy = JSON.parse(withTools!.policy!) as {
    client: string;
    activityAccess: string;
    controls: Record<string, unknown>;
    fingerprint: string;
  };
  assert.equal(policy.client, "codex");
  assert.equal(policy.activityAccess, "same-client-history-read");
  assert.equal(policy.controls.historyPolicyEnvironment, "excluded-from-shell");
  assert.match(policy.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(freshResult.invocation?.tokenUsage, {
    inputTokens: 12, outputTokens: 4, cacheReadTokens: 3, totalTokens: 16
  });
  assert.deepEqual(freshResult.invocation?.toolUsage,
    [{ name: "commandExecution", count: 1 }]);
  assert.equal(freshResult.invocation?.turnCount, 1);
});

test("Codex app-server fails closed on an unexpected approval request", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "rollerskate-codex-approval-"));
  const executable = join(workspace, "codex-fixture");
  writeFileSync(executable, `#!${process.execPath}
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 0) {
    send({ id: 0, result: {} });
    send({ id: "approval", method: "item/commandExecution/requestApproval", params: {} });
  }
});
`);
  chmodSync(executable, 0o700);
  const runner = new CodexAppServerRunner({
    adapterId: "fixture",
    executable,
    environment: {},
    workingDirectory: workspace,
    timeoutMilliseconds: 3_000,
    maxOutputBytes: 1_024,
    threadParameters: {
      cwd: workspace,
      approvalPolicy: "never",
      sandbox: "read-only"
    }
  });
  await assert.rejects(
    runner.invoke({ prompt: "test", workspaceAccess: "read" }),
    /unexpectedly requested item\/commandExecution\/requestApproval/
  );
});

function message(
  invocation: { messages: Array<{ method: string; params?: Record<string, unknown> }> },
  method: string
) {
  return invocation.messages.find((candidate) => candidate.method === method)!;
}

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

function networkRunEvent(eventId: string, workspace: string): AgentInputEvent {
  const base = event(eventId);
  if (base.type !== "agent.request") throw new Error("fixture must be agent.request");
  return {
    ...base,
    runContext: {
      schemaVersion: "AgentRunContext@1",
      resultContractId: "agent-turn-result@1",
      runId: "run_019f92c9-0000-7000-8000-000000000001",
      stepId: "step_019f92c9-0000-7000-8000-000000000001",
      depth: 0,
      workspaceGrant: {
        schemaVersion: "ExternalWorkspaceGrant@1",
        root: workspace,
        access: "write",
        networkAccess: true,
        revision: "wrk_fixture"
      }
    }
  };
}

function chatEvent(eventId: string): ChatDispatchEvent {
  return {
    eventId,
    type: "chat.dispatch",
    source: { kind: "handler" },
    agentId: "prn_019f92c9-0000-7000-8000-000000000001",
    topicId: "topic-local",
    sourceAttentionEventId: eventId,
    targetHandleSnapshot: "codex",
    promptResourceId: "rollerskate.chat.free-turn.v1",
    prompt: "use list_client_threads",
    destinationIds: [],
    causality: { rootEventId: eventId, hop: 1 },
    createdAt: "2026-08-12T04:00:00.000Z"
  };
}

function subscriptionEvent(eventId: string, workspace: string): AgentInputEvent {
  return {
    ...event(eventId),
    type: "subscription.fire",
    source: { kind: "subscription", externalId: "sub_fixture" },
    observation: {
      version: "pipeline-1:passed",
      facts: { status: "passed" },
      terminal: "success",
      summary: "Pipeline passed"
    },
    invocation: {
      schemaVersion: "SubscriptionAgentInvocation@1",
      resultSchema: "SubscriptionAgentResult@1",
      workspaceGrant: {
        schemaVersion: "ExternalWorkspaceGrant@1",
        root: workspace,
        access: "write",
        revision: "wrk_fixture"
      },
      networkAccess: true
    }
  };
}
