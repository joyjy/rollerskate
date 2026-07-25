import assert from "node:assert/strict";
import test from "node:test";

import {
  agentExecutionConfig,
  agentClients,
  runtimeAdapterId
} from "../src/modules/agent/client-profile.js";

test("Agent client catalog includes native Claude Code and Kimi Code adapters", () => {
  assert.deepEqual(agentClients, [
    "codex",
    "claude-code",
    "kimi-code"
  ]);
  assert.equal(runtimeAdapterId("claude-code"), "claude-code-runtime-json-v1");
  assert.equal(runtimeAdapterId("kimi-code"), "kimi-code-runtime-jsonl-v1");
});

test("Agent launch args preserve argv boundaries and reject adapter-owned flags", () => {
  assert.deepEqual(
    agentExecutionConfig("claude-code", ["--model", "claude-sonnet-4-6"]),
    { launchArgs: ["--model", "claude-sonnet-4-6"] }
  );
  assert.throws(
    () => agentExecutionConfig("codex", ["--sandbox=workspace-write"]),
    /controlled by the codex adapter/
  );
  assert.throws(
    () => agentExecutionConfig("claude-code", ["--permission-mode", "bypassPermissions"]),
    /controlled by the claude-code adapter/
  );
  assert.throws(
    () => agentExecutionConfig("kimi-code", ["--session=ses_foreign"]),
    /controlled by the kimi-code adapter/
  );
  assert.throws(
    () => agentExecutionConfig("kimi-code", ["bad\0argument"]),
    /must not contain NUL/
  );
});
