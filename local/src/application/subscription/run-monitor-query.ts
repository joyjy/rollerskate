import { RunMonitorStore, requireRunSubscriptionId } from
  "../../capabilities/subscription/run-monitor-store.js";
import { AgentRunStore } from "../../infrastructure/sqlite/agent-run-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { assertCurrentLocalSchema } from "../../infrastructure/sqlite/schema/index.js";
import { RuntimeStore } from "../../core/runtime/store.js";

const RUN_SUBSCRIPTION_DELIVERY_PREFIX = "run-subscription:";
const CHAT_ACTIVATION_PREFIX = "chat-activation:run-subscription:";
const LEGACY_RUN_DELIVERY_PREFIX = "steward-run:";

export function listRunMonitors(repoRoot: string, runtimeDirectory?: string) {
  const database = openRuntimeDatabaseReadOnly(
    runtimePaths(repoRoot, runtimeDirectory).database
  );
  try {
    assertCurrentLocalSchema(database);
    const subscriptions = new RunMonitorStore(database).list(100);
    const runs = new AgentRunStore(database, { migrate: false });
    return {
      schemaVersion: "RunSubscriptionList@1" as const,
      subscriptions: subscriptions.map((subscription) => {
        const run = runs.projection(subscription.runId);
        if (run === undefined) throw new Error(`Run not found: ${subscription.runId}`);
        return {
          subscription,
          run: { runId: run.runId, status: run.status, version: run.version,
            updatedAt: run.updatedAt }
        };
      })
    };
  } finally {
    database.close();
  }
}

export function inspectRunMonitor(
  repoRoot: string,
  subscriptionId: string,
  runtimeDirectory?: string
) {
  requireRunSubscriptionId(subscriptionId);
  const database = openRuntimeDatabaseReadOnly(
    runtimePaths(repoRoot, runtimeDirectory).database
  );
  try {
    assertCurrentLocalSchema(database);
    const subscription = new RunMonitorStore(database).get(subscriptionId);
    if (subscription === undefined) {
      throw new Error(`Run Subscription not found: ${subscriptionId}`);
    }
    const run = new AgentRunStore(database, { migrate: false }).projection(subscription.runId);
    if (run === undefined) throw new Error(`Run not found: ${subscription.runId}`);
    return {
      schemaVersion: "RunSubscriptionDetail@1" as const,
      subscription,
      run: { runId: run.runId, status: run.status, version: run.version,
        updatedAt: run.updatedAt }
    };
  } finally {
    database.close();
  }
}

export function runMonitorDeliveries(
  repoRoot: string,
  subscriptionId: string,
  runtimeDirectory?: string
) {
  requireRunSubscriptionId(subscriptionId);
  const database = openRuntimeDatabaseReadOnly(
    runtimePaths(repoRoot, runtimeDirectory).database
  );
  try {
    assertCurrentLocalSchema(database);
    const subscription = new RunMonitorStore(database).get(subscriptionId);
    if (subscription === undefined) {
      throw new Error(`Run Subscription not found: ${subscriptionId}`);
    }
    const run = new AgentRunStore(database, { migrate: false }).projection(subscription.runId);
    if (run === undefined) throw new Error(`Run not found: ${subscription.runId}`);
    const runtime = new RuntimeStore(database, { migrate: false });
    const deliveryIds = database.prepare(`
      SELECT delivery_id, origin_id FROM deliveries
      WHERE origin_kind = 'host' AND (
        substr(origin_id, 1, ?) = ? OR substr(origin_id, 1, ?) = ?
      )
      ORDER BY created_at, delivery_id
    `).all(
      `${RUN_SUBSCRIPTION_DELIVERY_PREFIX}${subscriptionId}:`.length,
      `${RUN_SUBSCRIPTION_DELIVERY_PREFIX}${subscriptionId}:`,
      `${LEGACY_RUN_DELIVERY_PREFIX}${run.runId}:`.length,
      `${LEGACY_RUN_DELIVERY_PREFIX}${run.runId}:`
    ) as Array<{ delivery_id: string; origin_id: string }>;
    const deliveries = deliveryIds
      .filter(({ origin_id }) => origin_id.startsWith(
        `${RUN_SUBSCRIPTION_DELIVERY_PREFIX}${subscriptionId}:`
      ) || origin_id.endsWith(":terminal"))
      .map(({ delivery_id }) => runtime.delivery(delivery_id))
      .filter((delivery) => delivery !== undefined);

    const externalIdPrefix = `${CHAT_ACTIVATION_PREFIX}${subscriptionId}:`;
    const activationIds = database.prepare(`
      SELECT event_id FROM events
      WHERE type = 'chat.activation' AND source_kind = 'handler'
        AND substr(source_external_id, 1, ?) = ?
      ORDER BY created_at, event_id
    `).all(externalIdPrefix.length, externalIdPrefix) as Array<{ event_id: string }>;
    const chatActivations = activationIds.map(({ event_id }) => {
      const audit = runtime.audit(event_id);
      if (audit === undefined || audit.event.type !== "chat.activation" ||
        audit.execution === undefined) {
        throw new Error(`Chat activation receipt is missing: ${event_id}`);
      }
      return {
        externalId: audit.event.source.externalId,
        event: audit.event,
        execution: audit.execution
      };
    });

    return {
      schemaVersion: "RunSubscriptionDeliveries@1" as const,
      subscription,
      deliverySemantics: {
        delivered: "transport accepted",
        failure: "failed and uncertain outcomes remain recorded; Desktop delivery is not blindly retried"
      },
      deliveries,
      chatActivations
    };
  } finally {
    database.close();
  }
}
