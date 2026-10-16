import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentInvocationLogMaintenance } from "../src/infrastructure/files/agent-invocation-log-maintenance.js";

const NAME = "attempt-1-00000000-0000-4000-8000-000000000001.jsonl";
const OLD = new Date("2026-09-01T00:00:00.000Z");
const NOW = new Date("2026-10-15T00:00:00.000Z");

function fixture(runId = "run-1") {
  const root = mkdtempSync(join(tmpdir(), "rollerskate-invocation-maintenance-"));
  const directory = join(root, "runs", runId, "executions", "exec-1");
  mkdirSync(directory, {recursive: true});
  const log = join(directory, NAME);
  const payload = `${log}.1.payload.json`;
  writeFileSync(log, '{"kind":"invocation.completed"}\n');
  writeFileSync(payload, '{"body":"payload"}\n');
  for (const path of [log, payload]) utimesSync(path, OLD, OLD);
  return {root, directory, log, payload, close: () => rmSync(root, {recursive: true, force: true})};
}

test("active and unknown run logs remain readable but protected", () => {
  const f = fixture();
  try {
    writeFileSync(f.log, '{"kind":"started"}\n{"kind":"partial"');
    const maintenance = new AgentInvocationLogMaintenance(f.root, {isRunTerminal: () => true});
    assert.deepEqual(maintenance.read(f.log), [{kind: "started"}]);
    assert.equal(maintenance.preview({now: NOW}).actions.length, 0);
    assert.equal(maintenance.preview({now: NOW}).protectedGroups[0]?.reason, "unsealed_invocation_log");
    assert.equal(new AgentInvocationLogMaintenance(f.root).preview({now: NOW}).protectedGroups[0]?.reason, "run_not_confirmed_terminal");
  } finally { f.close(); }
});

test("sealed log compresses and reads through logical jsonl path", () => {
  const f = fixture();
  try {
    writeFileSync(`${f.log}.sealed`, '{"schemaVersion":"AgentInvocationSeal@1"}\n', {mode: 0o600});
    utimesSync(`${f.log}.sealed`, OLD, OLD);
    const maintenance = new AgentInvocationLogMaintenance(f.root, {isRunTerminal: () => true});
    const preview = maintenance.preview({now: NOW, action: "compress"});
    assert.equal(preview.actions[0]?.kind, "compress");
    maintenance.apply(preview);
    assert.equal(existsSync(f.log), false);
    assert.equal(existsSync(`${f.log}.gz`), true);
    assert.deepEqual(maintenance.read(f.log), [{kind: "invocation.completed"}]);
    assert.equal(maintenance.list().logs[0]?.compressed, true);
    assert.equal(maintenance.list().totalBytes > 0, true);
  } finally { f.close(); }
});

test("large payload compresses, reads by logical path, and joins run cleanup", () => {
  const f = fixture();
  try {
    const payload = {body: "large repeated result ".repeat(20_000)};
    writeFileSync(f.payload, `${JSON.stringify(payload)}\n`);
    utimesSync(f.payload, OLD, OLD);
    writeFileSync(`${f.log}.sealed`, '{"schemaVersion":"AgentInvocationSeal@1"}\n');
    utimesSync(`${f.log}.sealed`, OLD, OLD);
    const maintenance = new AgentInvocationLogMaintenance(f.root, {isRunTerminal: () => true});
    const before = maintenance.list().totalBytes;
    const preview = maintenance.preview({now: NOW, action: "compress"});
    assert.equal(preview.actions.length, 2);
    maintenance.apply(preview);
    assert.equal(existsSync(f.payload), false);
    assert.equal(existsSync(`${f.payload}.gz`), true);
    assert.deepEqual(maintenance.readPayload(f.payload), payload);
    assert.equal(maintenance.list().totalBytes < before / 2, true);
    maintenance.apply(maintenance.preview({now: NOW, action: "cleanup"}));
    assert.equal(existsSync(`${f.payload}.gz`), false);
    assert.equal(existsSync(`${f.log}.gz`), false);
    assert.equal(existsSync(`${f.log}.sealed`), false);
  } finally { f.close(); }
});

