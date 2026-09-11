import { DeterministicApplicationActionRegistry } from "../proactive/action-registry.js";
import type { FreeSubscription } from "../../capabilities/subscription/model.js";
import type { DatabaseSync } from "node:sqlite";
import type {
  ProactiveCallbackDefinition,
  ProactiveCallbackOccurrence
} from "../../modules/callback/proactive-model.js";
import { CallbackStore } from "../../infrastructure/callback/store.js";
import { SubscriptionStore } from "../../capabilities/subscription/store.js";
import { ContinuousSubscriptionStore } from
  "../../capabilities/subscription/continuous-store.js";
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
  inspectContinuousSubscriptionViews,
  listContinuousSubscriptionViews,
  type ContinuousSubscriptionView
} from "./continuous.js";
import {
  literalLikePattern,
  normalizeListPageInput,
  type ListPage,
  type ListPageInput
} from "../list-page.js";
import { openRuntimeDatabaseReadOnly } from "../../infrastructure/sqlite/database.js";
import { assertCurrentLocalSchema } from "../../infrastructure/sqlite/schema/index.js";

export {
  subscriptionHistory,
  subscriptionHistoryByReference,
  type SubscriptionHistory,
  type SubscriptionHistoryDelivery,
  type SubscriptionHistoryExecution,
  type SubscriptionHistoryFire,
  type SubscriptionHistoryQuery,
  type SubscriptionHistoryQueryReasonCode,
  type SubscriptionHistoryReasonCode,
  type SubscriptionHistoryResultEvent
} from "./history.js";

export interface SubscriptionInspection {
  readonly subscription: FreeSubscription;
  readonly callbackDefinitions: readonly ProactiveCallbackDefinition[];
  readonly callbacks: readonly ProactiveCallbackOccurrence[];
  readonly owner: LocalAgent | null;
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
  readonly owner: SubscriptionOwnerView | null;
  readonly definition: {
    readonly schema: FreeSubscription["definitionSchema"];
    readonly revision: string;
    readonly digest: string;
    readonly callbackPhaseStatus: FreeSubscription["callbackPhaseStatus"];
    readonly artifactRevision: string;
    readonly artifactDigest: string;
    readonly externalRefBinding: FreeSubscription["externalRefBinding"] | null;
    readonly callbacks: readonly ProactiveCallbackDefinition[];
    readonly sourceBinding: FreeSubscription["sourceBinding"] | null;
    readonly target: FreeSubscription["target"] | null;
  };
  readonly callbacks: readonly SubscriptionCallbackView[];
  readonly probe: SubscriptionProbeView;
  readonly schedule: SubscriptionScheduleView;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestError: string | null;
  readonly terminalObservation: unknown | null;
  readonly agentRunId: string | null;
  readonly cycleId: string | null;
  readonly admissionReceipt: FreeSubscription["admissionReceipt"] | null;
  readonly actionReceipt: FreeSubscription["actionReceipt"] | null;
  readonly archivedAt: string | null;
  readonly availableActions: {
    readonly archive: boolean;
    readonly unarchive: boolean;
  };
}

export interface SubscriptionCallbackView extends ProactiveCallbackOccurrence {
  readonly invocationStatus: RuntimeExecutionStatus | null;
  readonly agentResult: SubscriptionAgentResult | null;
}

export type SubscriptionConsoleView = FreeSubscriptionView | ContinuousSubscriptionView;

export type SubscriptionRunSourceView = {
  readonly kind: "free";
  readonly status: string;
  readonly nextPollAt: string;
  readonly callbackPhaseStatus: FreeSubscription["callbackPhaseStatus"];
  readonly latestError: string | null;
  readonly cycleId: string | null;
  readonly admissionReceipt: FreeSubscription["admissionReceipt"] | null;
} | {
  readonly kind: "continuous";
  readonly status: string;
  readonly nextPollAt: string | null;
  readonly pendingOccurrenceKey: string | null;
  readonly checkpointOccurrenceKey: string | null;
  readonly pendingCycleId: string | null;
  readonly pendingAdmissionReceipt:
    ReturnType<ContinuousSubscriptionStore["require"]>["pendingAdmissionReceipt"] | null;
  readonly latestError: string | null;
  readonly updatedAt: string;
};

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

