import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";
import { runtimeStatus } from "../src/application/runtime/control.js";
import { startRuntime } from "../src/bootstrap/runtime.js";
import { runLocalApp } from "../src/entrypoints/cli/main.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { LoopWakeSignal, runLoop } from "../src/core/loop.js";
import { subscribeRuntimeWork } from "../src/core/runtime/wake.js";
import { startUiServer } from "../src/entrypoints/console/launcher.js";
import { addLocalAgent } from "../src/application/agent/control.js";
import { enqueueAgentRequest } from "../src/application/agent/server-control.js";
import { runtimeOperationsView } from "../src/application/runtime/query.js";
import {
  localChatView,
  postLocalChatMessage
} from "../src/application/chat/control.js";

const now = "2026-07-20T00:00:00.000Z";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("core loop does not lose a wake raised before it begins waiting", async () => {
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-loop-wake-"));
  const controller = new AbortController();
  const wakeSignal = new LoopWakeSignal();
  let phaseRuns = 0;
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    const result = await runLoop({
      statePath: join(runtime, "loop.json"),
      runtimeDirectory: runtime,
      runtimeRevision: "test-revision",
      agentNames: [],
      routeIds: [],
      phases: [{
        scope: "wake-test",
        async run() {
          phaseRuns += 1;
          if (phaseRuns === 1) wakeSignal.wake();
          else controller.abort();
          return undefined;
        }
      }],
      paused: () => false,
      pollMilliseconds: 60_000,
      wakeSignal
    }, controller.signal);
    assert.equal(phaseRuns, 2);
    assert.equal(result.cycles, 2);
  } finally {
    clearTimeout(timeout);
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("RuntimeStore publishes newly persisted work to the in-process loop", () => {
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-runtime-wake-"));
  const databasePath = join(runtime, "runtime.db");
  const initialized = new RuntimeStore(databasePath);
  initialized.close();
  const database = new DatabaseSync(databasePath);
  const store = new RuntimeStore(database);
  let wakes = 0;
  const unsubscribe = subscribeRuntimeWork(databasePath, () => {
    wakes += 1;
  });
  try {
    store.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "wake-once" },
      agentId: "agent-1",
      prompt: "wake the loop"
    });
    store.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "wake-once" },
      agentId: "agent-1",
      prompt: "wake the loop"
    });
    assert.equal(wakes, 1);
  } finally {
    unsubscribe();
    store.close();
    database.close();
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("Local startup restores a missing workspace and executes there without Server", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-workspace-repo-"));
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-workspace-runtime-"));
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5_000);
  try {
    const paths = runtimePaths(repo, runtime);
    addLocalAgent(repo, "alice", "codex", { runtimeDirectory: runtime });
    const executable = join(runtime, "codex-fixture");
    const cwdReceipt = join(runtime, "invocation-cwd.txt");
    writeFileSync(executable, codexFixtureSource(
      "workspace-provider-session",
      "workspace restored",
      `fs.writeFileSync(${JSON.stringify(cwdReceipt)}, process.cwd());`
    ));
    chmodSync(executable, 0o700);
    const eventId = enqueueAgentRequest(repo, "alice", "check workspace", {
      runtimeDirectory: runtime
    }).event.eventId;
    renameSync(paths.workspace, join(runtime, "previous-workspace"));

    let output = "";
    let serverRequests = 0;
    await startRuntime({
      repoRoot: repo,
      runtimeDirectory: runtime,
      codexExecutable: executable,
      environment: { HOME: repo },
      pollMilliseconds: 50,
      fetch: async () => {
        serverRequests += 1;
        throw new Error("Local startup must not contact Server");
      },
      output: { write(text) {
        output += text;
        if (text.includes('"type":"runtime.cycle"')) controller.abort();
      } }
    }, controller.signal);

    const workspace = join(realpathSync(runtime), "workspace");
    assert.equal(serverRequests, 0);
    assert.equal(readFileSync(cwdReceipt, "utf8"), workspace);
    assert.doesNotMatch(output, /runtime\.adapter_unavailable/);
    assert.match(output, /Runtime loop ready: 1 Agent\(s\), 1 Route\(s\)/);
    const store = new RuntimeStore(paths.database);
    try {
      assert.equal(store.executionForEvent(eventId)?.status, "succeeded");
      assert.equal(store.sessions()[0]?.workspace, workspace);
      assert.equal(store.sessions()[0]?.providerSessionId, "workspace-provider-session");
    } finally {
      store.close();
    }
    assert.equal(runtimeOperationsView(projectRoot, runtime, "localhost:4300")
      .workspaceRoot, workspace);
  } finally {
    clearTimeout(deadline);
    controller.abort();
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
        `).get() as { value: string }).value, "75");
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

test("an in-process enqueue wakes the idle Runtime before its fallback scan", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-wake-request-repo-"));
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-wake-request-runtime-"));
  const controller = new AbortController();
  let running: Promise<{ readonly cycles: number; readonly stopped: true }> | undefined;
  try {
    addLocalAgent(repo, "alice", "codex", { runtimeDirectory: runtime });
    const executable = join(runtime, "codex-fixture");
    writeFileSync(executable, codexFixtureSource(
      "wake-provider-session",
      "woken before fallback"
    ));
    chmodSync(executable, 0o700);
    running = startRuntime({
      repoRoot: repo,
      runtimeDirectory: runtime,
      codexExecutable: executable,
      environment: { HOME: repo },
      pollMilliseconds: 60_000
    }, controller.signal);
    await waitUntil(() => {
      const state = runtimeStatus(repo, runtime).state;
      return state?.phase === "idle" && state.cycles >= 1;
    }, 2_000);

    const request = enqueueAgentRequest(repo, "alice", "wake while idle", {
      runtimeDirectory: runtime
    });
    const audit = new RuntimeStore(runtimePaths(repo, runtime).database, { migrate: false });
    try {
      await waitUntil(
        () => {
          const requestAudit = audit.audit(request.event.eventId);
          return requestAudit?.resultEvent?.output === "woken before fallback" &&
            requestAudit.resultExecution?.status === "succeeded";
        },
        2_000
      );
    } finally {
      audit.close();
    }
  } finally {
    controller.abort();
    await running;
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

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

async function waitUntil(predicate: () => boolean, timeoutMilliseconds: number): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Runtime state");
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}
