import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { runtimeAdapterId } from "../../modules/agent/client-profile.js";
import {
  LocalFoundationStore
} from "../../infrastructure/sqlite/foundation-store.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import type {
  CreatePollSubscription,
  PollSubscription
} from "../../capabilities/subscription/model.js";
import { PollSubscriptionStore } from "../../capabilities/subscription/store.js";
import { RuntimeStore } from "../../core/runtime/store.js";

export interface RegisterPollSubscriptionInput {
  readonly title: string;
  readonly ownerAgentId: string;
  readonly probe: {
    readonly plugin: {
      readonly path: string;
      readonly id: string;
      readonly config: unknown;
    };
    readonly policy: {
      readonly allowedHttpOrigins: readonly string[];
      readonly allowedExecutables: readonly string[];
      readonly allowedEnvironment: readonly string[];
      readonly timeoutMilliseconds: number;
      readonly maxOutputBytes: number;
    };
  };
  readonly callback: {
    readonly providerSessionId: string;
    readonly workspace: string;
    readonly prompt: string;
  };
  readonly intervalMilliseconds: number;
  readonly maxWaitMilliseconds: number;
  readonly maxAttempts: number;
}

export interface PollSubscriptionInspection {
  readonly subscription: PollSubscription;
  readonly owner: LocalAgent;
}