export function pageSubscriptionViews(
  repoRoot: string,
  input: ListPageInput = {},
  runtimeDirectory?: string
): ListPage<SubscriptionConsoleView> {
  const query = normalizeListPageInput(input);
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  const filter = `
    ($archive = 'all'
      OR ($archive = 'current' AND archived_at IS NULL)
      OR ($archive = 'archived' AND archived_at IS NOT NULL))
    AND ($search = ''
      OR id LIKE $pattern ESCAPE '\\'
      OR title LIKE $pattern ESCAPE '\\'
      OR status LIKE $pattern ESCAPE '\\'
      OR kind LIKE $pattern ESCAPE '\\'
      OR owner_handle LIKE $pattern ESCAPE '\\')
  `;
  const union = `
    SELECT 'free' AS kind, subscription.subscription_id AS id,
      subscription.title, subscription.status, owner.handle AS owner_handle,
      subscription.archived_at, subscription.updated_at
    FROM subscriptions AS subscription
    LEFT JOIN agents AS owner ON owner.principal_id = subscription.owner_agent_id
    UNION ALL
    SELECT 'continuous' AS kind, subscription.subscription_id AS id,
      subscription.title, subscription.status, owner.handle AS owner_handle,
      subscription.archived_at, subscription.updated_at
    FROM continuous_subscriptions AS subscription
    LEFT JOIN agents AS owner ON owner.principal_id = subscription.owner_agent_id
  `;
  const filterParameters = {
    archive: query.archive,
    search: query.search,
    pattern: literalLikePattern(query.search)
  };
  try {
    database.exec("BEGIN");
    const total = Number((database.prepare(`
      SELECT COUNT(*) AS count FROM (${union}) WHERE ${filter}
    `).get(filterParameters) as { count: number }).count);
    const ids = database.prepare(`
      SELECT id FROM (${union}) WHERE ${filter}
      ORDER BY updated_at DESC, id DESC
      LIMIT $pageSize OFFSET $offset
    `).all({
      ...filterParameters,
      pageSize: query.pageSize,
      offset: query.offset
    }) as unknown as Array<{ id: string }>;
    database.exec("COMMIT");
    return {
      items: subscriptionViewsForIds(
        repoRoot,
        ids.map(({ id }) => id),
        runtimeDirectory
      ),
      total,
      page: query.page,
      pageSize: query.pageSize
    };
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

function subscriptionViewsForIds(
  repoRoot: string,
  subscriptionIds: readonly string[],
  runtimeDirectory?: string
): SubscriptionConsoleView[] {
  const continuous = inspectContinuousSubscriptionViews(
    repoRoot,
    subscriptionIds,
    runtimeDirectory
  );
  const resources = openQueryResources(repoRoot, runtimeDirectory);
  try {
    return subscriptionIds.map((subscriptionId) => {
      const continuousView = continuous.get(subscriptionId);
      if (continuousView !== undefined) return continuousView;
      const subscription = resources.store.require(subscriptionId);
      return subscriptionView(
        subscription,
        resources.callbacks.definitions(callbackOwner(subscriptionId)),
        callbackOccurrences(resources.callbacks, subscription),
        resources.foundation,
        resources.runtime
      );
    });
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

export function inspectSubscriptionViewForRunSource(
  database: DatabaseSync,
  subscriptionId: string
): SubscriptionRunSourceView {
  const continuous = new ContinuousSubscriptionStore(database, { migrate: false });
  const oneShot = new SubscriptionStore(database, { migrate: false });
  try {
    const continuousSubscription = continuous.get(subscriptionId);
    if (continuousSubscription !== undefined) {
      return {
        kind: "continuous",
        status: continuousSubscription.status,
        nextPollAt: continuousSubscription.nextPollAt,
        pendingOccurrenceKey: continuousSubscription.pendingOccurrenceKey ?? null,
        checkpointOccurrenceKey: continuousSubscription.checkpointOccurrenceKey ?? null,
        pendingCycleId: continuousSubscription.pendingCycleId ?? null,
        pendingAdmissionReceipt: continuousSubscription.pendingAdmissionReceipt ?? null,
        latestError: continuousSubscription.latestError ?? null,
        updatedAt: continuousSubscription.updatedAt
      };
    }
    const subscription = oneShot.require(subscriptionId);
    return {
      kind: "free",
      status: subscription.status,
      nextPollAt: subscription.nextPollAt,
      callbackPhaseStatus: subscription.callbackPhaseStatus,
      latestError: subscription.latestError ?? null,
      cycleId: subscription.cycleId ?? null,
      admissionReceipt: subscription.admissionReceipt ?? null
    };
  } finally {
    oneShot.close();
    continuous.close();
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
    const owner = subscription.ownerAgentId === undefined
      ? null
      : requireOwner(subscription.ownerAgentId, resources.foundation);
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
  const owner = subscription.ownerAgentId === undefined
    ? null
    : requireOwner(subscription.ownerAgentId, foundation);
  return {
    kind: "free",
    id: subscription.subscriptionId,
    title: subscription.title,
    status: subscription.status,
    owner: owner === null
      ? null
      : { agentId: owner.principalId, handle: owner.handle, client: owner.client },
    definition: {
      schema: subscription.definitionSchema,
      revision: subscription.definitionRevision,
      digest: subscription.definitionDigest,
      callbackPhaseStatus: subscription.callbackPhaseStatus,
      artifactRevision: subscription.probe.artifactRevision,
      artifactDigest: subscription.probe.artifactDigest,
      externalRefBinding: subscription.externalRefBinding ?? null,
      callbacks: callbackDefinitions,
      sourceBinding: subscription.sourceBinding ?? null,
      target: subscription.target ?? null
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
    terminalObservation: subscription.terminalObservation ?? null,
    agentRunId: subscription.agentRunId ?? null,
    cycleId: subscription.cycleId ?? null,
    admissionReceipt: subscription.admissionReceipt ?? null,
    actionReceipt: subscription.actionReceipt ?? null,
    archivedAt: subscription.archivedAt ?? null,
    availableActions: {
      archive: subscription.archivedAt === undefined &&
        ["completed", "blocked", "cancelled", "expired"].includes(subscription.status),
      unarchive: subscription.archivedAt !== undefined
    }
  };
}

function requireOwner(agentId: string, foundation: LocalFoundationStore): LocalAgent {
  const owner = foundation.agent(agentId);
  if (owner === undefined) throw new Error(`Subscription owner is missing: ${agentId}`);
  return owner;
}

function openQueryResources(repoRoot: string, runtimeDirectory?: string) {
  const database = openRuntimeDatabaseReadOnly(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    assertCurrentLocalSchema(database);
    const options = { migrate: false } as const;
    return {
      database,
      store: new SubscriptionStore(database, { ...options, applicationActions: new DeterministicApplicationActionRegistry(database) }),
      callbacks: new CallbackStore(database, options),
      foundation: new LocalFoundationStore(database, options),
      runtime: new RuntimeStore(database, options)
    };
  } catch (error) {
    database.close();
    throw error;
  }
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
  resources.database.close();
}
