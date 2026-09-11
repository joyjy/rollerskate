import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexAppServerRunner } from
  "../src/integrations/agent/runner/codex-app-server.js";

test("Codex separates resumed context, wire records and assistant output budgets", async (t) => {
  for (const scenario of ["large-tool", "assistant-limit", "record-limit"] as const) {
    await t.test(scenario, async (t) => {
      const workspace = mkdtempSync(join(tmpdir(), "rollerskate-codex-budget-"));
      t.after(() => rmSync(workspace, { recursive: true, force: true }));
      const executable = join(workspace, "codex-fixture");
      writeFileSync(executable, `#!${process.execPath}
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 0) send({ id: 0, result: {} });
  if (message.id === 1) {
    if (message.method !== "thread/resume" || message.params.excludeTurns !== true ||
        message.params.threadId !== "existing-thread") {
      send({ id: 1, error: { message: "Expected metadata-only resume of existing thread" } });
      return;
    }
    send({ id: 1, result: { thread: { id: "existing-thread", turns: [] } } });
  }
  if (message.id === 2) {
    send({ id: 2, result: { turn: { id: "current-turn", status: "inProgress" } } });
    const params = { threadId: "existing-thread", turnId: "current-turn" };
    if (${JSON.stringify(scenario)} === "assistant-limit") {
      send({ method: "item/agentMessage/delta", params: {
        ...params, itemId: "answer", delta: "a".repeat(1025)
      } });
    } else {
      send({ method: "item/completed", params: { ...params, item: {
        id: "tool", type: "mcpToolCall", server: "fixture", tool: "read",
        status: "completed", result: { text: "x".repeat(
          ${JSON.stringify(scenario)} === "record-limit" ? 17 * 1048576 : 2 * 1048576
        ) }
      } } });
      send({ method: "item/agentMessage/delta", params: {
        ...params, itemId: "answer", delta: "continued"
      } });
    }
    send({ method: "turn/completed", params: {
      threadId: "existing-thread", turn: { id: "current-turn", status: "completed" }
    } });
  }
});
`);
      chmodSync(executable, 0o700);
      const runner = new CodexAppServerRunner({
        adapterId: "fixture", executable, environment: {}, workingDirectory: workspace,
        meaningfulOutputTimeoutMilliseconds: 5_000,
        maxOutputBytes: 1_024,
        threadParameters: { approvalPolicy: "never", sandbox: "read-only" }
      });
      const result = runner.invoke({
        prompt: "continue", sessionId: "existing-thread", workspaceAccess: "read"
      });
      if (scenario === "assistant-limit") {
        await assert.rejects(result, /assistant output exceeds 1024 bytes/);
      } else if (scenario === "record-limit") {
        await assert.rejects(result, /protocol record exceeds 16777216 bytes/);
      } else {
        const receipt = await result;
        assert.equal(receipt.sessionId, "existing-thread");
        assert.equal(receipt.events.some((event) => event.type === "turn.completed"), true);
        assert.equal(receipt.events.some((event) => event.type === "assistant.message" &&
          event.message.text === "continued"), true);
        assert.equal(receipt.events.some((event) => event.type === "tool.observed"), true);
        assert.ok(JSON.stringify(receipt).length < 1_024);
      }
    });
  }
});
