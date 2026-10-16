import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, fstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDaemonStderr } from "../src/entrypoints/cli/daemon-diagnostics.js";

const moduleUrl = new URL("../src/entrypoints/cli/daemon-diagnostics.js", import.meta.url).href;

async function run(mode: "throw" | "reject") {
  const root = mkdtempSync(join(tmpdir(), "rollerskate-daemon-diagnostics-"));
  const logs = join(root, "logs");
  mkdirSync(logs, {mode: 0o700});
  try {
    const stderr = openDaemonStderr(logs);
    const script = `import { installDaemonDiagnostics } from ${JSON.stringify(moduleUrl)};
      installDaemonDiagnostics();
      if (${JSON.stringify(mode)} === "throw") throw new Error("api_key=sample-secret");
      if (${JSON.stringify(mode)} === "reject") Promise.reject(new Error("rejected work"));`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "ignore", stderr.fd]
    });
    stderr.close();
    assert.throws(() => fstatSync(stderr.fd), {code: "EBADF"});
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const body = readFileSync(stderr.path, "utf8");
    const records = body.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as Record<string, unknown>);
    return {code, body, records};
  } finally { rmSync(root, {recursive: true, force: true}); }
}

test("fatal exception and rejection keep Node's nonzero exit and write private diagnostics", async () => {
  for (const mode of ["throw", "reject"] as const) {
    const result = await run(mode);
    assert.notEqual(result.code, 0);
    assert.equal(result.records[0]?.event, "daemon.uncaught_exception");
    assert.equal(result.records[1]?.event, "daemon.exit");
    assert.equal(result.records[1]?.code, 1);
    assert.equal(result.body.includes(mode === "throw" ? "api_key=sample-secret" : "rejected work"), true);
    if (mode === "throw") assert.equal(String(result.records[0]?.error).includes("sample-secret"), false);
  }
});

test("stderr open rejects symlinks and insecure existing files", () => {
  const root = mkdtempSync(join(tmpdir(), "rollerskate-daemon-stderr-open-"));
  const logs = join(root, "logs");
  mkdirSync(logs, {mode: 0o700});
  try {
    const target = join(root, "target");
    writeFileSync(target, "safe");
    symlinkSync(target, join(logs, "daemon-stderr.log"));
    assert.throws(() => openDaemonStderr(logs), {code: "ELOOP"});
    assert.equal(readFileSync(target, "utf8"), "safe");
    rmSync(join(logs, "daemon-stderr.log"));
    writeFileSync(join(logs, "daemon-stderr.log"), "existing");
    chmodSync(join(logs, "daemon-stderr.log"), 0o644);
    assert.throws(() => openDaemonStderr(logs), /private regular file/);
    assert.equal(readFileSync(join(logs, "daemon-stderr.log"), "utf8"), "existing");
  } finally { rmSync(root, {recursive: true, force: true}); }
});


test("oversized inherited diagnostic file is bounded before exit records", async () => {
  const root = mkdtempSync(join(tmpdir(), "rs-daemon-retention-"));
  try {
    const logs = join(root, "logs"); mkdirSync(logs, {mode: 0o700});
    const file = join(logs, "daemon-stderr.log");
    writeFileSync(file, "x".repeat(6 * 1024 * 1024), {mode: 0o600});
    const stderr = openDaemonStderr(logs);
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      `import {installDaemonDiagnostics} from ${JSON.stringify(moduleUrl)}; installDaemonDiagnostics({stderrPath: ${JSON.stringify(file)}});`],
      {stdio: ["ignore", "ignore", stderr.fd]});
    stderr.close();
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    });
    assert.equal(code, 0);
    const body = readFileSync(file, "utf8");
    assert.ok(body.length < 1024);
    assert.equal(JSON.parse(body).event, "daemon.exit");
  } finally { rmSync(root, {recursive: true, force: true}); }
});


test("foreground diagnostics preserve an unrelated redirected stderr file", async () => {
  const root = mkdtempSync(join(tmpdir(), "rs-foreground-stderr-"));
  try {
    const logs = join(root, "logs"); mkdirSync(logs, {mode: 0o700});
    const stderr = openDaemonStderr(logs);
    writeFileSync(stderr.path, "x".repeat(6 * 1024 * 1024));
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      `import {installDaemonDiagnostics} from ${JSON.stringify(moduleUrl)}; installDaemonDiagnostics();`],
      {stdio: ["ignore", "ignore", stderr.fd]});
    stderr.close();
    await new Promise<void>((resolve, reject) => {child.once("error", reject); child.once("close", () => resolve());});
    assert.ok(readFileSync(stderr.path).length > 6 * 1024 * 1024);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
