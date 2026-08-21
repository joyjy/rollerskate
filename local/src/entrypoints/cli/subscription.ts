import { readFileSync, realpathSync } from "node:fs";

import {
  controlSubscriptionView,
  inspectSubscriptionView,
  listSubscriptionViews,
  registerSubscription,
  type FreeSubscriptionDefinition
} from "../../application/subscription/control.js";
import { parseExternalRefTriggerBinding } from
  "../../application/external-resource/trigger-binding.js";
import {
  registerContinuousSubscription,
  type ContinuousSubscriptionDefinition
} from "../../application/subscription/continuous.js";
import { parseProactiveCallbacks } from "../../application/callback/proactive.js";
import { HOST_COMMAND_CALLBACK_HELP } from "./shared.js";

interface Output {
  readonly write: (text: string) => void;
}

const HELP = [
  "Usage:",
  "  scripts/rs subscription add <json-file>",
  "  scripts/rs subscription list",
  "  scripts/rs subscription inspect|pause|resume|cancel <subscription-id>",
  "",
  HOST_COMMAND_CALLBACK_HELP
].join("\n");

export function runSubscriptionCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: Output,
  runtimeDirectory?: string,
  callbackWorkspace = process.cwd()
): number {
  const [command, ...rest] = arguments_;
  if (command === "--help" || (command === "add" && rest[0] === "--help")) {
    if (rest.length > (command === "add" ? 1 : 0)) {
      throw new Error("subscription help accepts no additional arguments");
    }
    output.write(`${HELP}\n`);
    return 0;
  }
  if (command === "add") {
    const input = parseAdd(rest, callbackWorkspace);
    const inspection = input.schemaVersion === "ContinuousSubscriptionDefinition@1"
      ? registerContinuousSubscription(repoRoot, input, runtimeDirectory)
      : registerSubscription(repoRoot, input, runtimeDirectory);
    output.write(`${JSON.stringify(inspection, null, 2)}\n`);
    return 0;
  }
  if (command === "list") {
    if (rest.length !== 0) throw new Error("subscription list accepts no arguments");
    output.write(`${JSON.stringify(listSubscriptionViews(repoRoot, runtimeDirectory), null, 2)}\n`);
    return 0;
  }
  if (command === "inspect") {
    if (rest.length !== 1) throw new Error("subscription inspect requires exactly one id");
    output.write(`${JSON.stringify(
      inspectSubscriptionView(repoRoot, rest[0]!, runtimeDirectory),
      null,
      2
    )}\n`);
    return 0;
  }
  if (command === "pause" || command === "resume" || command === "cancel") {
    if (rest.length !== 1) throw new Error(`subscription ${command} requires exactly one id`);
    output.write(`${JSON.stringify(
      controlSubscriptionView(repoRoot, rest[0]!, command, runtimeDirectory),
      null,
      2
    )}\n`);
    return 0;
  }
  throw new Error("subscription requires add, list, inspect, pause, resume or cancel");
}

function parseAdd(
  arguments_: readonly string[],
  callbackWorkspace: string
): FreeSubscriptionDefinition | ContinuousSubscriptionDefinition {
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
  if (root.schemaVersion === "ContinuousSubscriptionDefinition@1") {
    return parseContinuous(root, callbackWorkspace);
  }
  if (root.schemaVersion !== 3) {
    throw new Error(
      "subscription file schemaVersion must be 3 or ContinuousSubscriptionDefinition@1"
    );
  }
  return parseV3(root, callbackWorkspace);
}

