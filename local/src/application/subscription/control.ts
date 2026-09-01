import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import type {
  FreeSubscriptionCallback,
  FreeSubscriptionDefinition
} from "../../capabilities/subscription/model.js";
export type {
  FreeSubscriptionCallback,
  FreeSubscriptionDefinition
} from "../../capabilities/subscription/model.js";
import { CallbackStore } from "../../infrastructure/callback/store.js";
import { SubscriptionStore } from "../../capabilities/subscription/store.js";
import { RuntimeStore } from "../../core/runtime/store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";
import { LocalFoundationStore } from "../../infrastructure/sqlite/foundation-store.js";
import {
  runtimeAdapterId,
  runtimeAdapterIdMatches
} from "../../modules/agent/client-profile.js";
import type { LocalAgent } from "../../modules/foundation/model.js";
import { validateProactiveCallback } from "../../modules/callback/proactive-model.js";
import {
  inspectSubscriptionView,
  type SubscriptionConsoleView,
  type SubscriptionInspection
} from "./query.js";
import {
  controlContinuousSubscriptionView,
  setContinuousSubscriptionArchivedView
} from "./continuous.js";
export {
  inspectSubscription,
  inspectSubscriptionView,
  listSubscriptionViews,
  pageSubscriptionViews,
  type FreeSubscriptionView,
  type SubscriptionConsoleView,
  type SubscriptionInspection
} from "./query.js";

export function registerSubscription(
  repoRoot: string,
  input: FreeSubscriptionDefinition,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): SubscriptionInspection {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const foundation = new LocalFoundationStore(paths.database);
  const runtime = new RuntimeStore(paths.database);
  const subscriptions = new SubscriptionStore(paths.database);
  const callbacks = new CallbackStore(paths.database);
  try {
    const owner = foundation.agent(input.ownerAgentId);
    if (owner === undefined) throw new Error(`Local Agent not found: ${input.ownerAgentId}`);
    if (owner.status !== "active") throw new Error(`Local Agent is not active: ${input.ownerAgentId}`);
    const pluginPath = canonicalFile(input.probe.plugin.path, "probe artifact");
    const artifactDigest = `sha256:${createHash("sha256")
      .update(readFileSync(pluginPath)).digest("hex")}`;
    if (artifactDigest !== input.probe.artifactDigest) {
      throw new Error(`probe artifact digest mismatch: expected ${artifactDigest}`);
    }
    const workspace = canonicalDirectory(input.probe.policy.workspaceRoot, "probe workspace");
    const definition: FreeSubscriptionDefinition = {
      ...input,
      probe: {
        ...input.probe,
        plugin: { ...input.probe.plugin, path: pluginPath },
        policy: {
          ...input.probe.policy,
          workspaceRoot: workspace,
          allowedHttpOrigins: input.probe.policy.allowedHttpOrigins.map(canonicalOrigin),
          allowedExecutables: input.probe.policy.allowedExecutables.map(
            (path) => canonicalFile(path, "probe executable")
          ),
          allowedEnvironment: [...new Set(input.probe.policy.allowedEnvironment)]
        }
      },
      callbacks: input.callbacks.map((callback) => canonicalCallback(
        callback,
        owner,
        runtime
      ))
    };
    const subscription = subscriptions.create(definition, at);
    return {
      subscription,
      callbackDefinitions: callbacks.definitions({
        kind: "subscription",
        id: subscription.subscriptionId,
        revision: 1
      }),
      callbacks: [],
      owner
    };
  } finally {
    callbacks.close();
    subscriptions.close();
    runtime.close();
    foundation.close();
  }
}

export function controlSubscriptionView(
  repoRoot: string,
  subscriptionId: string,
  action: "pause" | "resume" | "cancel",
  runtimeDirectory?: string
): SubscriptionConsoleView {
  const continuous = controlContinuousSubscriptionView(
    repoRoot,
    subscriptionId,
    action,
    runtimeDirectory
  );
  if (continuous !== undefined) return continuous;
  const store = new SubscriptionStore(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const current = store.require(subscriptionId);
    if (action === "resume" && current.definitionSchema !== "SubscriptionDefinition@4") {
      throw new Error("legacy_trigger_execution_closed: migrate this Subscription to a bound Run");
    }
    store.setStatus(subscriptionId, action);
  } finally {
    store.close();
  }
  return inspectSubscriptionView(repoRoot, subscriptionId, runtimeDirectory);
}

