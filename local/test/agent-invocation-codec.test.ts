import assert from "node:assert/strict";
import test from "node:test";

import type { AgentInvocationFailure } from "../src/core/runtime/agent-invocation.js";
import { normalizeAgentInvocationFailure } from "../src/core/runtime/store/codec.js";

const stallFailure = {
  schemaVersion: "AgentInvocationFailure@1",
  adapterId: "fixture-adapter",
  workspace: "/fixture/workspace",
  workspaceAccess: "read",
  providerSessionId: "fixture-session",
  startedAt: "2026-09-02T00:00:00.000Z",
  observedAt: "2026-09-02T00:05:00.000Z",
  lastMeaningfulAt: "2026-09-02T00:00:00.000Z",
  phase: "cancelling",
  updateCount: 2,
  meaningfulUpdateCount: 1,
  lastProgress: { kind: "thought" },
  failedAt: "2026-09-02T00:05:00.000Z",
  reason: "stall",
  meaningfulOutputTimeoutMilliseconds: 300_000,
  protocolStop: "requested",
  recovery: "explicit_read_only_resume"
} as AgentInvocationFailure;

test("failure codec accepts stall receipts without an absolute deadline", () => {
  const normalized = normalizeAgentInvocationFailure(stallFailure);

  assert.equal(normalized.reason, "stall");
  assert.equal(normalized.totalTimeoutMilliseconds, undefined);
});

test("failure codec requires an absolute timeout for deadline receipts", () => {
  assert.throws(
    () => normalizeAgentInvocationFailure({
      ...stallFailure,
      reason: "deadline"
    }),
    /malformed/
  );
  assert.equal(normalizeAgentInvocationFailure({
    ...stallFailure,
    reason: "deadline",
    totalTimeoutMilliseconds: 90_000
  }).totalTimeoutMilliseconds, 90_000);
});