function parseContinuous(
  root: Readonly<Record<string, unknown>>,
  defaultWorkspace: string
): ContinuousSubscriptionDefinition {
  exactKeys(root, [
    "schemaVersion", "revision", "title", "ownerAgentId", "probe", "callbacks", "schedule",
    "externalRefBinding"
  ], "subscription file");
  const probe = record(root.probe, "probe");
  exactKeys(probe, ["plugin", "policy"], "probe");
  const plugin = record(probe.plugin, "probe.plugin");
  exactKeys(plugin, ["path", "id", "config"], "probe.plugin");
  const policy = record(probe.policy, "probe.policy");
  exactKeys(policy, [
    "workspaceRoot", "allowedHttpOrigins", "allowedExecutables",
    "allowedEnvironment", "timeoutMilliseconds", "maxOutputBytes"
  ], "probe.policy");
  const schedule = record(root.schedule, "schedule");
  exactKeys(schedule, ["intervalMilliseconds"], "schedule");
  return {
    schemaVersion: "ContinuousSubscriptionDefinition@1",
    revision: integer(root.revision, "revision"),
    title: text(root.title, "title"),
    ownerAgentId: text(root.ownerAgentId, "ownerAgentId"),
    probe: {
      plugin: {
        path: text(plugin.path, "probe.plugin.path"),
        id: text(plugin.id, "probe.plugin.id"),
        config: plugin.config
      },
      policy: {
        workspaceRoot: policy.workspaceRoot === undefined
          ? realpathSync(defaultWorkspace)
          : text(policy.workspaceRoot, "probe.policy.workspaceRoot"),
        allowedHttpOrigins: stringArray(policy.allowedHttpOrigins, "allowedHttpOrigins"),
        allowedExecutables: stringArray(policy.allowedExecutables, "allowedExecutables"),
        allowedEnvironment: stringArray(policy.allowedEnvironment, "allowedEnvironment"),
        timeoutMilliseconds: integer(policy.timeoutMilliseconds, "timeoutMilliseconds"),
        maxOutputBytes: integer(policy.maxOutputBytes, "maxOutputBytes")
      }
    },
    intervalMilliseconds: integer(schedule.intervalMilliseconds, "schedule.intervalMilliseconds"),
    callbacks: parseProactiveCallbacks(root.callbacks),
    ...(root.externalRefBinding === undefined
      ? {}
      : { externalRefBinding: parseExternalRefTriggerBinding(root.externalRefBinding) })
  };
}

function parseV3(
  root: Readonly<Record<string, unknown>>,
  defaultWorkspace: string
): FreeSubscriptionDefinition {
  exactKeys(root, [
    "schemaVersion", "revision", "title", "ownerAgentId", "probe", "callbacks",
    "schedule", "approvedGrantDigest", "externalRefBinding"
  ], "subscription file");
  const probe = record(root.probe, "probe");
  exactKeys(probe, [
    "plugin", "policy", "artifactRevision", "artifactDigest"
  ], "probe");
  const plugin = record(probe.plugin, "probe.plugin");
  exactKeys(plugin, ["path", "id", "config"], "probe.plugin");
  const policy = record(probe.policy, "probe.policy");
  exactKeys(policy, [
    "workspaceRoot", "allowedHttpOrigins", "allowedExecutables",
    "allowedEnvironment", "timeoutMilliseconds", "maxOutputBytes"
  ], "probe.policy");
  const schedule = record(root.schedule, "schedule");
  exactKeys(schedule, [
    "intervalMilliseconds", "maxWaitMilliseconds", "maxAttempts"
  ], "schedule");
  const callbacks = parseProactiveCallbacks(root.callbacks);
  return {
    schemaVersion: 3,
    revision: text(root.revision, "revision"),
    title: text(root.title, "title"),
    ownerAgentId: text(root.ownerAgentId, "ownerAgentId"),
    probe: {
      plugin: {
        path: text(plugin.path, "probe.plugin.path"),
        id: text(plugin.id, "probe.plugin.id"),
        schemaVersion: 1,
        config: plugin.config
      },
      artifactRevision: text(probe.artifactRevision, "probe.artifactRevision"),
      artifactDigest: text(probe.artifactDigest, "probe.artifactDigest"),
      policy: {
        workspaceRoot: policy.workspaceRoot === undefined
          ? realpathSync(defaultWorkspace)
          : text(policy.workspaceRoot, "probe.policy.workspaceRoot"),
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
        ),
        timeoutMilliseconds: integer(
          policy.timeoutMilliseconds,
          "probe.policy.timeoutMilliseconds"
        ),
        maxOutputBytes: integer(policy.maxOutputBytes, "probe.policy.maxOutputBytes")
      }
    },
    callbacks,
    intervalMilliseconds: integer(
      schedule.intervalMilliseconds,
      "schedule.intervalMilliseconds"
    ),
    maxWaitMilliseconds: integer(
      schedule.maxWaitMilliseconds,
      "schedule.maxWaitMilliseconds"
    ),
    maxAttempts: integer(schedule.maxAttempts, "schedule.maxAttempts"),
    approvedGrantDigest: text(root.approvedGrantDigest, "approvedGrantDigest"),
    ...(root.externalRefBinding === undefined
      ? {}
      : { externalRefBinding: parseExternalRefTriggerBinding(root.externalRefBinding) })
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
