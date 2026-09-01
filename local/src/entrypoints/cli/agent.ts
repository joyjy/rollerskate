import { configureAgents } from "../../application/agent/server-control.js";
import {
  addLocalAgent,
  configureLocalAgent,
  inspectAgent,
  isAgentClient,
  listAgents,
  localRuntimeSnapshot,
  renameLocalAgent,
  resumeLocalAgent,
  suspendLocalAgent,
  type AgentSummary,
  type LocalAgent,
  type LocalAgentClient
} from "../../application/agent/control.js";
import { runAgentProfileCommand } from "./topic.js";
import type { AppOutput, LocalAppDependencies } from "./shared.js";
import {
  rejectArguments,
  requireCount,
  runtimeDependency
} from "./shared.js";

export function runWorkspaceCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: AppOutput,
  runtimeDirectory?: string
): number {
  const [command, ...rest] = arguments_;
  if (command !== "set" || rest.length !== 1) {
    throw new Error("workspace set requires exactly one absolute path");
  }
  const config = configureAgents(repoRoot, rest[0] ?? "", runtimeDirectory);
  output.write(`Agent workspace root configured: ${config.workspaceRoot}\n`);
  return 0;
}

export async function runAgentCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: AppOutput,
  runtimeDirectory: string | undefined,
  dependencies: LocalAppDependencies
): Promise<number> {
  const [command, ...rest] = arguments_;
  const options = runtimeDependency(runtimeDirectory);
  if (command === "profile") {
    return runAgentProfileCommand(repoRoot, rest, output, {
      ...(runtimeDirectory === undefined ? {} : { runtimeDirectory }),
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      ...(dependencies.cwd === undefined ? {} : { cwd: dependencies.cwd })
    });
  }
  if (command === "create") {
    const create = parseAgentCreate(rest);
    const agent = addLocalAgent(
      repoRoot,
      create.handle,
      create.client,
      options,
      create.launchArgs
    );
    output.write(formatAgentSummary(
      "Agent created.",
      inspectAgent(repoRoot, agent.principalId, options)
    ));
    return 0;
  }
  if (command === "configure") {
    const configure = parseAgentConfigure(rest);
    const agent = requireLocalAgent(repoRoot, configure.handle, options);
    configureLocalAgent(repoRoot, agent.principalId, configure.launchArgs, options);
    output.write(formatAgentSummary(
      "Agent configured.",
      inspectAgent(repoRoot, agent.principalId, options)
    ));
    return 0;
  }
  if (command === "list") {
    rejectArguments(rest);
    const agents = listAgents(repoRoot, options);
    if (agents.length === 0) {
      output.write("No local Agents are registered on this Device.\n");
    } else {
      output.write(`${agents.map((agent) => formatAgentSummary("Agent", agent).trimEnd())
        .join("\n\n")}\n`);
    }
    return 0;
  }
  if (command === "status") {
    requireCount(rest, 1, "agent status requires exactly one handle");
    const agent = requireLocalAgent(repoRoot, rest[0]!, options);
    output.write(formatAgentSummary(
      "Agent.",
      inspectAgent(repoRoot, agent.principalId, options)
    ));
    return 0;
  }
  if (command === "rename") {
    requireCount(rest, 2, "agent rename requires <handle> <new-handle>");
    const agent = requireLocalAgent(repoRoot, rest[0]!, options);
    renameLocalAgent(repoRoot, agent.principalId, rest[1]!, options);
    output.write(formatAgentSummary(
      "Agent renamed.",
      inspectAgent(repoRoot, agent.principalId, options)
    ));
    return 0;
  }
  if (command === "suspend" || command === "resume") {
    requireCount(rest, 1, `agent ${command} requires exactly one handle`);
    const agent = requireLocalAgent(repoRoot, rest[0]!, options);
    if (command === "suspend") {
      suspendLocalAgent(repoRoot, agent.principalId, options);
    } else {
      resumeLocalAgent(repoRoot, agent.principalId, options);
    }
    output.write(formatAgentSummary(
      command === "suspend" ? "Agent suspended." : "Agent resumed.",
      inspectAgent(repoRoot, agent.principalId, options)
    ));
    return 0;
  }
  if (command === "request") {
    throw new Error(
      "direct_agent_work_closed: start RunIntent@1 and select the Agent by stable participant ref"
    );
  }
  throw new Error(
    "agent requires create, configure, list, status, rename, suspend, resume or profile"
  );
}

export function requireLocalAgent(
  repoRoot: string,
  handle: string,
  options: { readonly runtimeDirectory?: string }
): LocalAgent {
  const agent = localRuntimeSnapshot(repoRoot, options).agents.find(
    (candidate) => candidate.handle.toLocaleLowerCase("und") === handle.toLocaleLowerCase("und")
  );
  if (agent === undefined) throw new Error(`Local Agent not found: ${handle}`);
  return agent;
}

function formatAgentSummary(prefix: string, agent: AgentSummary): string {
  return [
    prefix,
    `Agent: @${agent.handle} (${agent.principalId})`,
    `Status: ${agent.status}`,
    `Client: ${agent.client}`,
    `Availability: ${agent.availability.state}` +
      (agent.availability.reason === undefined ? "" : ` (${agent.availability.reason})`),
    `Session: ${agent.currentSession?.sessionId ?? "none"}`,
    `Launch args: ${JSON.stringify(agent.executionConfig.launchArgs)}`
  ].join("\n") + "\n";
}

function parseAgentCreate(arguments_: readonly string[]): {
  readonly handle: string;
  readonly client: LocalAgentClient;
  readonly launchArgs: readonly string[];
} {
  const handle = arguments_[0];
  if (handle === undefined || handle.trim() === "") {
    throw new Error(
      "agent create requires <handle> --client <codex|claude-code|kimi-code|pi>"
    );
  }
  let client: LocalAgentClient | undefined;
  const launchArgs: string[] = [];
  for (let offset = 1; offset < arguments_.length; offset += 1) {
    const option = arguments_[offset]!;
    const value = arguments_[offset + 1];
    if (option === "--client") {
      if (!isAgentClient(value)) {
        throw new Error(
          "agent client must be codex, claude-code, kimi-code or pi"
        );
      }
      if (client !== undefined) throw new Error("--client may only be specified once");
      client = value;
      offset += 1;
    } else if (option === "--launch-arg") {
      if (value === undefined) throw new Error("--launch-arg requires a value");
      launchArgs.push(value);
      offset += 1;
    } else {
      throw new Error(`unexpected agent create option: ${option}`);
    }
  }
  if (client === undefined) throw new Error("agent create requires --client");
  return { handle, client, launchArgs };
}

function parseAgentConfigure(arguments_: readonly string[]): {
  readonly handle: string;
  readonly launchArgs: readonly string[];
} {
  const handle = arguments_[0];
  if (handle === undefined || handle.trim() === "") {
    throw new Error("agent configure requires an Agent handle");
  }
  const launchArgs: string[] = [];
  for (let offset = 1; offset < arguments_.length; offset += 2) {
    if (arguments_[offset] !== "--launch-arg") {
      throw new Error(`unexpected agent configure option: ${arguments_[offset]}`);
    }
    const value = arguments_[offset + 1];
    if (value === undefined) throw new Error("--launch-arg requires a value");
    launchArgs.push(value);
  }
  return { handle, launchArgs };
}