export interface PollSubscriptionView {
  readonly id: string;
  readonly title: string;
  readonly status: PollSubscription["status"];
  readonly owner: {
    readonly agentId: string;
    readonly handle: string;
    readonly client: LocalAgent["client"];
  };
  readonly callback: {
    readonly providerSessionId: string;
    readonly adapterId: string;
    readonly workspace: string;
    readonly localSessionId: string | null;
    readonly prompt: string;
  };
  readonly probe: {
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
  };
  readonly schedule: {
    readonly intervalMilliseconds: number;
    readonly maxWaitMilliseconds: number;
    readonly maxAttempts: number;
    readonly attemptCount: number;
    readonly deadlineAt: string;
    readonly nextPollAt: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly fireEventId: string | null;
  readonly latestError: string | null;
}

export function registerPollSubscription(
  repoRoot: string,
  input: RegisterPollSubscriptionInput,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): PollSubscriptionInspection {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const runtime = new RuntimeStore(paths.database);
  const foundation = new LocalFoundationStore(paths.database);
  const subscriptions = new PollSubscriptionStore(paths.database);
  try {
    const owner = foundation.agent(input.ownerAgentId);
    if (owner === undefined) throw new Error(`Local Agent not found: ${input.ownerAgentId}`);
    if (owner.status !== "active") {
      throw new Error(`Local Agent is not active: ${input.ownerAgentId}`);
    }
    const adapterId = runtimeAdapterId(owner.client);
    const workspace = canonicalDirectory(input.callback.workspace, "callback workspace");
    const existingSession = runtime.sessionForProvider(
      adapterId,
      input.callback.providerSessionId
    );
    if (existingSession !== undefined && (
      existingSession.agentId !== owner.principalId ||
      existingSession.workspace !== workspace
    )) {
      throw new Error(
        `Callback provider Session is already bound to another Agent or workspace: ` +
        input.callback.providerSessionId
      );
    }
    const pluginPath = canonicalFile(input.probe.plugin.path, "plugin");
    const allowedExecutables = input.probe.policy.allowedExecutables.map(
      (path) => canonicalFile(path, "executable")
    );
    const allowedHttpOrigins = input.probe.policy.allowedHttpOrigins.map(canonicalOrigin);
    const policy = {
      workspaceRoot: workspace,
      allowedHttpOrigins: [...new Set(allowedHttpOrigins)],
      allowedExecutables: [...new Set(allowedExecutables)],
      allowedEnvironment: [...new Set(input.probe.policy.allowedEnvironment)],
      timeoutMilliseconds: input.probe.policy.timeoutMilliseconds,
      maxOutputBytes: input.probe.policy.maxOutputBytes
    };
    const create: CreatePollSubscription = {
      title: input.title,
      ownerAgentId: owner.principalId,
      probe: {
        plugin: {
          path: pluginPath,
          id: input.probe.plugin.id,
          schemaVersion: 1,
          config: input.probe.plugin.config
        },
        policy
      },
      intervalMilliseconds: input.intervalMilliseconds,
      maxWaitMilliseconds: input.maxWaitMilliseconds,
      maxAttempts: input.maxAttempts,
      callback: {
        providerSessionId: input.callback.providerSessionId,
        adapterId,
        workspace,
        ...(existingSession === undefined
          ? {}
          : { localSessionId: existingSession.sessionId }),
        prompt: input.callback.prompt
      }
    };
    const subscription = subscriptions.create(create, at);
    return { subscription, owner };
  } finally {
    subscriptions.close();
    foundation.close();
    runtime.close();
  }
}

export function listPollSubscriptions(
  repoRoot: string,
  runtimeDirectory?: string
): PollSubscriptionInspection[] {
  const database = runtimePaths(repoRoot, runtimeDirectory).database;
  const store = new PollSubscriptionStore(database);
  const foundation = new LocalFoundationStore(database);
  try {
    return store.list().map((subscription) => inspection(subscription, foundation));
  } finally {
    foundation.close();
    store.close();
  }
}

export function inspectPollSubscription(
  repoRoot: string,
  subscriptionId: string,
  runtimeDirectory?: string
): PollSubscriptionInspection {
  const database = runtimePaths(repoRoot, runtimeDirectory).database;
  const store = new PollSubscriptionStore(database);
  const foundation = new LocalFoundationStore(database);
  try {
    const subscription = store.require(subscriptionId);
    return inspection(subscription, foundation);
  } finally {
    foundation.close();
    store.close();
  }
}

export function controlPollSubscription(
  repoRoot: string,
  subscriptionId: string,
  action: "pause" | "resume" | "cancel",
  runtimeDirectory?: string
): PollSubscriptionInspection {
  const database = runtimePaths(repoRoot, runtimeDirectory).database;
  const store = new PollSubscriptionStore(database);
  const foundation = new LocalFoundationStore(database);
  try {
    const subscription = store.setStatus(subscriptionId, action);
    return inspection(subscription, foundation);
  } finally {
    foundation.close();
    store.close();
  }
}

export function pollSubscriptionView(
  inspection: PollSubscriptionInspection
): PollSubscriptionView {
  const { owner, subscription } = inspection;
  return {
    id: subscription.subscriptionId,
    title: subscription.title,
    status: subscription.status,
    owner: {
      agentId: owner.principalId,
      handle: owner.handle,
      client: owner.client
    },
    callback: {
      providerSessionId: subscription.callback.providerSessionId,
      adapterId: subscription.callback.adapterId,
      workspace: subscription.callback.workspace,
      localSessionId: subscription.callback.localSessionId ?? null,
      prompt: subscription.callback.prompt
    },
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
    fireEventId: subscription.fireEventId ?? null,
    latestError: subscription.latestError ?? null
  };
}

function inspection(
  subscription: PollSubscription,
  foundation: LocalFoundationStore
): PollSubscriptionInspection {
  const owner = foundation.agent(subscription.ownerAgentId);
  if (owner === undefined) {
    throw new Error(`Subscription owner Agent not found: ${subscription.ownerAgentId}`);
  }
  return { subscription, owner };
}

function canonicalFile(path: string, field: string): string {
  if (!isAbsolute(path)) throw new Error(`${field} path must be absolute`);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isFile()) throw new Error(`${field} path must be a file`);
  return canonical;
}

function canonicalDirectory(path: string, field: string): string {
  if (!isAbsolute(path)) throw new Error(`${field} path must be absolute`);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error(`${field} path must be a directory`);
  return canonical;
}

function canonicalOrigin(value: string): string {
  const origin = new URL(value).origin;
  if (origin !== value) throw new Error(`HTTP origin must not contain a path: ${value}`);
  return origin;
}
