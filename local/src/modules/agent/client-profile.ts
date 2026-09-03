export const agentClients = [
  "codex",
  "claude-code",
  "kimi-code",
  "pi"
] as const;

export type AgentClient = (typeof agentClients)[number];

export interface AgentExecutionConfig {
  readonly launchArgs: readonly string[];
}

const MAX_LAUNCH_ARGUMENTS = 64;
const MAX_LAUNCH_ARGUMENT_BYTES = 1_024;
const MAX_LAUNCH_ARGUMENTS_BYTES = 16_384;

const reservedOptions: Readonly<Record<AgentClient, ReadonlySet<string>>> = {
  codex: new Set([
    "-c",
    "--config",
    "--json",
    "-s",
    "--sandbox",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--add-dir",
    "--ephemeral",
    "--ignore-rules",
    "--output-schema",
    "-o",
    "--output-last-message",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "-C",
    "--cd"
  ]),
  "claude-code": new Set([
    "-p",
    "--print",
    "--output-format",
    "--input-format",
    "-r",
    "--resume",
    "-c",
    "--continue",
    "--permission-mode",
    "--tools",
    "--allowedTools",
    "--allowed-tools",
    "--disallowedTools",
    "--disallowed-tools",
    "--add-dir",
    "--dangerously-skip-permissions",
    "--permission-prompt-tool"
  ]),
  "kimi-code": new Set([
    "-p",
    "--prompt",
    "--output-format",
    "-S",
    "--session",
    "-r",
    "--resume",
    "-c",
    "--continue",
    "-C",
    "-y",
    "--yolo",
    "--auto",
    "--plan",
    "--agent",
    "--agent-file",
    "--add-dir"
  ]),
  "pi": new Set([
    "-p",
    "--print",
    "--mode",
    "-t",
    "--tools",
    "-xt",
    "--exclude-tools",
    "-nbt",
    "--no-builtin-tools",
    "-nt",
    "--no-tools",
    "-e",
    "--extension",
    "-ne",
    "--no-extensions",
    "--skill",
    "-ns",
    "--no-skills",
    "--prompt-template",
    "-np",
    "--no-prompt-templates",
    "--theme",
    "--use-theme",
    "--no-themes",
    "-nc",
    "--no-context-files",
    "--system-prompt",
    "--append-system-prompt",
    "-r",
    "--resume",
    "-c",
    "--continue",
    "--session",
    "--session-id",
    "--fork",
    "--no-session",
    "--api-key"
  ])
};

export function isAgentClient(value: unknown): value is AgentClient {
  return typeof value === "string" &&
    (agentClients as readonly string[]).includes(value);
}

export function runtimeAdapterId(client: AgentClient): string {
  switch (client) {
    case "codex":
      return "codex-runtime-app-server-v1";
    case "claude-code":
      return "claude-code-runtime-json-v1";
    case "kimi-code":
      return "kimi-code-runtime-acp-v1";
    case "pi":
      return "pi-runtime-rpc-v1";
  }
}

export function runtimeAdapterIdMatches(client: AgentClient, adapterId: string): boolean {
  const expected = runtimeAdapterId(client);
  return client === "kimi-code" || client === "pi"
    ? new RegExp(`^${expected}:[a-f0-9]{64}$`).test(adapterId)
    : adapterId === expected;
}

export function agentExecutionConfig(
  client: AgentClient,
  launchArgsInput: readonly string[]
): AgentExecutionConfig {
  if (launchArgsInput.length > MAX_LAUNCH_ARGUMENTS) {
    throw new Error(`Agent launch args may contain at most ${MAX_LAUNCH_ARGUMENTS} arguments`);
  }
  const launchArgs = launchArgsInput.map((argument, index) => {
    if (typeof argument !== "string" || argument.length === 0) {
      throw new Error(`Agent launch arg ${index + 1} must be a non-empty string`);
    }
    if (argument.includes("\0")) {
      throw new Error(`Agent launch arg ${index + 1} must not contain NUL`);
    }
    if (Buffer.byteLength(argument, "utf8") > MAX_LAUNCH_ARGUMENT_BYTES) {
      throw new Error(
        `Agent launch arg ${index + 1} exceeds ${MAX_LAUNCH_ARGUMENT_BYTES} bytes`
      );
    }
    return argument;
  });
  const totalBytes = launchArgs.reduce(
    (total, argument) => total + Buffer.byteLength(argument, "utf8"),
    0
  );
  if (totalBytes > MAX_LAUNCH_ARGUMENTS_BYTES) {
    throw new Error(`Agent launch args exceed ${MAX_LAUNCH_ARGUMENTS_BYTES} bytes`);
  }
  const reserved = reservedOptions[client];
  for (const argument of launchArgs) {
    const option = argument.startsWith("--")
      ? argument.split("=", 1)[0]!
      : argument;
    if (reserved.has(option) ||
      (client === "codex" && ["exec", "resume", "-"].includes(argument))) {
      throw new Error(
        `Agent launch arg is controlled by the ${client} adapter: ${argument}`
      );
    }
  }
  return { launchArgs };
}

export function parseAgentExecutionConfig(
  client: AgentClient,
  value: unknown
): AgentExecutionConfig {
  if (!isRecord(value)) {
    throw new Error("Agent execution config must be an object");
  }
  const launchArgs = value.launchArgs ?? [];
  if (!Array.isArray(launchArgs) ||
    !launchArgs.every((argument): argument is string => typeof argument === "string")) {
    throw new Error("Agent execution config launchArgs must be an array of strings");
  }
  return agentExecutionConfig(client, launchArgs);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
