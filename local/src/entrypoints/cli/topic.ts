import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import {
  agentPublicProfileUpdateSchema,
  topicCreateRequestSchema,
  topicProfileUpdateSchema
} from "../../protocol.js";
import {
  createServerTopic,
  inspectAgentPublicProfile,
  joinServerTopic,
  listServerTopics,
  publishServerTopicMessage,
  updateAgentPublicProfile,
  updateServerTopicProfile
} from "../../application/topic/control.js";
import {
  listPassiveTopics,
  passiveTopicHistory
} from "../../application/topic/query.js";

interface Output {
  readonly write: (text: string) => void;
}

interface Dependencies {
  readonly runtimeDirectory?: string;
  readonly fetch?: typeof fetch;
  readonly cwd?: string;
}

export async function runAgentProfileCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: Output,
  dependencies: Dependencies
): Promise<number> {
  const [handle, operation, file, ...rest] = arguments_;
  if (handle === undefined) {
    throw new Error("agent profile requires <handle> [update <json-file>]");
  }
  const options = remoteDependencies(dependencies);
  const result = operation === undefined
    ? await inspectAgentPublicProfile(repoRoot, handle, options)
    : operation === "update" && file !== undefined && rest.length === 0
      ? await updateAgentPublicProfile(
          repoRoot,
          handle,
          agentPublicProfileUpdateSchema.parse(readJson(file, dependencies.cwd)),
          options
        )
      : undefined;
  if (result === undefined) {
    throw new Error("agent profile requires <handle> [update <json-file>]");
  }
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

export async function runTopicCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: Output,
  dependencies: Dependencies
): Promise<number> {
  const [command, ...rest] = arguments_;
  if (command === "list") {
    requireCount(rest, 0, "topic list accepts no arguments");
    output.write(`${JSON.stringify(listPassiveTopics(
      repoRoot,
      dependencies.runtimeDirectory
    ), null, 2)}\n`);
    return 0;
  }
  if (command === "history") {
    requireCount(rest, 1, "topic history requires exactly one Topic id");
    output.write(`${JSON.stringify(passiveTopicHistory(
      repoRoot,
      rest[0]!,
      dependencies.runtimeDirectory
    ), null, 2)}\n`);
    return 0;
  }
  if (command === "server-list") {
    requireCount(rest, 0, "topic server-list accepts no arguments");
    output.write(`${JSON.stringify(await listServerTopics(
      repoRoot,
      remoteDependencies(dependencies)
    ), null, 2)}\n`);
    return 0;
  }
  const options = remoteDependencies(dependencies);
  let result: unknown;
  if (command === "create") {
    requireCount(rest, 1, "topic create requires one JSON file");
    result = await createServerTopic(
      repoRoot,
      topicCreateRequestSchema.parse(readJson(rest[0]!, dependencies.cwd)),
      options
    );
  } else if (command === "profile") {
    requireCount(rest, 3, "topic profile requires update <topic-id> <json-file>");
    if (rest[0] !== "update") {
      throw new Error("topic profile requires update <topic-id> <json-file>");
    }
    result = await updateServerTopicProfile(
      repoRoot,
      rest[1]!,
      topicProfileUpdateSchema.parse(readJson(rest[2]!, dependencies.cwd)),
      options
    );
  } else if (command === "join") {
    requireCount(rest, 2, "topic join requires <topic-id> <agent-handle>");
    result = await joinServerTopic(repoRoot, rest[0]!, rest[1]!, options);
  } else if (command === "publish") {
    if (rest.length < 4) {
      throw new Error(
        "topic publish requires <topic-id> <agent-handle> <transaction-id> <message...>"
      );
    }
    result = await publishServerTopicMessage(
      repoRoot,
      rest[0]!,
      rest[1]!,
      rest[2]!,
      rest.slice(3).join(" "),
      options
    );
  } else {
    throw new Error("topic requires list, history, server-list, create, profile, join or publish");
  }
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

function readJson(pathInput: string, cwd = process.cwd()): unknown {
  const path = realpathSync(resolve(cwd, pathInput));
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `invalid JSON file ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function remoteDependencies(dependencies: Dependencies) {
  return {
    ...(dependencies.runtimeDirectory === undefined
      ? {}
      : { runtimeDirectory: dependencies.runtimeDirectory }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
  };
}

function requireCount(values: readonly string[], count: number, message: string): void {
  if (values.length !== count) throw new Error(message);
}