export function setSubscriptionArchivedView(
  repoRoot: string,
  subscriptionId: string,
  archived: boolean,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): SubscriptionConsoleView {
  const continuous = setContinuousSubscriptionArchivedView(
    repoRoot,
    subscriptionId,
    archived,
    runtimeDirectory,
    at
  );
  if (continuous !== undefined) return continuous;
  const store = new SubscriptionStore(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    store.setArchived(subscriptionId, archived, at);
  } finally {
    store.close();
  }
  return inspectSubscriptionView(repoRoot, subscriptionId, runtimeDirectory);
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

function canonicalCallback(
  callback: FreeSubscriptionCallback,
  owner: LocalAgent,
  runtime: RuntimeStore
): FreeSubscriptionCallback {
  const definition = { ...callback.definition };
  const grant = { ...callback.grant };
  if (callback.kind === "command.exec") {
    const executable = canonicalFile(requiredText(
      definition.executable,
      "callback executable"
    ), "callback executable");
    const grantExecutable = canonicalFile(requiredText(
      grant.executable,
      "callback grant executable"
    ), "callback grant executable");
    if (executable !== grantExecutable) throw new Error("callback executable exceeds grant");
    const cwd = canonicalDirectory(requiredText(definition.cwd, "callback cwd"), "callback cwd");
    const grantCwd = canonicalDirectory(requiredText(grant.cwd, "callback grant cwd"),
      "callback grant cwd");
    if (cwd !== grantCwd) throw new Error("callback cwd exceeds grant");
    return validateProactiveCallback({
      ...callback,
      definition: { ...definition, executable, cwd },
      grant: {
        ...grant,
        executable: grantExecutable,
        cwd: grantCwd,
        filesystemRoots: requiredStrings(grant.filesystemRoots, "callback filesystemRoots")
          .map((path) => canonicalDirectory(path, "callback filesystem root"))
      }
    });
  }
  if (callback.kind === "agent.invoke") {
    if (definition.agentId !== owner.principalId || grant.agentId !== owner.principalId) {
      throw new Error("callback Agent exceeds owner grant");
    }
    const adapterId = runtimeAdapterId(owner.client);
    const workspace = canonicalDirectory(requiredText(
      definition.workspace,
      "callback Agent workspace"
    ), "callback Agent workspace");
    const grantWorkspace = canonicalDirectory(requiredText(
      grant.workspace,
      "callback Agent grant workspace"
    ), "callback Agent grant workspace");
    if (workspace !== grantWorkspace) throw new Error("callback Agent workspace exceeds grant");
    const sessionId = definition.sessionId;
    if (sessionId !== undefined) {
      const existing = runtime.session(requiredText(sessionId, "callback sessionId"));
      if (existing === undefined || existing.agentId !== owner.principalId ||
        existing.workspace !== workspace ||
        !runtimeAdapterIdMatches(owner.client, existing.adapterId)) {
        throw new Error("callback Session belongs to another target");
      }
    }
    if (grant.workspaceAccess !== "read" && grant.workspaceAccess !== "write") {
      throw new Error("callback Agent workspaceAccess must be read or write");
    }
    if (typeof grant.networkAccess !== "boolean") {
      throw new Error("callback Agent networkAccess must be boolean");
    }
    if (grant.networkAccess && grant.workspaceAccess !== "write") {
      throw new Error("callback Agent networkAccess requires write workspaceAccess");
    }
    if ((grant.workspaceAccess === "write" || grant.networkAccess) &&
      adapterId !== "codex-runtime-app-server-v1") {
      throw new Error("write-capable Subscription callback requires the Codex sandbox adapter");
    }
    return validateProactiveCallback({
      ...callback,
      definition: { ...definition, workspace },
      grant: { ...grant, workspace }
    });
  }
  return validateProactiveCallback(callback);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requiredStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value as string[];
}
