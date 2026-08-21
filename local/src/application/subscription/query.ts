import type { FreeSubscription } from "../../capabilities/subscription/model.js";
import type {
  ProactiveCallbackDefinition,
  ProactiveCallbackOccurrence
} from "../../modules/callback/proactive-model.js";
import { CallbackStore } from "../../infrastructure/callback/store.js";
import { SubscriptionStore } from "../../capabilities/subscription/store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import {
  parseSubscriptionAgentResult,
  type SubscriptionAgentResult
} from "../../capabilities/subscription/agent-result.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import type { RuntimeExecutionStatus } from "../../core/runtime/model.js";
import {
  inspectContinuousSubscriptionView,
  listContinuousSubscriptionViews,
  type ContinuousSubscriptionView
} from "./continuous.js";

export interface SubscriptionInspection {
  readonly subscription: FreeSubscription;
  readonly callbackDefinitions: readonly ProactiveCallbackDefinition[];
  readonly callbacks: readonly ProactiveCallbackOccurrence[];
  readonly owner: LocalAgent;
}

interface SubscriptionOwnerView {
  readonly agentId: string;
  readonly handle: string;
  readonly client: LocalAgent["client"];
}

interface SubscriptionProbeView {
  readonly plugin: {
    readonly id: string;
    readonly path: string;
    readonly schemaVersion: number;
  };
  readonly policy: {
    readonly allowedHttpOrigins: readonly string[];
    readonly allowedExecutables: readonly string[];
    readonly allowedEnvironment: readonly string[];
    readonly timeoutMilliseconds: number;
    readonly maxOutputBytes: number;
  };
}

interface SubscriptionScheduleView {
  readonly intervalMilliseconds: number;
  readonly maxWaitMilliseconds: number;
  readonly maxAttempts: number;
  readonly attemptCount: number;
  readonly deadlineAt: string;
  readonly nextPollAt: string;
}

export interface FreeSubscriptionView {
  readonly kind: "free";
  readonly id: string;
  readonly title: string;
  readonly status: FreeSubscription["status"];
  readonly owner: SubscriptionOwnerView;
  readonly definition: {
    readonly schema: "SubscriptionDefinition@3";
    readonly revision: string;
    readonly digest: string;
    readonly callbackPhaseStatus: FreeSubscription["callbackPhaseStatus"];
    readonly artifactRevision: string;
    readonly artifactDigest: string;
    readonly externalRefBinding: FreeSubscription["externalRefBinding"] | null;
    readonly callbacks: readonly ProactiveCallbackDefinition[];
  };
  readonly callbacks: readonly SubscriptionCallbackView[];
  readonly probe: SubscriptionProbeView;
  readonly schedule: SubscriptionScheduleView;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestError: string | null;
  readonly terminalObservation: unknown | null;
}

export interface SubscriptionCallbackView extends ProactiveCallbackOccurrence {
  readonly invocationStatus: RuntimeExecutionStatus | null;
  readonly agentResult: SubscriptionAgentResult | null;
}

export type SubscriptionConsoleView = FreeSubscriptionView | ContinuousSubscriptionView;

export function listSubscriptionViews(
  repoRoot: string,
  runtimeDirectory?: string
): SubscriptionConsoleView[] {
  const resources = openQueryResources(repoRoot, runtimeDirectory);
  try {
    const subscriptions = resources.store.list().map((subscription) => subscriptionView(
      subscription,
      resources.callbacks.definitions(callbackOwner(subscription.subscriptionId)),
      callbackOccurrences(resources.callbacks, subscription),
      resources.foundation,
      resources.runtime
    ));
    const continuous = listContinuousSubscriptionViews(repoRoot, runtimeDirectory);
    return [...subscriptions, ...continuous].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  } finally {
    closeQueryResources(resources);
  }
}

export function inspectSubscriptionView(
  repoRoot: string,
  subscriptionId: string,
  runtimeDirectory?: string
): SubscriptionConsoleView {
  const continuous = inspectContinuousSubscriptionView(
    repoRoot,
    subscriptionId,
    runtimeDirectory
  );
  if (continuous !== undefined) return continuous;
  const resources = openQueryResources(repoRoot, runtimeDirectory);
  try {
    const subscription = resources.store.require(subscriptionId);
    return subscriptionView(
      subscription,
      resources.callbacks.definitions(callbackOwner(subscriptionId)),
      callbackOccurrences(resources.callbacks, subscription),
      resources.foundation,
      resources.runtime
    );
  } finally {
    closeQueryResources(resources);
  }
}

export function inspectSubscription(
  repoRoot: string,
  subscriptionId: string,
  runtimeDirectory?: string
): SubscriptionInspection {
  const resources = openQueryResources(repoRoot, runtimeDirectory);
  try {
    const subscription = resources.store.require(subscriptionId);
    const owner = requireOwner(subscription.ownerAgentId, resources.foundation);
    return {
      subscription,
      callbackDefinitions: resources.callbacks.definitions(callbackOwner(subscriptionId)),
      callbacks: callbackOccurrences(resources.callbacks, subscription),
      owner
    };
  } finally {
    closeQueryResources(resources);
  }
}

