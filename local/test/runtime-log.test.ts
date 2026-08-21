import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import test from "node:test";

import { createRuntimeLogStream } from "../src/infrastructure/runtime/log-stream.js";

test("Runtime log rotates by size and keeps a bounded private history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-runtime-log-"));
  const logPath = join(directory, "daemon.log");
  try {
    const stream = createRuntimeLogStream(logPath, { size: "1K", rotate: 2 });
    for (let index = 0; index < 5; index += 1) {
      stream.write(`${index}:${"x".repeat(1_100)}\n`);
    }
    stream.end();
    await finished(stream);

    assert.deepEqual(
      readdirSync(directory).sort(),
      ["daemon.log", "daemon.log.1", "daemon.log.2"]
    );
    for (const filename of readdirSync(directory)) {
      assert.equal(statSync(join(directory, filename)).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
