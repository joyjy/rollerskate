import { chatCallbackAction, parseChatCallbackInput, chatReturnState } from "../chat/callback.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { SubscriptionStore } from "../../capabilities/subscription/store.js";
import { ContinuousSubscriptionStore } from "../../capabilities/subscription/continuous-store.js";
import { ScheduledTaskStore } from "../../capabilities/scheduled-task/store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabase } from "../../infrastructure/sqlite/database.js";
import { assertCurrentLocalSchema } from "../../infrastructure/sqlite/schema/index.js";
import { contractRecord, exactContractKeys } from "../../modules/steward/contract-codec.js";
import { OwnerProactiveSourceCompiler } from "../proactive/source-compiler.js";
import { DeterministicApplicationActionRegistry, type DeterministicApplicationActionRegistration } from "../proactive/action-registry.js";
import { CODEX_DESKTOP_PUSH_ACTION, codexDesktopPushAction } from "../proactive/codex-desktop-action.js";
import { registeredSubscriptionProbe, type RegisteredSubscriptionPlugin } from "./plugin-registry.js";
import { inspectSubscriptionView } from "./query.js";

/** Terminal source fact without delivery; it is not a second Run lifecycle. */
export const observeOnlyAction: DeterministicApplicationActionRegistration = {
  ref: "action:subscription.observe@1", inputSchema: "ObserveOnlyInput@1",
  parseInput(value) { const input = contractRecord(value, "observe input"); exactContractKeys(input, [], "observe input"); return {}; },
  executeInTransaction() { return { status: "succeeded", summary: "Observation recorded; no result destination requested" }; }
};

export interface ObservationSourceInput {
  readonly subscriptionId: string;
  readonly title: string;
  readonly mode: "until" | "continuous";
  readonly threadId?: string;
  readonly chatDispatchEventId?: string;
  readonly plugin: RegisteredSubscriptionPlugin;
  readonly pluginConfig: unknown;
  readonly intervalMilliseconds: number;
  readonly maxWaitMilliseconds?: number;
  readonly maxAttempts?: number;
  readonly checkpointMilliseconds?: number;
}

/** Internal composition only: callers cannot supply new probe authority or action code. */
export function registerObservationSource(repoRoot: string, input: ObservationSourceInput, runtimeDirectory?: string) {
  const database = openRuntimeDatabase(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    assertCurrentLocalSchema(database);
    const actions = new DeterministicApplicationActionRegistry(database, [codexDesktopPushAction, chatCallbackAction, observeOnlyAction]);
    const compiler = new OwnerProactiveSourceCompiler({ database, actions,
      schedules: new ScheduledTaskStore(database, { migrate: false }),
      oneShot: new SubscriptionStore(database, { migrate: false }),
      continuous: new ContinuousSubscriptionStore(database, { migrate: false }) });
    if (input.threadId && input.chatDispatchEventId) throw new Error("Only one result destination is allowed");
    if (input.chatDispatchEventId) {
      parseChatCallbackInput({dispatchEventId: input.chatDispatchEventId, title: input.title});
      const state = chatReturnState(database, new RuntimeStore(database, {migrate: false}), input.chatDispatchEventId);
      if (state.status === "blocked") throw new Error(`Chat callback target unavailable: ${state.reason}`);
    }
    const action = input.chatDispatchEventId ? {actionRef: chatCallbackAction.ref, input: {dispatchEventId: input.chatDispatchEventId, title: input.title}}
      : input.threadId === undefined ? { actionRef: observeOnlyAction.ref, input: {} }
      : { actionRef: CODEX_DESKTOP_PUSH_ACTION, input: { threadId: input.threadId, title: input.title } };
    const probe = registeredSubscriptionProbe(input.plugin, input.pluginConfig);
    if (input.mode === "continuous") compiler.compile({ kind: "continuous_subscription", action, source: {
      schemaVersion: "ContinuousSubscriptionDefinition@3", revision: 1, subscriptionId: input.subscriptionId,
      title: input.title, probe, intervalMilliseconds: input.intervalMilliseconds
    } });
    else compiler.compile({ kind: "subscription", action, source: {
      schemaVersion: "SubscriptionDefinition@5", revision: "1", subscriptionId: input.subscriptionId, title: input.title,
      probe: { ...probe, artifactRevision: input.plugin.artifactRevision, artifactDigest: input.plugin.artifactDigest },
      intervalMilliseconds: input.intervalMilliseconds, maxWaitMilliseconds: input.maxWaitMilliseconds!, maxAttempts: input.maxAttempts!,
      ...(input.checkpointMilliseconds === undefined ? {} : {checkpointMilliseconds: input.checkpointMilliseconds})
    } });
  } finally { database.close(); }
  return inspectSubscriptionView(repoRoot, input.subscriptionId, runtimeDirectory);
}
