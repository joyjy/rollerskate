import { join } from "node:path";

import { runtimeId } from "../../core/runtime/model.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { canonicalOnceExpression } from "../../capabilities/scheduled-task/time.js";
import type { CodexPushSourceResolver } from "../../integrations/codex-desktop/push.js";
import { deterministicActionReceiptId } from "../../modules/proactive/target.js";
import type { ScheduleRevision } from "../../capabilities/scheduled-task/model.js";
import { contractRecord, contractText, exactContractKeys, stableContractJson } from "../../modules/steward/contract-codec.js";
import type { DeterministicApplicationActionRegistry, DeterministicApplicationActionRegistration } from "./action-registry.js";

export const CODEX_DESKTOP_REMINDER_ACTION = "action:codex-desktop.reminder@1";
const DEFAULT_REMINDER_LIFETIME_MS = 24 * 60 * 60 * 1_000;

export interface CodexDesktopReminderInput {
  readonly threadId: string;
  readonly body: string;
  readonly expiresAt: string;
}

export function parseCodexDesktopReminderInput(value: unknown): CodexDesktopReminderInput {
  const input = contractRecord(value, "Desktop reminder input");
  exactContractKeys(input, ["threadId", "body", "expiresAt"], "Desktop reminder input");
  const threadId = contractText(input.threadId, "threadId", 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(threadId)) {
    throw new Error("Codex Desktop target requires an exact lowercase task UUID");
  }
  const body = contractText(input.body, "body", 12_000);
  const expiresAt = strictIso(input.expiresAt, "expiresAt");
  return { threadId, body, expiresAt };
}

/** Admission gate hook: undefined means this action is still eligible. */
export function reminderAdmission(
  revision: ScheduleRevision,
  at: string
): { readonly status: "skip"; readonly reason: "reminder-expired" } | undefined {
  if (revision.schemaVersion !== "ScheduleRevision@3" || revision.target.kind !== "application_action" ||
    revision.target.actionRef !== CODEX_DESKTOP_REMINDER_ACTION) return undefined;
  const { expiresAt } = parseCodexDesktopReminderInput(revision.target.input);
  return Date.parse(strictIso(at, "at")) >= Date.parse(expiresAt)
    ? { status: "skip", reason: "reminder-expired" }
    : undefined;
}

/** Source transaction owns admission and the outbox; only Delivery performs IPC. */
export const codexDesktopReminderAction: DeterministicApplicationActionRegistration = {
  ref: CODEX_DESKTOP_REMINDER_ACTION,
  inputSchema: "CodexDesktopReminderInput@1",
  parseInput: parseCodexDesktopReminderInput,
  executeInTransaction({ database, source, occurrenceKey, actionInput, at }) {
    if (source.kind !== "schedule") throw new Error("Desktop reminder action requires a Schedule source");
    const reminder = parseCodexDesktopReminderInput(actionInput);
    if (Date.parse(strictIso(at, "at")) >= Date.parse(reminder.expiresAt)) {
      throw new Error("Desktop reminder expired before Delivery admission");
    }
    const destinationId = runtimeId("dst");
    const runtime = new RuntimeStore(database, { migrate: false });
    const delivery = runtime.enqueueHostDeliveryInTransaction({
      originId: deterministicActionReceiptId({ source, occurrenceKey }),
      destinationId,
      kind: "codex-desktop",
      address: { threadId: reminder.threadId },
      payload: { body: reminder.body },
      maxAttempts: 1,
      at
    });
    return {
      status: "succeeded",
      summary: "Desktop reminder Delivery enqueued; acceptance is recorded on Delivery",
      output: { deliveryId: delivery.deliveryId, destinationId, ...reminder }
    };
  }
};

export function codexDesktopReminderActionSource(
  actions: DeterministicApplicationActionRegistry,
  location: { readonly repoRoot: string; readonly runtimeDirectory: string },
  clock: () => number = Date.now
): CodexPushSourceResolver {
  return ({ delivery, destination }) => {
    const receipt = actions.receiptById(delivery.origin.id);
    if (receipt === undefined) return undefined;
    if (receipt.actionRef !== CODEX_DESKTOP_REMINDER_ACTION) return undefined;
    const output = contractRecord(receipt.output, "Desktop reminder receipt output");
    exactContractKeys(output, ["deliveryId", "destinationId", "threadId", "body", "expiresAt"],
      "Desktop reminder receipt output");
    const reminder = parseCodexDesktopReminderInput({
      threadId: output.threadId,
      body: output.body,
      expiresAt: output.expiresAt
    });
    if (receipt.status !== "succeeded" || receipt.source.kind !== "schedule" || delivery.origin.kind !== "host" ||
      receipt.receiptId !== deterministicActionReceiptId({ source: receipt.source, occurrenceKey: receipt.occurrenceKey }) ||
      output.deliveryId !== delivery.deliveryId || output.destinationId !== destination.destinationId ||
      delivery.destinationId !== destination.destinationId || destination.kind !== "codex-desktop" ||
      stableContractJson(destination.address) !== stableContractJson({ threadId: reminder.threadId }) ||
      stableContractJson(delivery.payload) !== stableContractJson({ body: reminder.body })) {
      throw new Error("Codex Desktop Delivery differs from the canonical Schedule reminder receipt");
    }
    if (clock() >= Date.parse(reminder.expiresAt)) {
      throw new Error("Codex Desktop reminder expired before send");
    }
    const quote = (value: string) => "'" + value.replace(/'/gu, "'\\''") + "'";
    const read = [join(location.repoRoot, "scripts/rs"), "--runtime", location.runtimeDirectory,
      "schedule", "runs", receipt.source.id].map(quote).join(" ");
    return {
      body: reminder.body,
      source: {
        kind: "rs-scheduled-reminder",
        scheduleId: receipt.source.id,
        definitionRevision: receipt.source.definitionRevision,
        occurrenceKey: receipt.occurrenceKey,
        actionReceiptId: receipt.receiptId,
        expiresAt: reminder.expiresAt,
        read
      }
    };
  };
}

function strictIso(value: unknown, field: string): string {
  const timestamp = contractText(value, field, 64);
  try {
    return canonicalOnceExpression(timestamp);
  } catch {
    throw new Error(`${field} must be RFC3339`);
  }
}

export function defaultReminderExpiry(scheduledFor: string): string {
  return new Date(Date.parse(strictIso(scheduledFor, "scheduledFor")) + DEFAULT_REMINDER_LIFETIME_MS).toISOString();
}
