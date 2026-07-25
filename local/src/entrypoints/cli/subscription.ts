import { readFileSync, realpathSync } from "node:fs";

import {
  controlPollSubscription,
  inspectPollSubscription,
  listPollSubscriptions,
  registerPollSubscription,
  type RegisterPollSubscriptionInput
} from "../../application/subscription/control.js";
import type { PollSubscriptionInspection } from "../../application/subscription/control.js";

interface Output {
  readonly write: (text: string) => void;
}

export function runSubscriptionCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: Output,
  runtimeDirectory?: string,
  callbackWorkspace = process.cwd()
): number {
  const [command, ...rest] = arguments_;
  if (command === "add") {
    const input = parseAdd(rest, callbackWorkspace);
    output.write(`${JSON.stringify(
      publicInspection(registerPollSubscription(repoRoot, input, runtimeDirectory)),
      null,
      2
    )}\n`);
    return 0;
  }
  if (command === "list") {
    if (rest.length !== 0) throw new Error("subscription list accepts no arguments");
    output.write(`${JSON.stringify(
      listPollSubscriptions(repoRoot, runtimeDirectory).map(publicInspection),
      null,
      2
    )}\n`);
    return 0;
  }
  if (command === "inspect") {
    if (rest.length !== 1) throw new Error("subscription inspect requires exactly one id");
    output.write(`${JSON.stringify(publicInspection(inspectPollSubscription(
      repoRoot,
      rest[0]!,
      runtimeDirectory
    )), null, 2)}\n`);
    return 0;
  }
  if (command === "pause" || command === "resume" || command === "cancel") {
    if (rest.length !== 1) throw new Error(`subscription ${command} requires exactly one id`);
    output.write(`${JSON.stringify(publicInspection(controlPollSubscription(
      repoRoot,
      rest[0]!,
      command,
      runtimeDirectory
    )), null, 2)}\n`);
    return 0;
  }
  throw new Error("subscription requires add, list, inspect, pause, resume or cancel");
}

function publicInspection(inspection: PollSubscriptionInspection): unknown {
  const { config: _config, ...plugin } = inspection.subscription.probe.plugin;
  return {
    subscription: {
      ...inspection.subscription,
      probe: {
        ...inspection.subscription.probe,
        plugin
      }
    },
    owner: {
      agentId: inspection.owner.principalId,
      handle: inspection.owner.handle,
      client: inspection.owner.client
    }
  };
}

function parseAdd(
  arguments_: readonly string[],
  callbackWorkspace: string
): RegisterPollSubscriptionInput {
  if (arguments_.length !== 1) {
    throw new Error("subscription add requires exactly one JSON file");
  }
  const path = realpathSync(arguments_[0]!);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`subscription file must be valid JSON: ${message(error)}`);
  }
  const root = record(parsed, "subscription file");
  exactKeys(root, [
    "schemaVersion", "title", "ownerAgentId", "probe", "callback", "schedule"
  ], "subscription file");
  if (root.schemaVersion !== 2) {
    throw new Error("subscription file schemaVersion must be 2");
  }
  const probe = record(root.probe, "probe");
  exactKeys(probe, ["plugin", "policy"], "probe");
  const plugin = record(probe.plugin, "probe.plugin");
  exactKeys(plugin, ["path", "id", "config"], "probe.plugin");
  const callback = record(root.callback, "callback");
  exactKeys(callback, ["providerSessionId", "prompt"], "callback");
  const schedule = record(root.schedule, "schedule");
  exactKeys(schedule, [
    "intervalMilliseconds", "maxWaitMilliseconds", "maxAttempts"
  ], "schedule");
  const policy = probe.policy === undefined
    ? {}
    : record(probe.policy, "probe.policy");
  exactKeys(policy, [
    "allowedHttpOrigins", "allowedExecutables", "allowedEnvironment",
    "timeoutMilliseconds", "maxOutputBytes"
  ], "probe.policy");
  return {
    title: text(root.title, "title"),
    ownerAgentId: text(root.ownerAgentId, "ownerAgentId"),
    probe: {
      plugin: {
        path: text(plugin.path, "probe.plugin.path"),
        id: text(plugin.id, "probe.plugin.id"),
        config: plugin.config
      },
      policy: {
        timeoutMilliseconds: optionalInteger(
          policy.timeoutMilliseconds,
          "probe.policy.timeoutMilliseconds",
          30_000
        ),
        maxOutputBytes: optionalInteger(
          policy.maxOutputBytes,
          "probe.policy.maxOutputBytes",
          1_048_576
        ),
        allowedHttpOrigins: stringArray(
          policy.allowedHttpOrigins,
          "probe.policy.allowedHttpOrigins"
        ),
        allowedExecutables: stringArray(
          policy.allowedExecutables,
          "probe.policy.allowedExecutables"
        ),
        allowedEnvironment: stringArray(
          policy.allowedEnvironment,
          "probe.policy.allowedEnvironment"
        )
      }
    },
    callback: {
      providerSessionId: text(
        callback.providerSessionId,
        "callback.providerSessionId"
      ),
      workspace: callbackWorkspace,
      prompt: text(callback.prompt, "callback.prompt")
    },
    intervalMilliseconds: integer(schedule.intervalMilliseconds, "schedule.intervalMilliseconds"),
    maxWaitMilliseconds: integer(schedule.maxWaitMilliseconds, "schedule.maxWaitMilliseconds"),
    maxAttempts: integer(schedule.maxAttempts, "schedule.maxAttempts")
  };
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
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${field} has unknown field: ${unknown[0]}`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalInteger(
  value: unknown,
  field: string,
  fallback: number
): number {
  return value === undefined ? fallback : integer(value, field);
}

function integer(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  return value as number;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) =>
    typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
