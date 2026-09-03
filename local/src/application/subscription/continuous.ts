import { realpathSync, statSync } from "node:fs";

import type {
  ContinuousSubscriptionDefinition,
  LegacyContinuousSubscriptionDefinition
} from "../../capabilities/subscription/continuous-model.js";
import { ContinuousSubscriptionStore } from "../../capabilities/subscription/continuous-store.js";
import type { ProactiveCallbackOccurrence } from "../../modules/callback/proactive-model.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";

export type { ContinuousSubscriptionDefinition, LegacyContinuousSubscriptionDefinition };

export interface ContinuousSubscriptionView {
  readonly kind: "continuous";
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly owner: {
    readonly agentId: string;
    readonly handle: string;
    readonly client: string;
  } | null;
  readonly definition: ContinuousSubscriptionDefinition;
  readonly probe: {
    readonly plugin: { readonly id: string; readonly path: string; readonly schemaVersion: 1 };
    readonly policy: ContinuousSubscriptionDefinition["probe"]["policy"];
  };
  readonly callbacks: readonly ProactiveCallbackOccurrence[];
  readonly callbackOccurrenceKey: string | null;
  readonly callbackSummary: {
    readonly total: number;
    readonly pending: number;
    readonly started: number;
    readonly terminal: number;
    readonly unknown: number;
  };
  readonly pollCount: number;
  readonly nextPollAt: string;
  readonly checkpointOccurrenceKey: string | null;
  readonly checkpointObservation: unknown;
  readonly pendingOccurrenceKey: string | null;
  readonly pendingObservation: unknown;
  readonly agentRunId: string | null;
  readonly pendingCycleId: string | null;
  readonly pendingAdmissionReceipt:
    ReturnType<ContinuousSubscriptionStore["require"]>["pendingAdmissionReceipt"] | null;
  readonly latestActionReceipt:
    ReturnType<ContinuousSubscriptionStore["require"]>["latestActionReceipt"] | null;
  readonly latestError: string | null;
  readonly archivedAt: string | null;
  readonly availableActions: {
    readonly archive: boolean;
    readonly unarchive: boolean;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function registerContinuousSubscription(
  repoRoot: string,
  input: LegacyContinuousSubscriptionDefinition,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): ContinuousSubscriptionView {
  const database = runtimePaths(repoRoot, runtimeDirectory).database;
  const foundation = new LocalFoundationStore(database);
  const store = new ContinuousSubscriptionStore(database);
  try {
    const owner = foundation.agent(input.ownerAgentId);
    if (owner === undefined || owner.status !== "active") {
      throw new Error(`Continuous Subscription owner is unavailable: ${input.ownerAgentId}`);
    }
    const pluginPath = realpathSync(input.probe.plugin.path);
    if (!statSync(pluginPath).isFile()) throw new Error("Continuous probe path must be a file");
    const workspace = realpathSync(input.probe.policy.workspaceRoot);
    for (const callback of input.callbacks) {
      if (callback.kind !== "agent.invoke") continue;
      const targetId = String(callback.definition.agentId);
      const target = foundation.agent(targetId);
      if (target === undefined || target.status !== "active") {
        throw new Error(`Continuous callback Agent is unavailable: ${targetId}`);
      }
      if (callback.definition.workspace !== workspace) {
        throw new Error("Continuous callback workspace must equal the probe workspace");
      }
    }
    const created = store.create({
      ...input,
      probe: {
        plugin: { ...input.probe.plugin, path: pluginPath },
        policy: {
          ...input.probe.policy,
          workspaceRoot: workspace,
          allowedHttpOrigins: input.probe.policy.allowedHttpOrigins.map((value) => {
            const origin = new URL(value).origin;
            if (origin !== value) throw new Error(`HTTP origin must be canonical: ${value}`);
            return origin;
          }),
          allowedExecutables: input.probe.policy.allowedExecutables.map((value) => {
            const executable = realpathSync(value);
            if (!statSync(executable).isFile()) throw new Error("Probe executable must be a file");
            return executable;
          }),
          allowedEnvironment: [...new Set(input.probe.policy.allowedEnvironment)]
        }
      }
    }, at);
    return view(
      created,
      owner,
      store.visibleCallbacks([created.subscriptionId]).get(created.subscriptionId) ?? []
    );
  } finally {
    store.close();
    foundation.close();
  }
}

export function listContinuousSubscriptionViews(
  repoRoot: string,
  runtimeDirectory?: string
): ContinuousSubscriptionView[] {
  return withResources(repoRoot, runtimeDirectory, ({ store, foundation }) => {
    const subscriptions = store.list(100);
    const callbacks = store.visibleCallbacks(
      subscriptions.map(({ subscriptionId }) => subscriptionId)
    );
    return subscriptions.map((subscription) => {
      const owner = continuousOwner(subscription, foundation);
      return view(
        subscription,
        owner,
        callbacks.get(subscription.subscriptionId) ?? []
      );
    });
  });
}

export function inspectContinuousSubscriptionView(
  repoRoot: string,
  subscriptionId: string,
  runtimeDirectory?: string
): ContinuousSubscriptionView | undefined {
  return withResources(repoRoot, runtimeDirectory, ({ store, foundation }) => {
    const subscription = store.get(subscriptionId);
    if (subscription === undefined) return undefined;
    const owner = continuousOwner(subscription, foundation);
    return view(
      subscription,
      owner,
      store.visibleCallbacks([subscriptionId]).get(subscriptionId) ?? []
    );
  });
}

export function inspectContinuousSubscriptionViews(
  repoRoot: string,
  subscriptionIds: readonly string[],
  runtimeDirectory?: string
): ReadonlyMap<string, ContinuousSubscriptionView> {
  if (subscriptionIds.length > 100) throw new Error("subscriptionIds exceeds 100 items");
  return withResources(repoRoot, runtimeDirectory, ({ store, foundation }) => {
    const subscriptions = subscriptionIds.flatMap((subscriptionId) => {
      const subscription = store.get(subscriptionId);
      return subscription === undefined ? [] : [subscription];
    });
    const callbacks = store.visibleCallbacks(
      subscriptions.map(({ subscriptionId }) => subscriptionId)
    );
    return new Map(subscriptions.map((subscription) => {
      const owner = continuousOwner(subscription, foundation);
      return [subscription.subscriptionId, view(
        subscription,
        owner,
        callbacks.get(subscription.subscriptionId) ?? []
      )];
    }));
  });
}

export function controlContinuousSubscriptionView(
  repoRoot: string,
  subscriptionId: string,
  action: "pause" | "resume" | "cancel",
  runtimeDirectory?: string,
  at = new Date().toISOString()
): ContinuousSubscriptionView | undefined {
  return withResources(repoRoot, runtimeDirectory, ({ store, foundation }) => {
    const current = store.get(subscriptionId);
    if (current === undefined) return undefined;
    if (action === "resume" &&
      current.definition.schemaVersion === "ContinuousSubscriptionDefinition@1") {
      throw new Error(
        "legacy_trigger_execution_closed: migrate this Continuous Subscription to a bound Run"
      );
    }
    const subscription = store.setStatus(subscriptionId, action, at);
    const owner = continuousOwner(subscription, foundation);
    return view(
      subscription,
      owner,
      store.visibleCallbacks([subscriptionId]).get(subscriptionId) ?? []
    );
  });
}

export function setContinuousSubscriptionArchivedView(
  repoRoot: string,
  subscriptionId: string,
  archived: boolean,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): ContinuousSubscriptionView | undefined {
  return withResources(repoRoot, runtimeDirectory, ({ store, foundation }) => {
    if (store.get(subscriptionId) === undefined) return undefined;
    const subscription = store.setArchived(subscriptionId, archived, at);
    const owner = continuousOwner(subscription, foundation);
    return view(
      subscription,
      owner,
      store.visibleCallbacks([subscriptionId]).get(subscriptionId) ?? []
    );
  });
}

function view(
  subscription: ReturnType<ContinuousSubscriptionStore["require"]>,
  owner: NonNullable<ReturnType<LocalFoundationStore["agent"]>> | null,
  callbacks: readonly ProactiveCallbackOccurrence[]
): ContinuousSubscriptionView {
  const visibleOccurrenceKey = subscription.pendingOccurrenceKey ??
    subscription.checkpointOccurrenceKey;
  const callbackSummary = {
    total: callbacks.length,
    pending: callbacks.filter(({ status }) => status === "pending").length,
    started: callbacks.filter(({ status }) => status === "started").length,
    terminal: callbacks.filter(({ status }) =>
      status === "succeeded" || status === "blocked" || status === "failed"
    ).length,
    unknown: callbacks.filter(({ status }) => status === "unknown").length
  };
  return {
      kind: "continuous",
      id: subscription.subscriptionId,
      title: subscription.definition.title,
      status: subscription.status,
      owner: owner === null
        ? null
        : { agentId: owner.principalId, handle: owner.handle, client: owner.client },
      definition: subscription.definition,
      probe: {
        plugin: {
          id: subscription.definition.probe.plugin.id,
          path: subscription.definition.probe.plugin.path,
          schemaVersion: 1
        },
        policy: subscription.definition.probe.policy
      },
      callbacks,
      callbackOccurrenceKey: visibleOccurrenceKey ?? null,
      callbackSummary,
      pollCount: subscription.pollCount,
      nextPollAt: subscription.nextPollAt,
      checkpointOccurrenceKey: subscription.checkpointOccurrenceKey ?? null,
      checkpointObservation: subscription.checkpointObservation ?? null,
      pendingOccurrenceKey: subscription.pendingOccurrenceKey ?? null,
      pendingObservation: subscription.pendingObservation ?? null,
      agentRunId: subscription.agentRunId ?? null,
      pendingCycleId: subscription.pendingCycleId ?? null,
      pendingAdmissionReceipt: subscription.pendingAdmissionReceipt ?? null,
      latestActionReceipt: subscription.latestActionReceipt ?? null,
      latestError: subscription.latestError ?? null,
      archivedAt: subscription.archivedAt ?? null,
      availableActions: {
        archive: subscription.status === "cancelled" && subscription.archivedAt === undefined,
        unarchive: subscription.archivedAt !== undefined
      },
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt
  };
}

function continuousOwner(
  subscription: ReturnType<ContinuousSubscriptionStore["require"]>,
  foundation: LocalFoundationStore
): NonNullable<ReturnType<LocalFoundationStore["agent"]>> | null {
  return subscription.definition.schemaVersion === "ContinuousSubscriptionDefinition@1"
    ? foundation.agent(subscription.definition.ownerAgentId) ?? null
    : null;
}

function withResources<T>(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  callback: (resources: {
    readonly store: ContinuousSubscriptionStore;
    readonly foundation: LocalFoundationStore;
  }) => T
): T {
  const database = runtimePaths(repoRoot, runtimeDirectory).database;
  const store = new ContinuousSubscriptionStore(database);
  const foundation = new LocalFoundationStore(database);
  try {
    return callback({ store, foundation });
  } finally {
    foundation.close();
    store.close();
  }
}
