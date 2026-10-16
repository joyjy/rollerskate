import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, readdirSync, symlinkSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { temporaryDirectory } from "./support/temp-directory.js";
import { FileAgentInvocationJournal } from "../src/infrastructure/files/agent-invocation-journal.js";
import type { AgentRequestEvent } from "../src/core/event/model.js";
import type { RuntimeExecution } from "../src/core/runtime/model.js";

const at = "2026-10-15T00:00:00.000Z";
const event: AgentRequestEvent = {type: "agent.request", eventId: "evt_one", agentId: "agent_one", prompt: "private prompt",
  source: {kind: "cli"}, destinationIds: [], causality: {rootEventId: "evt_one", hop: 0}, createdAt: at,
  runContext: {schemaVersion: "AgentRunContext@1", resultContractId: "test", runId: "run_one", stepId: "stp_one", depth: 0}};
const execution: RuntimeExecution = {executionId: "exe_one", eventId: event.eventId, handler: "agent", status: "running",
  attemptCount: 1, maxAttempts: 1, nextAttemptAt: at, createdAt: at, updatedAt: at};

test("invocation evidence is readable before close, preserves identity and sanitizes external payloads", () => {
  const runtime = temporaryDirectory("rs-invocation-journal-");
  const journal = new FileAgentInvocationJournal(runtime, execution, event, "codex", {secrets: ["private-known-value"]});
  journal.append("invocation.started", {providerSessionId: "provider_one"});
  journal.append("assistant.delta", {text: "hello"});
  const records = () => readFileSync(journal.path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(records()[1].data.text, "hello");
  assert.equal(records()[1].runId, "run_one");
  assert.equal(records()[1].stepId, "stp_one");
  assert.equal(records()[1].executionId, "exe_one");
  assert.equal(records()[1].providerSessionId, "provider_one");
  assert.equal(existsSync(`${journal.path}.sealed`), false);
  journal.append("thought", {text: "hidden reasoning"});
  journal.append("tool.result", {text: "x".repeat(40000) + " private-known-value Bearer ABCDEFG", apiKey: "secret", raw: '{"password":"quoted-value"}\nCookie: session=private-cookie'});
  const ref = records().at(-1).data.file;
  const payload = readFileSync(join(dirname(journal.path), ref), "utf8");
  assert.ok(payload.includes("[REDACTED]"));
  assert.ok(!payload.includes("private-known-value"));
  assert.ok(!payload.includes("ABCDEFG"));
  assert.ok(!payload.includes("quoted-value"));
  assert.ok(!payload.includes("private-cookie"));
  assert.ok(!readFileSync(journal.path, "utf8").includes("hidden reasoning"));
  journal.append("invocation.failed", {message: "cancelled"});
  journal.close();
  assert.ok(existsSync(`${journal.path}.sealed`));
  assert.equal(lstatSync(journal.path).mode & 0o077, 0);
  assert.equal(lstatSync(join(dirname(journal.path), ref)).mode & 0o077, 0);
  const second = new FileAgentInvocationJournal(runtime, execution, event, "codex");
  assert.notEqual(second.path, journal.path);
  second.close();
  assert.ok(!existsSync(`${second.path}.sealed`));
});

test("journal bounds oversized payload and total evidence while retaining the terminal event", () => {
  const journal = new FileAgentInvocationJournal(temporaryDirectory("rs-invocation-limit-"), execution, event, "codex");
  journal.append("tool.result", {text: "x".repeat(1024 * 1024 + 1)});
  assert.ok(readFileSync(journal.path, "utf8").includes("payload_byte_limit"));
  for (let i = 0; i < 36; i++) journal.append("tool.result", {text: "x".repeat(1000000)});
  journal.append("invocation.failed", {message: "failure after limit"});
  journal.append("execution.state", {status: "failed"});
  journal.close();
  const text = readFileSync(journal.path, "utf8");
  assert.ok(text.includes("output.truncated"));
  assert.ok(text.includes("failure after limit"));
  assert.ok(text.includes("execution.state"));
  const total = readdirSync(dirname(journal.path)).reduce((sum, name) => sum + lstatSync(join(dirname(journal.path), name)).size, 0);
  assert.ok(total < 34 * 1024 * 1024);
});

test("journal refuses redirected directories and never overwrites an existing target", () => {
  const runtime = temporaryDirectory("rs-invocation-symlink-");
  const outside = temporaryDirectory("rs-invocation-outside-");
  symlinkSync(outside, join(runtime, "runs"));
  assert.throws(() => new FileAgentInvocationJournal(runtime, execution, event, "codex"), /private and regular/);
  assert.deepEqual(readdirSync(outside), []);
});

test("AgentHandler streams before completion and keeps journal faults out of business retries", async () => {
  const { RuntimeStore } = await import("../src/core/runtime/store.js");
  const { AgentHandler } = await import("../src/core/runtime/handlers.js");
  const runtime = temporaryDirectory("rs-journal-handler-");
  const store = new RuntimeStore(join(runtime, "runtime.db"));
  try {
    for (const mode of ["ok", "unavailable", "failure"]) {
      const unavailable = mode === "unavailable";
      const request = store.appendEvent({type: "agent.request", source: {kind: "cli"}, agentId: "agent-one", prompt: "test", createdAt: at});
      const execution = store.claimDueExecutions(100, at).find(item => item.eventId === request.event.eventId)!;
      let journal: FileAgentInvocationJournal | undefined;
      let invoked = 0;
      const handler = new AgentHandler({store,
        createInvocationJournal(execution, event, adapter) {
          if (unavailable) throw new Error("disk unavailable");
          return journal = new FileAgentInvocationJournal(runtime, execution, event, adapter.adapterId);
        },
        adapterForAgent: () => ({adapterId: "fixture", workspace: runtime, async invoke(input) {
          invoked++;
          input.reportOutput?.({kind: "assistant.delta", data: {text: "live"}});
          if (!unavailable) assert.ok(readFileSync(journal!.path, "utf8").includes("live"));
          if (mode === "failure") throw new Error('provider exited\nstdout: {"thinking":"hidden diagnostic"}');
          return {providerSessionId: input.event.eventId, outcome: {kind: "message", body: "done"}};
        }})});
      await handler.handle(execution, at);
      assert.equal(invoked, 1);
      assert.equal(store.execution(execution.executionId)?.status, mode === "failure" ? "retry_wait" : "succeeded", JSON.stringify(store.execution(execution.executionId)));
      if (journal) {
        const records = readFileSync(journal.path, "utf8").trim().split("\n").map(line => JSON.parse(line));
        assert.equal(records.at(-1).kind, "execution.state");
        assert.equal(records.at(-1).data.status, mode === "failure" ? "retry_wait" : "succeeded");
        assert.ok(!readFileSync(journal.path, "utf8").includes("hidden diagnostic"));
        assert.ok(existsSync(`${journal.path}.sealed`));
      }
    }
  } finally { store.close(); }
});

test("a killed writer leaves complete lines readable without inventing a terminal receipt", async () => {
  const { spawnSync } = await import("node:child_process");
  const { AgentInvocationLogMaintenance } = await import("../src/infrastructure/files/agent-invocation-log-maintenance.js");
  const runtime = temporaryDirectory("rs-journal-crash-");
  const moduleUrl = new URL("../src/infrastructure/files/agent-invocation-journal.js", import.meta.url).href;
  const script = `import {FileAgentInvocationJournal} from ${JSON.stringify(moduleUrl)};
    const journal = new FileAgentInvocationJournal(${JSON.stringify(runtime)}, ${JSON.stringify(execution)}, ${JSON.stringify(event)}, 'fixture');
    journal.append('assistant.delta', {text:'before crash'});
    process.stdout.write(journal.path + '\\n');
    process.kill(process.pid, 'SIGKILL');`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {encoding: "utf8", timeout: 5000});
  assert.equal(child.signal, "SIGKILL");
  const path = child.stdout.trim();
  const logs = new AgentInvocationLogMaintenance(runtime, {isRunTerminal: () => true});
  const records = logs.read(path) as {kind: string; data: {text: string}}[];
  assert.equal(records[0]?.data.text, "before crash");
  assert.equal(existsSync(`${path}.sealed`), false);
  assert.ok(logs.preview({compressAfterDays: 0}).protectedGroups.some(group => group.reason === "unsealed_invocation_log"));
});

test("real CLI read, capacity, cleanup preview and usage work without starting Runtime", async () => {
  const { runLocalAppWithUsage } = await import("../src/entrypoints/cli/main.js");
  const runtime = realpathSync(temporaryDirectory("rs-journal-cli-"));
  const journal = new FileAgentInvocationJournal(runtime, execution, event, "fixture");
  journal.append("assistant.delta", {text: "visible"});
  journal.close();
  const call = async (args: string[]) => {
    let text = "";
    const code = await runLocalAppWithUsage(runtime, ["--runtime", runtime, "run-log", ...args], {}, {write: value => {text += value;}});
    assert.equal(code, 0);
    return JSON.parse(text);
  };
  const read = await call(["read", journal.path]);
  assert.equal(read.records[0].data.text, "visible");
  assert.ok((await call(["stats"])).totalBytes > 0);
  assert.equal((await call(["cleanup"])).actions.length, 0);
  assert.ok(existsSync(journal.path));
  const usage = readFileSync(join(runtime, "logs", "cli-usage.jsonl"), "utf8");
  assert.ok(usage.includes('"command":"run-log read"'));
  assert.ok(!usage.includes("visible"));
});
