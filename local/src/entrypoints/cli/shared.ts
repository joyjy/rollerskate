export interface AppOutput {
  readonly write: (text: string) => void;
}

export const HOST_COMMAND_CALLBACK_HELP = [
  "command.exec callback contract:",
  "  runtime must be \"host\" in both ProactiveCallbackDefinition@1 and ProactiveCallbackGrant@1.",
  "  definition and grant must exactly match executable, argv, cwd, environment, timeoutMilliseconds and maxOutputBytes.",
  "  grant also declares filesystemRoots, truthful networkAccess: true and secretReferences: [].",
  "  The exact host executable is trusted code and may start transitive child processes; Rollerskate does not sandbox it.",
  "  Persisted legacy runtime: \"node\" callbacks remain readable but cannot be added, updated or executed."
].join("\n");

export interface InteractivePrompts {
  readonly question: (prompt: string) => Promise<string>;
  readonly close: () => void;
}

export interface LocalAppDependencies {
  readonly prompts?: InteractivePrompts;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly cwd?: string;
}

export function rejectArguments(arguments_: readonly string[]): void {
  if (arguments_.length > 0) {
    throw new Error(`unexpected arguments: ${arguments_.join(" ")}`);
  }
}

export function requireCount(
  arguments_: readonly string[],
  count: number,
  message: string
): void {
  if (arguments_.length !== count) throw new Error(message);
}

export function parseBoundedInteger(
  value: string,
  field: string,
  minimum: number,
  maximum: number
): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function runtimeDependency(runtimeDirectory: string | undefined): {
  readonly runtimeDirectory?: string;
} {
  return runtimeDirectory === undefined ? {} : { runtimeDirectory };
}

export function findExecutable(
  name: string,
  pathValue: string | undefined
): string | undefined {
  if (pathValue === undefined) {
    return undefined;
  }
  for (const directory of pathValue.split(delimiter)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue through PATH entries.
    }
  }
  return undefined;
}
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
