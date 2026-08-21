import { realpathSync, statSync } from "node:fs";

import type { ContinuousSubscriptionDefinition } from "../../capabilities/subscription/continuous-model.js";
import { ContinuousSubscriptionStore } from "../../capabilities/subscription/continuous-store.js";
import type { ProactiveCallbackOccurrence } from "../../modules/callback/proactive-model.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";

export type { ContinuousSubscriptionDefinition };

export interface ContinuousSubscriptionView {
  readonly kind: "continuous";
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly owner: { readonly agentId: string; readonly handle: string; readonly client: string };
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
  readonly latestError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function registerContinuousSubscription(
  repoRoot: string,
  input: ContinuousSubscriptionDefinition,
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
      const owner = foundation.agent(subscription.definition.ownerAgentId);
      if (owner === undefined) throw new Error("Continuous Subscription owner is missing");
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
    const owner = foundation.agent(subscription.definition.ownerAgentId);
    if (owner === undefined) throw new Error("Continuous Subscription owner is missing");
    return view(
      subscription,
      owner,
      store.visibleCallbacks([subscriptionId]).get(subscriptionId) ?? []
    );
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
    if (store.get(subscriptionId) === undefined) return undefined;
    const subscription = store.setStatus(subscriptionId, action, at);
    const owner = foundation.agent(subscription.definition.ownerAgentId);
    if (owner === undefined) throw new Error("Continuous Subscription owner is missing");
    return view(
      subscription,
      owner,
      store.visibleCallbacks([subscriptionId]).get(subscriptionId) ?? []
    );
  });
}

function view(
  subscription: ReturnType<ContinuousSubscriptionStore["require"]>,
  owner: ReturnType<LocalFoundationStore["agent"]> & {},
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
      owner: { agentId: owner.principalId, handle: owner.handle, client: owner.client },
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
      latestError: subscription.latestError ?? null,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt
  };
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
