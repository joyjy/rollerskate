import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentSummary, DeviceSummary } from "../src/protocol.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { AgentCredentialStore } from "../src/infrastructure/files/agent-credential-store.js";
import { LocalAgentRegistryStore } from "../src/infrastructure/sqlite/agent-registry-store.js";
import { LocalDeviceStore } from "../src/infrastructure/sqlite/device-store.js";
import { runtimeStatus } from "../src/application/runtime/control.js";
import { startRuntime } from "../src/bootstrap/runtime.js";
import { PollSubscriptionStore } from "../src/capabilities/subscription/store.js";
import { runLocalApp } from "../src/entrypoints/cli/main.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { startUiServer } from "../src/entrypoints/console/launcher.js";
import { addLocalAgent } from "../src/application/agent/control.js";
import { runtimeConsoleView } from "../src/application/runtime/console-query.js";
import {
  localChatView,
  postLocalChatMessage
} from "../src/application/chat/control.js";

const now = "2026-07-20T00:00:00.000Z";
const roomId = "room-1";
const head = `r1.${Buffer.from(JSON.stringify([roomId, 1])).toString("base64url")}`;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test.skip("v0.4 Server Agent workspace does not block Local-first startup", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-stale-agent-repo-"));
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-stale-agent-runtime-"));
  try {
    const paths = runtimePaths(repo, runtime);
    const agents = new LocalAgentRegistryStore(paths.database);
    const summary = agentSummary("stale-device");
    agents.provision(summary, join(runtime, "deleted-workspace"));
    agents.activate(summary, "stale-credential", now);
    agents.close();

    const controller = new AbortController();
    let output = "";
    let consoleView: {
      workspaceRoot: string;
      failures: Array<{ owner: string; reason: string; action: { consoleRoute?: string } }>;
    } | undefined;
    await startRuntime({
      repoRoot: repo,
      runtimeDirectory: runtime,
      codexExecutable: process.execPath,
      environment: { HOME: repo },
      pollMilliseconds: 50,
      output: { write(text) {
        output += text;
        if (text.includes("Runtime loop ready:")) {
          consoleView = runtimeConsoleView(
            projectRoot,
            runtime,
            "localhost:4300"
          ) as typeof consoleView;
          controller.abort();
        }
      } }
    }, controller.signal);

    assert.match(output, /"type":"runtime\.adapter_unavailable"/);
    assert.match(output, /deleted-workspace/);
    assert.match(output, /Runtime loop ready: 0 Agent\(s\), 1 Route\(s\)/);
    assert.equal(consoleView?.workspaceRoot, join(realpathSync(runtime), "workspace"));
    assert.equal(consoleView?.failures[0]?.owner, "agent");
    assert.match(consoleView?.failures[0]?.reason ?? "", /No active local Agent/);
    assert.equal(consoleView?.failures[0]?.action.consoleRoute, "/console/agents");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("Local Runtime resolves an Agent added after the foreground loop starts", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-late-agent-repo-"));
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-late-agent-runtime-"));
  try {
    const executable = join(runtime, "codex-fixture");
    writeFileSync(executable, `#!${process.execPath}
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write([
    JSON.stringify({ type: "thread.started", thread_id: "late-provider-session" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({
      schema: "ChatMentionDecision@1",
      speech: { action: "reply", body: "late Agent ready" }
    }) } })
  ].join("\\n") + "\\n");
});
`);
    chmodSync(executable, 0o700);
    const controller = new AbortController();
    let admitted = false;
    await startRuntime({
      repoRoot: repo,
      runtimeDirectory: runtime,
      codexExecutable: executable,
      environment: { HOME: repo },
      pollMilliseconds: 50,
      output: { write(text) {
        if (!admitted && text.includes("Runtime loop ready:")) {
          admitted = true;
          addLocalAgent(repo, "late", "codex", { runtimeDirectory: runtime });
          postLocalChatMessage(repo, "@late prove dynamic admission", {
            runtimeDirectory: runtime
          });
        }
        if (text.includes('"type":"runtime.cycle"')) controller.abort();
      } }
    }, controller.signal);
    assert.equal(admitted, true);
    const reply = localChatView(repo, { runtimeDirectory: runtime }).events.find(
      (event) => event.type === "chat.message" &&
        event.sender.kind === "agent"
    );
    assert.equal(reply?.type, "chat.message");
    assert.equal(reply?.body, "late Agent ready");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("offline agent request enters SQLite and is handled without Device, Room or Matrix", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-offline-request-repo-"));
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-offline-request-runtime-"));
  try {
    const paths = runtimePaths(repo, runtime);
    addLocalAgent(repo, "alice", "codex", { runtimeDirectory: runtime });
    const executable = join(runtime, "codex-fixture");
    writeFileSync(executable, `#!${process.execPath}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  process.stdout.write([
    JSON.stringify({ type: "thread.started", thread_id: "offline-provider-session" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "offline result" } })
  ].join("\\n") + "\\n");
});
`);
    chmodSync(executable, 0o700);
    let requestOutput = "";
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtime, "agent", "request", "alice", "work", "offline"
    ], {}, { write(text) { requestOutput += text; } }), 0);
    const eventId = (JSON.parse(requestOutput) as { eventId: string }).eventId;

    const controller = new AbortController();
    let loopOutput = "";
    await startRuntime({
      repoRoot: repo,
      runtimeDirectory: runtime,
      codexExecutable: executable,
      environment: { HOME: repo },
      pollMilliseconds: 50,
      output: { write(text) {
        loopOutput += text;
        if (text.includes('"type":"runtime.cycle"')) controller.abort();
      } }
    }, controller.signal);

    const store = new RuntimeStore(paths.database);
    try {
      const schemaVersion = new DatabaseSync(paths.database, { readOnly: true });
      try {
        assert.equal((schemaVersion.prepare(`
          SELECT value FROM schema_meta WHERE key = 'schema_version'
        `).get() as { value: string }).value, "44");
      } finally {
        schemaVersion.close();
      }
      assert.equal(store.event(eventId)?.source.kind, "cli");
      assert.deepEqual(store.events().filter((event) => event.type === "agent.result")
        .map((event) => [event.outcome, event.output]), [["succeeded", "offline result"]]);
      assert.equal(store.sessions()[0]?.providerSessionId, "offline-provider-session");
      assert.equal(store.destinations().length, 0);
    } finally {
      store.close();
    }
    assert.match(loopOutput, /Runtime loop ready: 1 Agent\(s\), 1 Route\(s\)/);

    const uiController = new AbortController();
    const ui = await startUiServer({
      repoRoot: projectRoot,
      runtimeDirectory: runtime,
      port: 0,
      signal: uiController.signal
    });
    try {
      const response = await fetch(`${new URL(ui.url).origin}/api/runtime/events/${eventId}`);
      assert.equal(response.status, 200);
      const audit = await response.json() as {
        event: {
          eventId: string;
          type: string;
          source: { kind: string };
          destinationIds: string[];
        };
        execution?: { status: string; handler: string };
        resultEvent?: { type: string; outcome: string };
        resultExecution?: { status: string; handler: string };
        session?: { providerSessionId: string };
        deliveries: unknown[];
      };
      assert.equal(audit.event.eventId, eventId);
      assert.equal(audit.event.type, "agent.request");
      assert.equal(audit.event.source.kind, "cli");
      assert.deepEqual(audit.event.destinationIds, []);
      assert.deepEqual(audit.execution && [audit.execution.status, audit.execution.handler],
        ["succeeded", "agent"]);
      assert.deepEqual(audit.resultEvent && [audit.resultEvent.type, audit.resultEvent.outcome],
        ["agent.result", "succeeded"]);
      assert.deepEqual(audit.resultExecution
        && [audit.resultExecution.status, audit.resultExecution.handler],
      ["succeeded", "result"]);
      assert.equal(audit.session?.providerSessionId, "offline-provider-session");
      assert.deepEqual(audit.deliveries, []);
    } finally {
      uiController.abort();
      await ui.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test.skip("v0.4 Matrix loop runs the complete Handler without replay", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-local-loop-repo-"));
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-local-loop-runtime-"));
  try {
    const fixture = seedRuntime(repo, runtime);
    const fetchImplementation = serverFetch(fixture.deviceId);
    const firstController = new AbortController();
    let output = "";
    const first = await startRuntime({
      repoRoot: repo,
      runtimeDirectory: runtime,
      codexExecutable: fixture.executable,
      environment: { HOME: repo },
      pollMilliseconds: 50,
      fetch: fetchImplementation,
      output: { write(text) {
        output += text;
        if (text.includes('"type":"runtime.cycle"')) firstController.abort();
      } }
    }, firstController.signal);
    assert.equal(first.cycles, 1);
    assert.match(output, /"type":"matrix\.ingress_cycle"/);
    assert.equal(readFileSync(fixture.invocations, "utf8").trim().split("\n").length, 1);
    const stopped = runtimeStatus(repo, runtime);
    assert.equal(stopped.state?.status, "stopped");
    assert.equal(stopped.state?.phase, "idle");
    assert.equal(typeof stopped.state?.lastCycleStartAt, "string");
    assert.equal(typeof stopped.state?.lastCycleEndAt, "string");
    assert.equal(typeof stopped.state?.lastCycleDurationMs, "number");
    const audit = new RuntimeStore(runtimePaths(repo, runtime).database);
    try {
      const resultEvent = audit.events().find((event) => event.type === "agent.result");
      assert.equal(resultEvent?.outcome, "succeeded");
      assert.equal(audit.sessions().length, 1);
      assert.equal(audit.deliveriesForResultEvent(resultEvent!.eventId)[0]?.status, "delivered");
    } finally {
      audit.close();
    }

    const secondController = new AbortController();
    const timer = setTimeout(() => secondController.abort(), 120);
    try {
      const second = await startRuntime({
        repoRoot: repo,
        runtimeDirectory: runtime,
        codexExecutable: fixture.executable,
        environment: { HOME: repo },
        pollMilliseconds: 50,
        fetch: fetchImplementation
      }, secondController.signal);
      assert.ok(second.cycles >= 1);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(readFileSync(fixture.invocations, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test.skip("v0.4 Server Agent metadata selects the Claude Code adapter", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-claude-loop-repo-"));
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-claude-loop-runtime-"));
  try {
    const fixture = seedRuntime(repo, runtime, "claude-code");
    const controller = new AbortController();
    let output = "";
    await startRuntime({
      repoRoot: repo,
      runtimeDirectory: runtime,
      claudeCodeExecutable: fixture.executable,
      environment: { HOME: repo },
      pollMilliseconds: 50,
      fetch: serverFetch(fixture.deviceId),
      output: { write(text) {
        output += text;
        if (text.includes('"type":"runtime.cycle"')) controller.abort();
      } }
    }, controller.signal);
    assert.match(output, /"type":"matrix\.ingress_cycle"/);
    assert.equal(readFileSync(fixture.invocations, "utf8").trim(), "invoked");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test.skip("v0.4 Matrix loop isolates a Room sync timeout", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-room-timeout-repo-"));
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-room-timeout-runtime-"));
  try {
    const fixture = seedRuntime(repo, runtime);
    const delegate = serverFetch(fixture.deviceId);
    let headAttempts = 0;
    const fetchImplementation: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/head") && ++headAttempts === 1) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return delegate(input, init);
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    let output = "";
    try {
      const result = await startRuntime({
        repoRoot: repo,
        runtimeDirectory: runtime,
        codexExecutable: fixture.executable,
        environment: { HOME: repo },
        pollMilliseconds: 50,
        fetch: fetchImplementation,
        output: { write(text) {
          output += text;
          if (text.includes('"type":"runtime.cycle"')) controller.abort();
        } }
      }, controller.signal);
      assert.ok(result.cycles >= 2);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(headAttempts, 2);
    assert.match(output, /"type":"runtime\.cycle_failed","scope":"matrix"/);
    assert.match(output, /The operation was aborted due to timeout/);
    assert.match(output, /"type":"matrix\.ingress_cycle"/);
    assert.equal(runtimeStatus(repo, runtime).state?.status, "stopped");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test.skip("v0.4 Matrix-backed loop turns a terminal poll into subscription.fire", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-subscription-loop-repo-"));
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-subscription-loop-runtime-"));
  try {
    const fixture = seedRuntime(repo, runtime);
    const owner = addLocalAgent(repo, "subscriber", "codex", { runtimeDirectory: runtime });
    const queued = new RuntimeStore(runtimePaths(repo, runtime).database);
    queued.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "subscription-owner-session" },
      agentId: owner.principalId,
      prompt: "Create a callback Session."
    });
    queued.close();
    const fetchImplementation = serverFetch(fixture.deviceId);
    const firstController = new AbortController();
    await startRuntime({
      repoRoot: repo,
      runtimeDirectory: runtime,
      codexExecutable: fixture.executable,
      environment: { HOME: repo },
      pollMilliseconds: 50,
      fetch: fetchImplementation,
      output: { write(text) {
        if (text.includes('"type":"runtime.cycle"')) firstController.abort();
      } }
    }, firstController.signal);

    const invocationsBeforeSubscription = readFileSync(fixture.invocations, "utf8")
      .trim().split("\n").length;
    const runtimeStore = new RuntimeStore(runtimePaths(repo, runtime).database);
    const callbackSession = runtimeStore.sessions().find(
      (session) => session.agentId === owner.principalId
    )!;
    const callbackSessionId = callbackSession.sessionId;
    runtimeStore.close();

    const plugin = join(fixture.workspace, "pipeline.ts");
    writeFileSync(plugin, `
export default {
  kind: "subscription.probe",
  id: "fixture-pipeline",
  schemaVersion: 1,
  plan(config: { url: string }) { return { kind: "http", url: config.url }; },
  evaluate(_config: unknown, result: { body: string }) {
    const payload = JSON.parse(result.body) as { id: number; status: string };
    return { version: String(payload.id) + ":" + payload.status, facts: payload,
      terminal: payload.status === "success" ? "success" : null };
  }
};
`);
    const subscriptionFile = join(fixture.workspace, "subscription.json");
    writeFileSync(subscriptionFile, JSON.stringify({
      schemaVersion: 2,
      title: "Pipeline completed",
      ownerAgentId: owner.principalId,
      probe: {
        plugin: {
          path: plugin,
          id: "fixture-pipeline",
          config: { url: "http://localhost:3000/pipeline" }
        },
        policy: {
          allowedHttpOrigins: ["http://localhost:3000"],
          allowedExecutables: [],
          allowedEnvironment: [],
          timeoutMilliseconds: 1_000,
          maxOutputBytes: 4_096
        }
      },
      callback: {
        providerSessionId: callbackSession.providerSessionId,
        prompt: "Report the pipeline outcome."
      },
      schedule: {
        intervalMilliseconds: 100,
        maxWaitMilliseconds: 60_000,
        maxAttempts: 10
      }
    }));
    let addOutput = "";
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtime,
      "subscription", "add", subscriptionFile
    ], {}, { write(text) { addOutput += text; } }, {
      cwd: runtimePaths(repo, runtime).workspace
    }), 0);
    const subscriptionId = (JSON.parse(addOutput) as {
      subscription: { subscriptionId: string };
    }).subscription.subscriptionId;
    assert.match(subscriptionId, /^sub_[0-9a-f-]+$/);

    const secondController = new AbortController();
    let output = "";
    let fired = false;
    const notificationTitles: string[] = [];
    await startRuntime({
      repoRoot: repo,
      runtimeDirectory: runtime,
      codexExecutable: fixture.executable,
      environment: { HOME: repo },
      pollMilliseconds: 50,
      fetch: fetchImplementation,
      macOsNotificationRunner: async (notification) => {
        notificationTitles.push(notification.title);
      },
      output: { write(text) {
        output += text;
        if (text.includes('"type":"subscription.cycle"') && text.includes('"fired"')) {
          fired = true;
        } else if (fired && text.includes('"type":"runtime.cycle"')) {
          secondController.abort();
        }
      } }
    }, secondController.signal);
    assert.ok(output.includes(
      `"fired":[{"subscriptionId":"${subscriptionId}","eventId":"evt_`
    ));
    assert.deepEqual(notificationTitles, ["Pipeline completed"]);
    const inspect = new PollSubscriptionStore(runtimePaths(repo, runtime).database);
    try {
      assert.equal(inspect.require(subscriptionId).status, "completed");
      assert.match(inspect.require(subscriptionId).fireEventId ?? "", /^evt_/);
      const audit = new RuntimeStore(runtimePaths(repo, runtime).database);
      try {
        const execution = audit.executionForEvent(
          inspect.require(subscriptionId).fireEventId!
        );
        const session = audit.session(callbackSessionId);
        assert.equal(
          readFileSync(fixture.invocations, "utf8").trim().split("\n").length,
          invocationsBeforeSubscription + 1,
          `${output}\nExecution: ${JSON.stringify(execution)}\nSession: ${JSON.stringify(session)}`);
      } finally {
        audit.close();
      }
    } finally {
      inspect.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

function seedRuntime(
  repo: string,
  runtime: string,
  client: "codex" | "claude-code" = "codex"
): {
  readonly executable: string;
  readonly invocations: string;
  readonly deviceId: string;
  readonly workspace: string;
} {
  const paths = runtimePaths(repo, runtime);
  mkdirSync(paths.agentCredentials, { recursive: true, mode: 0o700 });
  const devices = new LocalDeviceStore(paths.database);
  const pairing = devices.beginPairing("http://localhost:3000", "Test Device");
  devices.activate("device-credential-1", deviceSummary(pairing.deviceId), now);
  devices.close();

  const workspace = join(runtime, "workspace", "alice");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const agents = new LocalAgentRegistryStore(paths.database);
  agents.provision(agentSummary(pairing.deviceId), workspace, client);
  agents.activate(agentSummary(pairing.deviceId), "agent-credential-1", now);
  agents.close();
  new AgentCredentialStore(paths.agentCredentials).save({
    state: "active",
    serverUrl: "http://localhost:3000",
    deviceId: pairing.deviceId,
    name: "alice",
    verifier: "verifier",
    agentId: "agent-1",
    placementId: "placement-1",
    enrollmentId: "enrollment-1",
    credentialId: "agent-credential-1",
    credential: "agent-secret"
  });

  const executable = join(runtime, "agent-fixture");
  const invocations = join(runtime, "invocations.txt");
  const response = client === "claude-code"
    ? `process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({ action: { type: "reply", body: "hello from alice" } }),
    session_id: "11111111-1111-4111-8111-111111111111",
    usage: { input_tokens: 5, output_tokens: 4 }
  }));`
    : `process.stdout.write([
    JSON.stringify({ type: "thread.started", thread_id: "session-one" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ action: { type: "reply", body: "hello from alice" } }) } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 4 } })
  ].join("\\n") + "\\n");`;
  writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(invocations)}, "invoked\\n");
  ${response}
});
`);
  chmodSync(executable, 0o700);
  return { executable, invocations, deviceId: pairing.deviceId, workspace };
}

function serverFetch(deviceId: string): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/agent-principals/agent-1") {
      return Response.json(agentSummary(deviceId));
    }
    if (url.pathname === "/api/agent-principals/agent-1/rooms") {
      return Response.json([{
        id: "binding-1",
        agentId: "agent-1",
        roomId,
        wakeMode: "mention_only",
        status: "active",
        createdAt: now,
        createdByHumanId: "human-1",
        updatedAt: now
      }]);
    }
    if (url.pathname === "/pipeline") {
      return Response.json({ id: 42, status: "success" });
    }
    if (url.pathname.endsWith("/head")) return Response.json({ roomId, head });
    if (url.pathname.endsWith("/events")) {
      return Response.json({
        roomId,
        through: head,
        events: [{
          roomId,
          position: head,
          event: {
            protocolVersion: 1,
            eventId: "$human-message",
            type: "m.chat.message",
            occurredAt: now,
            source: { kind: "human", id: "human-1" },
            payload: { body: "@alice please reply" }
          }
        }],
        complete: true
      });
    }
    if (url.pathname.endsWith("/messages") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { transactionId: string };
      return Response.json({ eventId: "$agent-reply", transactionId: body.transactionId });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
}

function deviceSummary(deviceId: string): DeviceSummary {
  return {
    id: deviceId,
    name: "Test Device",
    status: "active",
    createdAt: now,
    human: { id: "human-1", displayName: "Owner", isAdmin: true }
  };
}

function agentSummary(deviceId: string): AgentSummary {
  const human = { id: "human-1", displayName: "Owner", isAdmin: true };
  return {
    id: "agent-1",
    name: "alice",
    status: "active",
    createdAt: now,
    owner: human,
    operator: human,
    placement: {
      id: "placement-1",
      deviceId,
      state: "active",
      generation: 1,
      createdAt: now,
      activatedAt: now
    },
    credentialStatus: "active"
  };
}
