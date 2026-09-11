import { registerObservationSource } from "./observation-control.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { assertCurrentLocalSchema } from "../../infrastructure/sqlite/schema/index.js";
import { contractRecord, exactContractKeys, contractText, contractInteger, boundedContractValue } from "../../modules/steward/contract-codec.js";
import { CODEX_DESKTOP_PUSH_ACTION, parseCodexDesktopActionInput } from "../proactive/codex-desktop-action.js";
import { resolveRegisteredSubscriptionPlugin } from "./plugin-registry.js";
import { RuntimeStore } from "../../core/runtime/store.js";

/** Explicit Owner admission; executable and network authority only come from the plugin registry. */
export function registerDesktopSubscription(repoRoot: string, value: unknown, runtimeDirectory?: string) {
  const input = contractRecord(value, "Desktop Subscription registration");
  const continuous = input.mode === "continuous";
  exactContractKeys(input, ["schemaVersion", "subscriptionId", "title", "mode", "threadId", "pluginRef", "pluginConfig",
    "intervalMilliseconds", ...(continuous ? [] : ["maxWaitMilliseconds", "maxAttempts"])], "Desktop Subscription registration");
  if (input.schemaVersion !== "CodexDesktopSubscriptionRegistration@1" || !["until", "continuous"].includes(String(input.mode))) {
    throw new Error("CodexDesktopSubscriptionRegistration@1 with until or continuous mode required");
  }
  const subscriptionId = contractText(input.subscriptionId, "subscriptionId", 256);
  const title = contractText(input.title, "title", 120);
  const intervalMilliseconds = contractInteger(input.intervalMilliseconds, "intervalMilliseconds", 100, 86_400_000);
  const plugin = resolveRegisteredSubscriptionPlugin(repoRoot, contractText(input.pluginRef, "pluginRef", 256), runtimeDirectory);
  if (plugin === undefined || !plugin.triggerKinds.includes(continuous ? "continuous" : "until")) {
    throw new Error("Subscription plugin is not registered for the requested mode");
  }
  return registerObservationSource(repoRoot, { subscriptionId, title, mode: continuous ? "continuous" : "until",
    threadId: parseCodexDesktopActionInput({threadId: input.threadId, title}).threadId,
    plugin, pluginConfig: boundedContractValue(input.pluginConfig, "pluginConfig"), intervalMilliseconds,
    ...(continuous ? {} : { maxWaitMilliseconds: contractInteger(input.maxWaitMilliseconds, "maxWaitMilliseconds", 100, 31 * 86_400_000),
      maxAttempts: contractInteger(input.maxAttempts, "maxAttempts", 1, 100_000) })
  }, runtimeDirectory);
}

/** Delivery is the transport oracle; action success only means durable enqueue. */
export function desktopSubscriptionDeliveries(repoRoot: string, subscriptionId: string, runtimeDirectory?: string) {
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    assertCurrentLocalSchema(database);
    const rows = database.prepare(`SELECT delivery_id FROM deliveries AS delivery
      JOIN deterministic_action_receipts AS action ON action.receipt_id = delivery.origin_id
      WHERE delivery.origin_kind = 'host' AND action.source_kind IN ('subscription', 'continuous_subscription')
        AND action.source_id = ? AND action.action_ref = ?
      ORDER BY delivery.created_at DESC, delivery.delivery_id DESC LIMIT 100
    `).all(subscriptionId, CODEX_DESKTOP_PUSH_ACTION) as Array<{ delivery_id: string }>;
    const runtime = new RuntimeStore(database, { migrate: false });
    return rows.map(row => runtime.delivery(row.delivery_id)!);
  } finally { database.close(); }
}
