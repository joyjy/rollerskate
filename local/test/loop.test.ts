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
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { LocalDeviceStore } from "../src/infrastructure/files/device-binding-store.js";
import { runtimeStatus } from "../src/application/runtime/control.js";
import { startRuntime } from "../src/bootstrap/runtime.js";
import { runLocalApp } from "../src/entrypoints/cli/main.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { startUiServer } from "../src/entrypoints/console/launcher.js";
import { addLocalAgent } from "../src/application/agent/control.js";
import { enqueueAgentRequest } from "../src/application/agent/server-control.js";
import { runtimeOperationsView } from "../src/application/runtime/query.js";
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
    bootstrapLocalFoundation(paths, now);
    const agents = new LocalFoundationStore(paths.database);
    agents.addAgent("alice", "codex", now);
    agents.close();

    const controller = new AbortController();
    let output = "";
    let consoleView: {
      workspaceRoot: string;
      failures: readonly {
        owner: string;
        reason: string;
        action: { readonly consoleRoute?: string };
      }[];
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
          consoleView = runtimeOperationsView(
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

test("Local Runtime does not auto-enroll an Agent added after governance materialization", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-late-agent-repo-"));
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-late-agent-runtime-"));
  try {
    const executable = join(runtime, "codex-fixture");
    writeFileSync(executable, codexFixtureSource(
      "late-provider-session",
      JSON.stringify({
        schema: "ChatMentionDecision@1",
        speech: { action: "reply", body: "late Agent ready" }
      })
    ));
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
    assert.equal(reply, undefined);
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
    writeFileSync(executable, codexFixtureSource(
      "offline-provider-session",
      "offline result"
    ));
    chmodSync(executable, 0o700);
    const eventId = enqueueAgentRequest(repo, "alice", "work offline", {
      runtimeDirectory: runtime
    }).event.eventId;

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
        `).get() as { value: string }).value, "69");
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
      const response = await fetch(`${new URL(ui.url).origin}/api/events/${eventId}`);
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

function seedRuntime(
  repo: string,
  runtime: string
): {
  readonly executable: string;
  readonly invocations: string;
  readonly deviceId: string;
  readonly workspace: string;
} {
  const paths = runtimePaths(repo, runtime);
  mkdirSync(paths.agentCredentials, { recursive: true, mode: 0o700 });
  const foundation = bootstrapLocalFoundation(paths, now);
  const devices = new LocalDeviceStore(paths.deviceBinding, {
    deviceId: foundation.deviceId,
    deviceName: foundation.deviceName
  });
  const pairing = devices.beginPairing("http://localhost:3000", "Test Device");
  devices.activate("device-credential-1", deviceSummary(pairing.deviceId), now);
  devices.close();

  const workspace = join(runtime, "workspace", "alice");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const agents = new LocalFoundationStore(paths.database);
  agents.addAgent("alice", "codex", now);
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
  writeFileSync(executable, codexFixtureSource(
    "session-one",
    JSON.stringify({ action: { type: "reply", body: "hello from alice" } }),
    `fs.appendFileSync(${JSON.stringify(invocations)}, "invoked\\n");`
  ));
  chmodSync(executable, 0o700);
  return { executable, invocations, deviceId: pairing.deviceId, workspace };
}

function codexFixtureSource(
  sessionId: string,
  assistantText: string,
  onTurnSource: string = ""
): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 0) send({ id: 0, result: {} });
  if (message.id === 1) send({ id: 1, result: { thread: {
    id: message.params.threadId || ${JSON.stringify(sessionId)}
  } } });
  if (message.id === 2) {
    ${onTurnSource}
    send({ id: 2, result: { turn: { id: "turn-fixture", items: [], status: "inProgress" } } });
    send({ method: "item/completed", params: {
      threadId: message.params.threadId, turnId: "turn-fixture", completedAtMs: Date.now(),
      item: { id: "message-fixture", type: "agentMessage", text: ${JSON.stringify(assistantText)} }
    } });
    send({ method: "turn/completed", params: {
      threadId: message.params.threadId,
      turn: { id: "turn-fixture", items: [], status: "completed" }
    } });
  }
});
`;
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
