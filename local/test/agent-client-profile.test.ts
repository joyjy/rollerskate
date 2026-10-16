import assert from "node:assert/strict";
import test from "node:test";

import {
  agentExecutionConfig,
  agentClients,
  runtimeAdapterId,
  runtimeAdapterIdMatches
} from "../src/modules/agent/client-profile.js";

test("Agent client catalog includes the four public adapters", () => {
  assert.deepEqual(agentClients, [
    "codex",
    "claude-code",
    "kimi-code",
    "pi"
  ]);
  assert.equal(runtimeAdapterId("codex"), "codex-runtime-app-server-v1");
  assert.equal(runtimeAdapterId("claude-code"), "claude-code-runtime-json-v1");
  assert.equal(runtimeAdapterId("kimi-code"), "kimi-code-runtime-acp-v1");
  assert.equal(runtimeAdapterId("pi"), "pi-runtime-rpc-v1");
  assert.equal(runtimeAdapterIdMatches("pi", `pi-runtime-rpc-v1:${"a".repeat(64)}`), true);
  assert.equal(runtimeAdapterIdMatches("pi", "pi-runtime-rpc-v1"), false);
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
    () => agentExecutionConfig("kimi-code", ["--agent", "researcher"]),
    /controlled by the kimi-code adapter/
  );
  assert.throws(
    () => agentExecutionConfig("kimi-code", ["bad\0argument"]),
    /must not contain NUL/
  );
  assert.throws(
    () => agentExecutionConfig("pi", ["--mode", "rpc"]),
    /controlled by the pi adapter/
  );
  assert.throws(
    () => agentExecutionConfig("pi", ["--api-key", "sk-secret"]),
    /controlled by the pi adapter/
  );
  assert.throws(
    () => agentExecutionConfig("pi", ["--extension=/tmp/untrusted.mjs"]),
    /controlled by the pi adapter/
  );
  assert.throws(
    () => agentExecutionConfig("pi", ["--skill", "/tmp/untrusted-skill"]),
    /controlled by the pi adapter/
  );
});
