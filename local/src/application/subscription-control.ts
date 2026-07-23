import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { runtimePaths } from "./runtime-config.js";
import type {
  CreatePollSubscription,
  PollSubscription,
  ProbeExecutionPolicy
} from "../capabilities/subscription/model.js";
import { PollSubscriptionStore } from "../capabilities/subscription/store.js";
import { RuntimeStore } from "../core/runtime/store.js";

export interface RegisterPollSubscriptionInput {
  readonly subscriptionId: string;
  readonly pluginPath: string;
  readonly pluginId: string;
  readonly pluginConfig: unknown;
  readonly sessionId: string;
  readonly prompt: string;
  readonly intervalMilliseconds: number;
  readonly maxWaitMilliseconds: number;
  readonly maxAttempts: number;
  readonly allowedHttpOrigins: readonly string[];
  readonly allowedExecutables: readonly string[];
  readonly allowedEnvironment: readonly string[];
  readonly probeTimeoutMilliseconds: number;
  readonly maxOutputBytes: number;
}

export interface PollSubscriptionInspection {
  readonly subscription: PollSubscription;
}

export interface PollSubscriptionView {
  readonly id: string;
  readonly status: PollSubscription["status"];
  readonly sessionId: string;
  readonly plugin: {
    readonly id: string;
    readonly path: string;
    readonly schemaVersion: number;
  };
  readonly schedule: {
    readonly intervalMilliseconds: number;
    readonly maxWaitMilliseconds: number;
    readonly maxAttempts: number;
    readonly attemptCount: number;
    readonly deadlineAt: string;
    readonly nextPollAt: string;
  };
  readonly executionPolicy: {
    readonly allowedHttpOrigins: readonly string[];
    readonly allowedExecutables: readonly string[];
    readonly allowedEnvironment: readonly string[];
    readonly timeoutMilliseconds: number;
    readonly maxOutputBytes: number;
  };
  readonly prompt: string;
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
  const subscriptions = new PollSubscriptionStore(paths.database);
  try {
    const session = runtime.session(input.sessionId);
    if (session === undefined) throw new Error(`Local Runtime Session not found: ${input.sessionId}`);
    const pluginPath = canonicalFile(input.pluginPath, "plugin");
    const allowedExecutables = input.allowedExecutables.map((path) => canonicalFile(path, "executable"));
    const allowedHttpOrigins = input.allowedHttpOrigins.map(canonicalOrigin);
    const policy: ProbeExecutionPolicy = {
      workspaceRoot: session.workspace,
      allowedHttpOrigins: [...new Set(allowedHttpOrigins)],
      allowedExecutables: [...new Set(allowedExecutables)],
      allowedEnvironment: [...new Set(input.allowedEnvironment)],
      timeoutMilliseconds: input.probeTimeoutMilliseconds,
      maxOutputBytes: input.maxOutputBytes
    };
    const create: CreatePollSubscription = {
      subscriptionId: input.subscriptionId,
      pluginPath,
      pluginId: input.pluginId,
      pluginSchemaVersion: 1,
      pluginConfig: input.pluginConfig,
      policy,
      intervalMilliseconds: input.intervalMilliseconds,
      maxWaitMilliseconds: input.maxWaitMilliseconds,
      maxAttempts: input.maxAttempts,
      callback: {
        sessionId: session.sessionId,
        prompt: input.prompt
      }
    };
    const subscription = subscriptions.create(create, at);
    return { subscription };
  } finally {
    subscriptions.close();
    runtime.close();
  }
}

export function listPollSubscriptions(
  repoRoot: string,
  runtimeDirectory?: string
): PollSubscriptionInspection[] {
  const store = new PollSubscriptionStore(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    return store.list().map((subscription) => ({ subscription }));
  } finally {
    store.close();
  }
}

export function inspectPollSubscription(
  repoRoot: string,
  subscriptionId: string,
  runtimeDirectory?: string
): PollSubscriptionInspection {
  const store = new PollSubscriptionStore(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const subscription = store.require(subscriptionId);
    return { subscription };
  } finally {
    store.close();
  }
}

export function controlPollSubscription(
  repoRoot: string,
  subscriptionId: string,
  action: "pause" | "resume" | "cancel" | "revoke",
  runtimeDirectory?: string
): PollSubscriptionInspection {
  const store = new PollSubscriptionStore(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const subscription = store.setStatus(subscriptionId, action);
    return { subscription };
  } finally {
    store.close();
  }
}

export function pollSubscriptionView(subscription: PollSubscription): PollSubscriptionView {
  return {
    id: subscription.subscriptionId,
    status: subscription.status,
    sessionId: subscription.callback.sessionId,
    plugin: {
      id: subscription.pluginId,
      path: subscription.pluginPath,
      schemaVersion: subscription.pluginSchemaVersion
    },
    schedule: {
      intervalMilliseconds: subscription.intervalMilliseconds,
      maxWaitMilliseconds: subscription.maxWaitMilliseconds,
      maxAttempts: subscription.maxAttempts,
      attemptCount: subscription.attemptCount,
      deadlineAt: subscription.deadlineAt,
      nextPollAt: subscription.nextPollAt
    },
    executionPolicy: {
      allowedHttpOrigins: subscription.policy.allowedHttpOrigins,
      allowedExecutables: subscription.policy.allowedExecutables,
      allowedEnvironment: subscription.policy.allowedEnvironment,
      timeoutMilliseconds: subscription.policy.timeoutMilliseconds,
      maxOutputBytes: subscription.policy.maxOutputBytes
    },
    prompt: subscription.callback.prompt,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
    fireEventId: subscription.fireEventId ?? null,
    latestError: subscription.latestError ?? null
  };
}

function canonicalFile(path: string, field: string): string {
  if (!isAbsolute(path)) throw new Error(`${field} path must be absolute`);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isFile()) throw new Error(`${field} path must be a file`);
  return canonical;
}

function canonicalOrigin(value: string): string {
  const origin = new URL(value).origin;
  if (origin !== value) throw new Error(`HTTP origin must not contain a path: ${value}`);
  return origin;
}
