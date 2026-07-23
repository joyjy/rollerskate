import { readFileSync, realpathSync } from "node:fs";

import {
  controlPollSubscription,
  inspectPollSubscription,
  listPollSubscriptions,
  registerPollSubscription,
  type RegisterPollSubscriptionInput
} from "../../application/subscription-control.js";
import type { PollSubscriptionInspection } from "../../application/subscription-control.js";

interface Output {
  readonly write: (text: string) => void;
}

export function runSubscriptionCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: Output,
  runtimeDirectory?: string
): number {
  const [command, ...rest] = arguments_;
  if (command === "add") {
    const input = parseAdd(rest);
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
  if (command === "pause" || command === "resume" || command === "cancel" || command === "revoke") {
    if (rest.length !== 1) throw new Error(`subscription ${command} requires exactly one id`);
    output.write(`${JSON.stringify(publicInspection(controlPollSubscription(
      repoRoot,
      rest[0]!,
      command,
      runtimeDirectory
    )), null, 2)}\n`);
    return 0;
  }
  throw new Error("subscription requires add, list, inspect, pause, resume, cancel or revoke");
}

function publicInspection(inspection: PollSubscriptionInspection): unknown {
  const { pluginConfig: _pluginConfig, ...subscription } = inspection.subscription;
  return { subscription };
}

function parseAdd(arguments_: readonly string[]): RegisterPollSubscriptionInput {
  const subscriptionId = arguments_[0];
  if (subscriptionId === undefined || subscriptionId.startsWith("--")) {
    throw new Error("subscription add requires an id before options");
  }
  const values = new Map<string, string[]>();
  for (let offset = 1; offset < arguments_.length; offset += 2) {
    const option = arguments_[offset];
    const value = arguments_[offset + 1];
    if (option === undefined || !option.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`subscription add option requires a value: ${option ?? "unknown"}`);
    }
    const key = option.slice(2);
    const supported = [
      "plugin", "plugin-id", "config", "session", "prompt-file",
      "interval-ms", "max-wait-ms", "max-attempts", "probe-timeout-ms",
      "max-output-bytes", "allow-http-origin", "allow-executable", "allow-env"
    ];
    if (!supported.includes(key)) throw new Error(`unknown subscription add option: ${option}`);
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const configPath = realpathSync(one(values, "config"));
  const promptPath = realpathSync(one(values, "prompt-file"));
  let pluginConfig: unknown;
  try {
    pluginConfig = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`subscription config must be valid JSON: ${message(error)}`);
  }
  const prompt = readFileSync(promptPath, "utf8").trim();
  if (prompt === "") throw new Error("callback prompt file must be non-empty");
  return {
    subscriptionId,
    pluginPath: one(values, "plugin"),
    pluginId: one(values, "plugin-id"),
    pluginConfig,
    sessionId: one(values, "session"),
    prompt,
    intervalMilliseconds: integer(values, "interval-ms"),
    maxWaitMilliseconds: integer(values, "max-wait-ms"),
    maxAttempts: integer(values, "max-attempts"),
    probeTimeoutMilliseconds: optionalInteger(values, "probe-timeout-ms", 30_000),
    maxOutputBytes: optionalInteger(values, "max-output-bytes", 1_048_576),
    allowedHttpOrigins: values.get("allow-http-origin") ?? [],
    allowedExecutables: values.get("allow-executable") ?? [],
    allowedEnvironment: values.get("allow-env") ?? []
  };
}

function one(values: ReadonlyMap<string, readonly string[]>, key: string): string {
  const found = values.get(key);
  if (found?.length !== 1 || found[0] === undefined || found[0].trim() === "") {
    throw new Error(`subscription add requires exactly one --${key}`);
  }
  return found[0];
}

function integer(values: ReadonlyMap<string, readonly string[]>, key: string): number {
  const value = Number(one(values, key));
  if (!Number.isInteger(value)) throw new Error(`--${key} must be an integer`);
  return value;
}

function optionalInteger(
  values: ReadonlyMap<string, readonly string[]>,
  key: string,
  fallback: number
): number {
  return values.has(key) ? integer(values, key) : fallback;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
