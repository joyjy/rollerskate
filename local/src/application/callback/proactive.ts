import {
  validateProactiveCallback,
  type ProactiveCallbackDefinition,
  type ProactiveCallbackOwnerKind
} from "../../modules/callback/proactive-model.js";
import { SubscriptionStore } from "../../capabilities/subscription/store.js";
import { ContinuousSubscriptionStore } from
  "../../capabilities/subscription/continuous-store.js";
import {
  parseSubscriptionAgentResult,
  subscriptionAgentPrompt
} from "../../capabilities/subscription/agent-result.js";
import { workspaceRevision } from "../../infrastructure/workspace/revision.js";
import type {
  ProactiveCallbackOwnerAdapter
} from "./proactive-runtime.js";

export type { ProactiveCallbackDefinition };

export function proactiveCallbackOwnerAdapters(databasePath?: string): ReadonlyMap<
  ProactiveCallbackOwnerKind,
  ProactiveCallbackOwnerAdapter
> {
  const agentEvent = (
    callback: Parameters<ProactiveCallbackOwnerAdapter["createAgentEvent"]>[0],
    at: string,
    source: "schedule" | "subscription"
  ) => {
    const definition = callback.definition;
    return {
      type: "agent.request" as const,
      source: {
        kind: source,
        externalId: `proactive-callback:${callback.occurrenceId}`
      },
      agentId: text(definition.agentId, "callback agentId"),
      prompt: text(definition.prompt, "callback prompt"),
      ...(definition.sessionId === undefined
        ? {}
        : { sessionId: text(definition.sessionId, "callback sessionId") }),
      createdAt: at,
      maxAttempts: 1
    };
  };
  const adapters = new Map<ProactiveCallbackOwnerKind, ProactiveCallbackOwnerAdapter>([
    ["schedule", {
      createAgentEvent: (callback, at) => agentEvent(callback, at, "schedule")
    }],
    ["continuous_subscription", {
      createAgentEvent: (callback, at) => agentEvent(callback, at, "subscription")
    }]
  ]);
  if (databasePath !== undefined) {
    adapters.set("continuous_subscription", {
      createAgentEvent: (callback, at) => agentEvent(callback, at, "subscription"),
      commandContext(callback) {
        const subscriptions = new ContinuousSubscriptionStore(databasePath);
        try {
          const subscription = subscriptions.require(callback.owner.id);
          if (subscription.pendingOccurrenceKey !== callback.triggerOccurrenceKey ||
            subscription.pendingObservation === undefined) {
            throw new Error(
              `Continuous Subscription occurrence is not pending: ${callback.triggerOccurrenceKey}`
            );
          }
          return { observation: subscription.pendingObservation };
        } finally {
          subscriptions.close();
        }
      }
    });
    adapters.set("subscription", {
      createAgentEvent(callback, at) {
        const definition = callback.definition;
        const grant = callback.grant;
        const workspace = text(definition.workspace, "callback workspace");
        const subscriptions = new SubscriptionStore(databasePath);
        try {
          const subscription = subscriptions.require(callback.owner.id);
          if (subscription.terminalObservation === undefined) {
            throw new Error(`Subscription has no terminal observation: ${callback.owner.id}`);
          }
          return {
            type: "subscription.fire",
            source: {
              kind: "subscription",
              externalId: `proactive-callback:${callback.occurrenceId}`
            },
            agentId: text(definition.agentId, "callback agentId"),
            prompt: subscriptionAgentPrompt(text(definition.prompt, "callback prompt")),
            observation: subscription.terminalObservation as
              import("../../core/event/model.js").SubscriptionFireObservation,
            subscriptionInvocation: {
              schemaVersion: "SubscriptionAgentInvocation@1",
              resultSchema: "SubscriptionAgentResult@1",
              workspaceGrant: {
                schemaVersion: "ExternalWorkspaceGrant@1",
                root: workspace,
                access: workspaceAccess(grant.workspaceAccess),
                revision: workspaceRevision(workspace).revision
              },
              networkAccess: boolean(grant.networkAccess, "callback networkAccess")
            },
            ...(definition.sessionId === undefined
              ? {}
              : { sessionId: text(definition.sessionId, "callback sessionId") }),
            createdAt: at,
            maxAttempts: 1
          };
        } finally {
          subscriptions.close();
        }
      },
      interpretAgentCompletion(_callback, output) {
        try {
          const result = parseSubscriptionAgentResult(output ?? "");
          return {
            status: result.status,
            receipt: { outcome: result.status, result },
            ...(result.status === "succeeded" ? {} : { error: result.summary })
          };
        } catch (error) {
          return {
            status: "failed",
            error: message(error),
            receipt: { outcome: "failed", error: "invalid_agent_result" }
          };
        }
      }
    });
  }
  return adapters;
}

export function parseProactiveCallbacks(value: unknown): ProactiveCallbackDefinition[] {
  if (!Array.isArray(value)) throw new Error("callbacks must be an array");
  return value.map((entry, index) => {
    const field = `callbacks[${index}]`;
    const callback = record(entry, field);
    exactKeys(callback, ["callbackId", "kind", "definition", "grant"], field);
    return validateProactiveCallback({
      callbackId: text(callback.callbackId, `${field}.callbackId`),
      kind: callback.kind as ProactiveCallbackDefinition["kind"],
      definition: record(callback.definition, `${field}.definition`),
      grant: record(callback.grant, `${field}.grant`)
    });
  });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${field} has unknown field: ${unknown}`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function workspaceAccess(value: unknown): "read" | "write" {
  if (value !== "read" && value !== "write") {
    throw new Error("callback workspaceAccess must be read or write");
  }
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}
