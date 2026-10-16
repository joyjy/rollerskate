import { ScheduledTaskStore } from "../../capabilities/scheduled-task/store.js";
import { requireScheduleId } from "../../capabilities/scheduled-task/model.js";
import { canonicalOnceExpression } from "../../capabilities/scheduled-task/time.js";
import { ContinuousSubscriptionStore } from "../../capabilities/subscription/continuous-store.js";
import { SubscriptionStore } from "../../capabilities/subscription/store.js";
import { DeterministicApplicationActionRegistry } from "./action-registry.js";
import { codexDesktopReminderAction, defaultReminderExpiry, parseCodexDesktopReminderInput } from "./desktop-reminder-action.js";
import { OwnerProactiveSourceCompiler } from "./source-compiler.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { withImmediateTransaction } from "../../infrastructure/sqlite/transaction.js";
import { contractInteger, contractRecord, contractText, exactContractKeys } from "../../modules/steward/contract-codec.js";

/** Owner admission for a fixed-text one-shot Desktop reminder. New registrations start paused. */
export function registerCodexDesktopReminderSchedule(
  repoRoot: string,
  value: unknown,
  runtimeDirectory?: string,
  at = new Date().toISOString()
) {
  const input = contractRecord(value, "Desktop reminder registration");
  exactContractKeys(input, ["schemaVersion", "scheduleId", "ownerAgent", "threadId", "body", "expression",
    "misfireGraceMilliseconds", "expiresAt"], "Desktop reminder registration", ["expiresAt"]);
  if (input.schemaVersion !== "DesktopReminderScheduleRegistration@1") {
    throw new Error("DesktopReminderScheduleRegistration@1 required");
  }
  const scheduleId = requireScheduleId(contractText(input.scheduleId, "scheduleId", 256));
  const expression = contractText(input.expression, "expression", 64);
  const scheduledFor = canonicalOnceExpression(expression);
  const actionInput = parseCodexDesktopReminderInput({
    threadId: input.threadId,
    body: input.body,
    expiresAt: input.expiresAt === undefined ? defaultReminderExpiry(scheduledFor) : input.expiresAt
  });
  if (Date.parse(actionInput.expiresAt) <= Date.parse(scheduledFor)) {
    throw new Error("expiresAt must be later than the scheduled reminder time");
  }
  const misfireGraceMilliseconds = contractInteger(input.misfireGraceMilliseconds,
    "misfireGraceMilliseconds", 0, 604_800_000);
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const database = openRuntimeDatabase(paths.database);
  try {
    const foundation = new LocalFoundationStore(database, { migrate: false });
    const schedules = new ScheduledTaskStore(database, { migrate: false });
    const actions = new DeterministicApplicationActionRegistry(database, [codexDesktopReminderAction]);
    const compiler = new OwnerProactiveSourceCompiler({
      database,
      actions,
      schedules,
      oneShot: new SubscriptionStore(database, { migrate: false }),
      continuous: new ContinuousSubscriptionStore(database, { migrate: false })
    });
    return withImmediateTransaction(database, () => {
      const owner = foundation.agentByHandle(contractText(input.ownerAgent, "ownerAgent", 128));
      if (owner === undefined || owner.status !== "active") throw new Error("Reminder owner Agent must be active");
      const existing = schedules.get(scheduleId);
      if (existing !== undefined && existing.definition.ownerPrincipalId !== owner.principalId) {
        throw new Error("Schedule ID is already bound to another owner");
      }
      const compiled = compiler.compileInTransaction({
        kind: "schedule",
        source: {
          scheduleId,
          ownerPrincipalId: owner.principalId,
          kind: "once",
          expression: scheduledFor,
          misfirePolicy: "run_once",
          overlapPolicy: "skip",
          misfireGraceMilliseconds
        },
        action: { actionRef: codexDesktopReminderAction.ref, input: actionInput }
      }, at);
      if (compiled.kind !== "schedule") throw new Error("Desktop reminder registration did not compile a Schedule");
      const schedule = compiled.source;
      return {
        status: existing === undefined ? "registered" : "duplicate",
        schedule: existing === undefined ? schedules.setStatus(scheduleId, "pause", at) : schedule
      };
    });
  } finally {
    database.close();
  }
}
