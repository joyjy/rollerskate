import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RuntimeStore } from "../src/core/runtime/store.js";
import { localId } from "../src/core/id.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { bootstrapLocalFoundation, LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { withImmediateTransaction } from "../src/infrastructure/sqlite/transaction.js";
import { DeterministicApplicationActionRegistry } from "../src/application/proactive/action-registry.js";
import {
  codexDesktopReminderAction,
  codexDesktopReminderActionSource,
  reminderAdmission
} from "../src/application/proactive/desktop-reminder-action.js";
import { codexDesktopPushAction } from "../src/application/proactive/codex-desktop-action.js";
import { registerCodexDesktopReminderSchedule } from "../src/application/proactive/desktop-reminder-registration.js";

const THREAD = "01a08e63-109a-7452-9d23-f9fa9f236343";

test("Owner registers a paused idempotent reminder and expired admission cannot create Delivery", () => {
  const root = mkdtempSync(join(tmpdir(), "rs-desktop-reminder-"));
  const paths = runtimePaths(root, root);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths);
  const database = openRuntimeDatabase(paths.database);
  try {
    new LocalFoundationStore(database, { migrate: false }).addAgent("reminder-owner", "codex", "2026-10-15T00:00:00Z");
    const actions = new DeterministicApplicationActionRegistry(database, [codexDesktopReminderAction, codexDesktopPushAction]);
    const scheduleId = localId("sch");
    const input = {
      schemaVersion: "DesktopReminderScheduleRegistration@1",
      scheduleId,
      ownerAgent: "reminder-owner",
      threadId: THREAD,
      body: "Take a break",
      expression: "2026-10-16T10:00:00Z",
      misfireGraceMilliseconds: 60_000
    };
    const registered = registerCodexDesktopReminderSchedule(root, input, root, "2026-10-15T00:00:00Z");
    assert.equal(registered.status, "registered");
    assert.equal(registered.schedule.definition.status, "paused");
    assert.equal(registered.schedule.revision.schemaVersion, "ScheduleRevision@3");
    if (registered.schedule.revision.schemaVersion !== "ScheduleRevision@3" ||
      registered.schedule.revision.target.kind !== "application_action") throw new Error("target missing");
    const expiresAt = "2026-10-17T10:00:00.000Z";
    assert.deepEqual(registered.schedule.revision.target.input, { threadId: THREAD, body: "Take a break", expiresAt });
    assert.deepEqual(reminderAdmission(registered.schedule.revision, expiresAt), {
      status: "skip", reason: "reminder-expired"
    });
    assert.equal(reminderAdmission(registered.schedule.revision, "2026-10-17T09:59:59Z"), undefined);
    assert.equal(registerCodexDesktopReminderSchedule(root, input, root, "2026-10-15T00:00:00Z").status, "duplicate");
    assert.equal(registered.schedule.definition.status, "paused");

    const target = actions.compileTarget(codexDesktopReminderAction.ref, {
      threadId: THREAD, body: "Take a break", expiresAt
    });
    const source = { kind: "schedule" as const, id: scheduleId, definitionRevision: "ScheduleRevision@3:1" };
    const receipt = withImmediateTransaction(database, () => actions.executeInTransaction({
      target, source, occurrenceKey: "once:2026-10-16T10:00:00.000Z",
      observation: { scheduledFor: "2026-10-16T10:00:00.000Z" }, at: "2026-10-16T10:00:00.000Z"
    }));
    assert.equal(receipt.status, "succeeded");
    const runtime = new RuntimeStore(database, { migrate: false });
    const delivery = runtime.claimDueDeliveries(1, "2026-10-16T10:00:00.000Z")[0]!;
    const destination = runtime.destination(delivery.destinationId)!;
    assert.equal(delivery.payload.body, "Take a break");
    const resolve = codexDesktopReminderActionSource(actions, { repoRoot: root, runtimeDirectory: root },
      () => Date.parse("2026-10-16T10:00:00Z"));
    assert.equal(resolve(
      { delivery, destination }
    )?.body, "Take a break");
    assert.throws(() => resolve({ delivery: { ...delivery, payload: { body: "tampered" } }, destination }),
      /canonical Schedule reminder receipt/);
    assert.throws(() => codexDesktopReminderActionSource(actions, { repoRoot: root, runtimeDirectory: root },
      () => Date.parse(expiresAt))({ delivery, destination }), /expired before send/);

    const pushTarget = actions.compileTarget(codexDesktopPushAction.ref, { threadId: THREAD, title: "Existing push" });
    const pushSource = { kind: "subscription" as const, id: localId("sub"), definitionRevision: "SubscriptionRevision@1" };
    withImmediateTransaction(database, () => actions.executeInTransaction({
      target: pushTarget, source: pushSource, occurrenceKey: "existing-push", observation: {},
      at: "2026-10-16T10:00:00.000Z"
    }));
    const pushDelivery = runtime.claimDueDeliveries(1, "2026-10-16T10:00:00.000Z")[0]!;
    assert.equal(codexDesktopReminderActionSource(actions, { repoRoot: root, runtimeDirectory: root })(
      { delivery: pushDelivery, destination: runtime.destination(pushDelivery.destinationId)! }
    ), undefined);

    const expiredTarget = actions.compileTarget(codexDesktopReminderAction.ref, {
      threadId: THREAD, body: "Too late", expiresAt: "2026-10-16T10:00:00Z"
    });
    const expiredReceipt = withImmediateTransaction(database, () => actions.executeInTransaction({
      target: expiredTarget,
      source: { ...source, id: localId("sch") },
      occurrenceKey: "expired",
      observation: { scheduledFor: "2026-10-16T10:00:00.000Z" },
      at: "2026-10-16T10:00:00.000Z"
    }));
    assert.equal(expiredReceipt.status, "failed");
    assert.equal(runtime.claimDueDeliveries(10, "2026-10-16T10:00:00.000Z").length, 0);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
