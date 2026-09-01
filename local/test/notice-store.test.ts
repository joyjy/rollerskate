import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { listRuntimeFailures } from "../src/application/runtime/failure-query.js";
import { inspectNoticeView, noticeCenterView } from "../src/application/notice/query.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { NoticeStore } from "../src/infrastructure/sqlite/notice-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("Notice projection follows Delivery changes and keeps durable user state across rebuild", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-notice-store-repo-"));
  const runtimeDirectory = mkdtempSync(
    join(tmpdir(), "rollerskate-notice-store-runtime-")
  );
  const databasePath = runtimePaths(repo, runtimeDirectory).database;
  try {
    initializeRuntimeSchema(databasePath);
    const runtime = new RuntimeStore(databasePath);
    const destination = runtime.putDestination({
      kind: "macos-notification",
      address: {
        title: "  Pipeline complete  ",
        subscriptionId: "sub_notice_fixture"
      },
      at: "2026-07-25T01:00:00.000Z"
    });
    const deliveryId = createDelivery(
      runtime,
      destination.destinationId,
      "notice output",
      "2026-07-25T01:00:01.000Z"
    );

    const notices = new NoticeStore(databasePath);
    try {
      const pending = notices.require(`ntc1_${deliveryId}`);
      assert.equal(pending.title, "Pipeline complete");
      assert.equal(pending.deliveryStatus, "pending");
      assert.equal(pending.subscriptionId, "sub_notice_fixture");
      assert.deepEqual(notices.counts(), {
        total: 1,
        unread: 1,
        unacknowledged: 1
      });

      runtime.claimDueDeliveries(1, "2026-07-25T01:00:05.000Z");
      runtime.deliverySucceeded(
        deliveryId,
        "macos-notification:test",
        "2026-07-25T01:00:06.000Z"
      );
      assert.equal(notices.require(`ntc1_${deliveryId}`).deliveryStatus, "delivered");

      runtime.putDestination({
        destinationId: destination.destinationId,
        kind: "macos-notification",
        address: { title: "Renamed result" },
        at: "2026-07-25T01:00:07.000Z"
      });
      assert.equal(
        notices.require(`ntc1_${deliveryId}`).title,
        "Pipeline complete",
        "Delivery keeps the Destination snapshot captured at Event admission"
      );

      const read = notices.markRead(
        `ntc1_${deliveryId}`,
        "2026-07-25T01:00:08.000Z"
      );
      assert.equal(read.readAt, "2026-07-25T01:00:08.000Z");
      assert.equal(
        notices.markRead(
          `ntc1_${deliveryId}`,
          "2026-07-25T01:00:09.000Z"
        ).readAt,
        "2026-07-25T01:00:08.000Z"
      );
      const acknowledged = notices.acknowledge(
        `ntc1_${deliveryId}`,
        "2026-07-25T01:00:10.000Z"
      );
      assert.equal(acknowledged.readAt, "2026-07-25T01:00:08.000Z");
      assert.equal(acknowledged.acknowledgedAt, "2026-07-25T01:00:10.000Z");

      assert.deepEqual(notices.rebuildIndex(), {
        projected: 1,
        preservedStates: 1
      });
      const rebuilt = notices.require(`ntc1_${deliveryId}`);
      assert.equal(rebuilt.title, "Pipeline complete");
      assert.equal(rebuilt.readAt, "2026-07-25T01:00:08.000Z");
      assert.equal(rebuilt.acknowledgedAt, "2026-07-25T01:00:10.000Z");
      assert.deepEqual(notices.counts(), {
        total: 1,
        unread: 0,
        unacknowledged: 0
      });
    } finally {
      notices.close();
      runtime.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("failed Delivery Notice and Runtime Failure reference each other", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-notice-failure-repo-"));
  const runtimeDirectory = mkdtempSync(
    join(tmpdir(), "rollerskate-notice-failure-runtime-")
  );
  const databasePath = runtimePaths(repo, runtimeDirectory).database;
  try {
    initializeRuntimeSchema(databasePath);
    const runtime = new RuntimeStore(databasePath);
    const destination = runtime.putDestination({
      kind: "macos-notification",
      address: { title: "Failed result" },
      at: "2026-07-25T02:00:00.000Z"
    });
    const deliveryId = createDelivery(
      runtime,
      destination.destinationId,
      "failed output",
      "2026-07-25T02:00:01.000Z"
    );
    runtime.claimDueDeliveries(1, "2026-07-25T02:00:05.000Z");
    runtime.deliveryFailed(
      deliveryId,
      "Notification Center unavailable",
      "2026-07-25T02:00:06.000Z"
    );
    runtime.close();

    const noticeId = `ntc1_${deliveryId}`;
    const notice = inspectNoticeView(repo, noticeId, runtimeDirectory);
    assert.deepEqual(notice.summary.failure, {
      failureRef: `failure:delivery:${deliveryId}`,
      consoleRoute:
        `/console/runtime?failureRef=${encodeURIComponent(
          `failure:delivery:${deliveryId}`
        )}`
    });
    const failure = listRuntimeFailures(repo, runtimeDirectory)
      .find((candidate) => candidate.failureRef === `failure:delivery:${deliveryId}`);
    assert.equal(failure?.owner, "notice");
    assert.equal(
      failure?.action.consoleRoute,
      `/console/runtime?noticeId=${encodeURIComponent(noticeId)}`
    );
    assert.equal(
      failure?.action.cliHint,
      `scripts/rs failure retry failure:delivery:${deliveryId}`
    );

    const center = noticeCenterView(repo, runtimeDirectory);
    assert.equal(center.notices[0]?.noticeId, noticeId);
    assert.equal(center.notices[0]?.deliveryStatus, "failed");
    assert.equal(center.notices[0]?.statusReason, "Notification Center unavailable");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("Notice triggers project only the changed Delivery snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-notice-trigger-"));
  const databasePath = join(directory, "runtime.db");
  try {
    initializeRuntimeSchema(databasePath);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const triggers = database.prepare(`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'trigger' AND name LIKE 'notice_project_%'
      `).all() as unknown as Array<{ name: string; sql: string }>;
      const byName = new Map(triggers.map((trigger) => [trigger.name, trigger.sql]));
      assert.match(
        byName.get("notice_project_delivery_insert") ?? "",
        /delivery\.delivery_id = NEW\.delivery_id/u
      );
      assert.match(
        byName.get("notice_project_delivery_update") ?? "",
        /delivery\.delivery_id = NEW\.delivery_id/u
      );
      assert.equal(byName.has("notice_project_destination_update"), false);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDelivery(
  runtime: RuntimeStore,
  destinationId: string,
  output: string,
  at: string
): string {
  runtime.appendEvent({
    type: "agent.request",
    source: { kind: "cli", externalId: "notice-store-test" },
    agentId: "agent-notice",
    prompt: "produce a Notice",
    destinationIds: [destinationId],
    createdAt: at
  });
  const agentExecution = runtime.claimDueExecutions(1, at)[0]!;
  runtime.completeExecution(agentExecution.executionId, {
    adapterId: "notice-fixture",
    workspace: "/fixture",
    providerSessionId: `provider-${destinationId}`,
    output
  }, at);
  const resultExecution = runtime.claimDueExecutions(1, at)[0]!;
  return runtime.completeResultExecution(resultExecution.executionId, at)[0]!.deliveryId;
}