test("cleanup removes whole run group and refuses a changed preview", () => {
  const f = fixture();
  try {
    writeFileSync(`${f.log}.sealed`, '{"schemaVersion":"AgentInvocationSeal@1"}\n');
    utimesSync(`${f.log}.sealed`, OLD, OLD);
    const maintenance = new AgentInvocationLogMaintenance(f.root, {isRunTerminal: () => true});
    const preview = maintenance.preview({now: NOW, action: "cleanup"});
    assert.deepEqual([...preview.actions[0]!.paths].sort(), [f.log, f.payload, `${f.log}.sealed`].sort());
    writeFileSync(f.payload, '{"body":"changed"}\n');
    assert.throws(() => maintenance.apply(preview), /stale/);
    assert.equal(existsSync(f.log), true);
    assert.equal(existsSync(f.payload), true);
    assert.equal(existsSync(join(f.root, "runs", ".maintenance.lock")), false);
    assert.deepEqual(maintenance.preview({now: NOW, action: "cleanup"}).protectedGroups, []);
  } finally { f.close(); }
});

test("cleanup removes sealed log, seal, and payload while preserving run progress", () => {
  const f = fixture();
  try {
    writeFileSync(`${f.log}.sealed`, '{"schemaVersion":"AgentInvocationSeal@1"}\n');
    utimesSync(`${f.log}.sealed`, OLD, OLD);
    const progress = join(f.root, "runs", "run-1", "progress.json");
    writeFileSync(progress, "{}");
    const maintenance = new AgentInvocationLogMaintenance(f.root, {isRunTerminal: () => true});
    maintenance.apply(maintenance.preview({now: NOW, action: "cleanup"}));
    assert.equal(existsSync(f.log), false);
    assert.equal(existsSync(f.payload), false);
    assert.equal(existsSync(`${f.log}.sealed`), false);
    assert.equal(existsSync(progress), true);
  } finally { f.close(); }
});

test("unknown symlink protects its run without following the target", () => {
  const f = fixture();
  try {
    writeFileSync(`${f.log}.sealed`, '{"schemaVersion":"AgentInvocationSeal@1"}\n');
    utimesSync(`${f.log}.sealed`, OLD, OLD);
    symlinkSync(f.log, join(f.directory, "foreign"));
    const maintenance = new AgentInvocationLogMaintenance(f.root, {isRunTerminal: () => true});
    assert.equal(maintenance.preview({now: NOW}).protectedGroups[0]?.reason, "symlink");
    assert.equal(maintenance.preview({now: NOW}).actions.length, 0);
    assert.equal(maintenance.list().complete, false);
    assert.throws(() => maintenance.read(join(f.directory, "foreign")), /Invalid/);
  } finally { f.close(); }
});

test("an unrelated live writer cannot invalidate a cold Run preview or be cleaned with it", () => {
  const f = fixture();
  try {
    writeFileSync(`${f.log}.sealed`, '{"schemaVersion":"AgentInvocationSeal@1"}\n');
    utimesSync(`${f.log}.sealed`, OLD, OLD);
    const activeDirectory = join(f.root, "runs", "run-active", "executions", "exec-active");
    mkdirSync(activeDirectory, {recursive: true});
    const activeLog = join(activeDirectory, NAME);
    writeFileSync(activeLog, '{"kind":"started"}\n');
    const maintenance = new AgentInvocationLogMaintenance(f.root, {isRunTerminal: runId => runId === "run-1"});
    const preview = maintenance.preview({now: NOW, action: "cleanup"});
    writeFileSync(activeLog, '{"kind":"started"}\n{"kind":"assistant.delta"}\n');
    maintenance.apply(preview);
    assert.equal(existsSync(f.log), false);
    assert.equal(existsSync(activeLog), true);
  } finally { f.close(); }
});
