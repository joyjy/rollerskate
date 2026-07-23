import assert from "node:assert/strict";
import test from "node:test";

import { AgentProcessClient } from "../src/integrations/agent/process-client.js";

const fixture = new URL("./fixtures/process-agent.js", import.meta.url);

test("Agent process client uses structured IO without shell or inherited environment", async () => {
  process.env.ROLLERSKATE_TEST_SECRET = "must-not-leak";
  try {
    const agent = new AgentProcessClient({
      adapterId: "fixture-agent-v1",
      executable: process.execPath,
      args: [fixture.pathname],
      timeoutMilliseconds: 1_000
    });
    const receipt = await agent.invoke({ kind: "project.inspect" });
    assert.equal(receipt.adapterId, "fixture-agent-v1");
    assert.deepEqual(receipt.response, {
      summary: "kind=project.inspect",
      inheritedSecret: null
    });
  } finally {
    delete process.env.ROLLERSKATE_TEST_SECRET;
  }
});

test("Agent process client kills invocations that exceed the explicit timeout", async () => {
  const agent = new AgentProcessClient({
    adapterId: "fixture-timeout-v1",
    executable: process.execPath,
    args: [fixture.pathname],
    timeoutMilliseconds: 20
  });
  await assert.rejects(
    agent.invoke({ delay: 200 }),
    /agent invocation timed out/
  );
});

test("Agent process client kills invocations that exceed the output budget", async () => {
  const agent = new AgentProcessClient({
    adapterId: "fixture-output-v1",
    executable: process.execPath,
    args: [fixture.pathname],
    timeoutMilliseconds: 1_000,
    maxOutputBytes: 32
  });
  await assert.rejects(
    agent.invoke({ outputBytes: 128 }),
    /agent output exceeded 32 bytes/
  );
});

test("Agent process client rejects non-JSON requests before spawning", async () => {
  const agent = new AgentProcessClient({
    adapterId: "fixture-json-v1",
    executable: "/path/that/must/not/be/spawned",
    timeoutMilliseconds: 1_000
  });
  const circular: { self?: unknown } = {};
  circular.self = circular;
  await assert.rejects(
    agent.invoke(circular),
    /agent request is not JSON-serializable/
  );
});