function subscriptionView(
  subscription: FreeSubscription,
  callbackDefinitions: readonly ProactiveCallbackDefinition[],
  callbacks: readonly ProactiveCallbackOccurrence[],
  foundation: LocalFoundationStore,
  runtime: RuntimeStore
): FreeSubscriptionView {
  const owner = requireOwner(subscription.ownerAgentId, foundation);
  return {
    kind: "free",
    id: subscription.subscriptionId,
    title: subscription.title,
    status: subscription.status,
    owner: { agentId: owner.principalId, handle: owner.handle, client: owner.client },
    definition: {
      schema: subscription.definitionSchema,
      revision: subscription.definitionRevision,
      digest: subscription.definitionDigest,
      callbackPhaseStatus: subscription.callbackPhaseStatus,
      artifactRevision: subscription.probe.artifactRevision,
      artifactDigest: subscription.probe.artifactDigest,
      externalRefBinding: subscription.externalRefBinding ?? null,
      callbacks: callbackDefinitions
    },
    callbacks: callbacks.map((callback) => subscriptionCallbackView(callback, runtime)),
    probe: {
      plugin: {
        id: subscription.probe.plugin.id,
        path: subscription.probe.plugin.path,
        schemaVersion: subscription.probe.plugin.schemaVersion
      },
      policy: {
        allowedHttpOrigins: subscription.probe.policy.allowedHttpOrigins,
        allowedExecutables: subscription.probe.policy.allowedExecutables,
        allowedEnvironment: subscription.probe.policy.allowedEnvironment,
        timeoutMilliseconds: subscription.probe.policy.timeoutMilliseconds,
        maxOutputBytes: subscription.probe.policy.maxOutputBytes
      }
    },
    schedule: {
      intervalMilliseconds: subscription.intervalMilliseconds,
      maxWaitMilliseconds: subscription.maxWaitMilliseconds,
      maxAttempts: subscription.maxAttempts,
      attemptCount: subscription.attemptCount,
      deadlineAt: subscription.deadlineAt,
      nextPollAt: subscription.nextPollAt
    },
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
    latestError: subscription.latestError ?? null,
    terminalObservation: subscription.terminalObservation ?? null
  };
}

function requireOwner(agentId: string, foundation: LocalFoundationStore): LocalAgent {
  const owner = foundation.agent(agentId);
  if (owner === undefined) throw new Error(`Subscription owner is missing: ${agentId}`);
  return owner;
}

function openQueryResources(repoRoot: string, runtimeDirectory?: string) {
  const database = runtimePaths(repoRoot, runtimeDirectory).database;
  return {
    store: new SubscriptionStore(database),
    callbacks: new CallbackStore(database),
    foundation: new LocalFoundationStore(database),
    runtime: new RuntimeStore(database)
  };
}

function callbackOwner(subscriptionId: string) {
  return { kind: "subscription" as const, id: subscriptionId, revision: 1 };
}

function callbackOccurrences(
  callbacks: CallbackStore,
  subscription: FreeSubscription
): ProactiveCallbackOccurrence[] {
  return subscription.terminalKey === undefined
    ? []
    : callbacks.list({
        ownerKind: "subscription",
        ownerId: subscription.subscriptionId,
        triggerOccurrenceKey: subscription.terminalKey
      });
}

function subscriptionCallbackView(
  callback: ProactiveCallbackOccurrence,
  runtime: RuntimeStore
): SubscriptionCallbackView {
  const audit = callback.eventId === undefined ? undefined : runtime.audit(callback.eventId);
  return {
    ...callback,
    invocationStatus: audit?.execution?.status ?? null,
    agentResult: subscriptionAgentResult(callback, audit?.resultEvent?.output)
  };
}

function subscriptionAgentResult(
  callback: ProactiveCallbackOccurrence,
  output: string | undefined
): SubscriptionAgentResult | null {
  if (callback.kind !== "agent.invoke") return null;
  const receipt = callback.receipt;
  const receiptResult = typeof receipt === "object" && receipt !== null &&
    !Array.isArray(receipt) && "result" in receipt
    ? (receipt as Readonly<Record<string, unknown>>).result
    : undefined;
  for (const candidate of [output, receiptResult === undefined
    ? undefined
    : JSON.stringify(receiptResult)]) {
    if (candidate === undefined) continue;
    try {
      return parseSubscriptionAgentResult(candidate);
    } catch {
      // A malformed or generic legacy receipt remains readable through the raw callback fields.
    }
  }
  return null;
}

function closeQueryResources(resources: ReturnType<typeof openQueryResources>): void {
  resources.runtime.close();
  resources.foundation.close();
  resources.callbacks.close();
  resources.store.close();
}
