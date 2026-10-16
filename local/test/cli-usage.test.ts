import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runLocalAppWithUsage } from "../src/entrypoints/cli/main.js";
import {
  appendCliUsage,
  registeredUsageCommands,
  renderCliUsage,
  resolveUsageCommand
} from "../src/application/runtime/cli-usage.js";

test("CLI usage logs only whitelisted command names and reports zero-call commands", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-cli-usage-"));
  try {
    assert.equal(resolveUsageCommand(["schedule", "run-now", "private-id", "--request-id", "secret"]), "schedule run-now");
    appendCliUsage(directory, {
      command: "schedule run-now",
      at: "2026-10-15T00:00:00.000Z",
      durationMilliseconds: 12,
      exitCode: 0,
      source: "unknown",
      args: ["private-id", "secret"]
    } as Parameters<typeof appendCliUsage>[1]);
    const log = readFileSync(join(directory, "logs", "cli-usage.jsonl"), "utf8");
    assert.deepEqual(Object.keys(JSON.parse(log)), [
      "command", "at", "durationMilliseconds", "exitCode", "source"
    ]);
    assert.equal(log.includes("private-id"), false);
    assert.equal(log.includes("secret"), false);
    const summary = JSON.parse(renderCliUsage(directory, new Date("2026-10-15T00:01:00.000Z")));
    const schedule = summary.groups.find((group: { command: string }) => group.command === "schedule");
    assert.ok(schedule);
    assert.equal(schedule.calls, 1);
    assert.equal(schedule.children.find((item: { command: string }) => item.command === "list").calls, 0);
    assert.equal(summary.window.days, 30);
    assert.equal(summary.source, "unknown");
    assert.match(summary.coverage, /background Runtime work/);
    assert.ok(registeredUsageCommands().includes("schedule list"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI usage logging failure does not escape to the command", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-cli-usage-failure-"));
  try {
    const blocker = join(directory, "not-a-directory");
    writeFileSync(blocker, "file");
    assert.doesNotThrow(() => appendCliUsage(blocker, {
      command: "schedule list",
      at: "2026-10-15T00:00:00.000Z",
      durationMilliseconds: 0,
      exitCode: 1,
      source: "unknown"
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("main CLI wrapper preserves help output and exit code while recording the command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-cli-main-usage-"));
  try {
    let output = "";
    const exitCode = await runLocalAppWithUsage(
      directory,
      ["--runtime", join(directory, "runtime"), "--help"],
      {},
      { write: (text) => { output += text; } }
    );
    assert.equal(exitCode, 0);
    assert.match(output, /scripts\/rs usage/);
    const log = readFileSync(join(directory, "runtime", "logs", "cli-usage.jsonl"), "utf8");
    assert.equal(JSON.parse(log).command, "--help");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
