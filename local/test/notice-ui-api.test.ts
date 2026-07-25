import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  inspectNoticeView,
  noticeCenterView
} from "../src/application/notice/query.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { startUiServer } from "../src/entrypoints/console/launcher.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("Notice Console API reuses application views and guards durable controls", async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const runtimeDirectory = mkdtempSync(
    join(tmpdir(), "rollerskate-notice-ui-runtime-")
  );
  const databasePath = runtimePaths(repoRoot, runtimeDirectory).database;
  const controller = new AbortController();
  try {
    initializeRuntimeSchema(databasePath);
    const runtime = new RuntimeStore(databasePath);
    const destination = runtime.putDestination({
      kind: "macos-notification",
      address: { title: "Console Notice", subscriptionId: "sub_console" },
      at: "2026-07-25T03:00:00.000Z"
    });
    runtime.appendEvent({
      type: "agent.request",
      source: { kind: "cli", externalId: "notice-ui-api" },
      agentId: "agent-notice",
      prompt: "produce console notice",
      destinationIds: [destination.destinationId],
      createdAt: "2026-07-25T03:00:01.000Z"
    });
    const agentExecution = runtime.claimDueExecutions(
      1,
      "2026-07-25T03:00:02.000Z"
    )[0]!;
    runtime.completeExecution(agentExecution.executionId, {
      adapterId: "notice-fixture",
      workspace: repoRoot,
      providerSessionId: "provider-notice-ui",
      output: "Console result"
    }, "2026-07-25T03:00:03.000Z");
    const resultExecution = runtime.claimDueExecutions(
      1,
      "2026-07-25T03:00:04.000Z"
    )[0]!;
    const delivery = runtime.completeResultExecution(
      resultExecution.executionId,
      "2026-07-25T03:00:05.000Z"
    )[0]!;
    runtime.close();
    const noticeId = `ntc1_${delivery.deliveryId}`;

    const server = await startUiServer({
      repoRoot,
      runtimeDirectory,
      port: 0,
      signal: controller.signal
    });
    try {
      const origin = new URL(server.url).origin;
      const centerResponse = await fetch(`${origin}/api/notices`);
      assert.equal(centerResponse.status, 200);
      assert.deepEqual(
        await centerResponse.json(),
        noticeCenterView(repoRoot, runtimeDirectory)
      );

      const detailResponse = await fetch(
        `${origin}/api/notices/${encodeURIComponent(noticeId)}`
      );
      assert.equal(detailResponse.status, 200);
      assert.deepEqual(
        await detailResponse.json(),
        inspectNoticeView(repoRoot, noticeId, runtimeDirectory)
      );

      const rejected = await fetch(
        `${origin}/api/notices/${encodeURIComponent(noticeId)}/mark-read`,
        { method: "POST" }
      );
      assert.equal(rejected.status, 403);

      const read = await fetch(
        `${origin}/api/notices/${encodeURIComponent(noticeId)}/mark-read`,
        {
          method: "POST",
          headers: { "X-Rollerskate-Request": "console" }
        }
      );
      assert.equal(read.status, 200);
      const readView = await read.json() as {
        summary: { readAt: string | null; acknowledgedAt: string | null };
      };
      assert.ok(readView.summary.readAt);
      assert.equal(readView.summary.acknowledgedAt, null);

      const acknowledged = await fetch(
        `${origin}/api/notices/${encodeURIComponent(noticeId)}/ack`,
        {
          method: "POST",
          headers: { "X-Rollerskate-Request": "console" }
        }
      );
      assert.equal(acknowledged.status, 200);
      assert.ok((await acknowledged.json() as {
        summary: { acknowledgedAt: string | null };
      }).summary.acknowledgedAt);

      const rejectedRebuild = await fetch(`${origin}/api/notices/rebuild`, {
        method: "POST"
      });
      assert.equal(rejectedRebuild.status, 403);
      const rebuilt = await fetch(`${origin}/api/notices/rebuild`, {
        method: "POST",
        headers: { "X-Rollerskate-Request": "console" }
      });
      assert.equal(rebuilt.status, 200);
      assert.deepEqual(await rebuilt.json(), {
        projected: 1,
        preservedStates: 1
      });
      const after = await fetch(`${origin}/api/notices`);
      const afterView = await after.json() as {
        counts: { unread: number; unacknowledged: number };
      };
      assert.deepEqual(afterView.counts, {
        total: 1,
        unread: 0,
        unacknowledged: 0
      });
    } finally {
      controller.abort();
      await server.close();
    }
  } finally {
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});
