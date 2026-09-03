import { createHash } from "node:crypto";

import type { ProviderPolicyObservationSnapshot } from
  "../../core/runtime/agent-invocation.js";

type ProviderPolicyClient = "codex" | "claude-code" | "kimi-code" | "pi";
type ProviderWorkspaceAccess = "read" | "write";

const KIMI_RAW_RESULT_DIRECTIVE =
  "The first non-whitespace character of your entire response must be the opening brace `{`";

export function codexAppServerPolicyObservation(
  parameters: Readonly<Record<string, unknown>>,
  helperSource: string,
  workspaceAccess: ProviderWorkspaceAccess = "read"
): ProviderPolicyObservationSnapshot & { readonly client: "codex" } {
  const expectedSandbox = workspaceAccess === "write" ? "workspace-write" : "read-only";
  if (parameters.approvalPolicy !== "never" || parameters.sandbox !== expectedSandbox) {
    throw new Error(`Codex ${workspaceAccess} app-server policy is not enforced by Thread params`);
  }
  const config = parameters.config;
  const shellPolicy = isRecord(config) ? config.shell_environment_policy : undefined;
  const exclude = isRecord(shellPolicy) ? shellPolicy.exclude : undefined;
  if (!Array.isArray(exclude) ||
    !exclude.includes("ROLLERSKATE_CLIENT_HISTORY_POLICY")) {
    throw new Error("Codex app-server history policy environment is inherited by shell");
  }
  return {
    client: "codex",
    controls: {
      transport: "app-server",
      sandbox: expectedSandbox,
      workspaceAccess,
      approvalPolicy: "never",
      historyPolicyEnvironment: "excluded-from-shell"
    },
    hook: {
      state: "enforced",
      helperDigest: createHash("sha256")
        .update(JSON.stringify({ parameters, helperSource }))
        .digest("hex")
    }
  };
}

export function providerPolicyObservationFromArgv<Client extends ProviderPolicyClient>(
  client: Client,
  argv: readonly string[],
  helperSource: string,
  resources: Readonly<Record<string, string>> = {},
  workspaceAccess: ProviderWorkspaceAccess = "read"
): ProviderPolicyObservationSnapshot & { readonly client: Client } {
  const controls = verifiedControls(client, argv, resources, workspaceAccess);
  const resourceDigests = Object.fromEntries(
    Object.entries(resources)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, content]) => [
        name,
        createHash("sha256").update(content).digest("hex")
      ])
  );
  return {
    client,
    controls,
    hook: {
      state: "enforced",
      helperDigest: createHash("sha256")
        .update(JSON.stringify({ argv, helperSource, resourceDigests }))
        .digest("hex")
    }
  };
}

function verifiedControls(
  client: ProviderPolicyClient,
  argv: readonly string[],
  resources: Readonly<Record<string, string>>,
  workspaceAccess: ProviderWorkspaceAccess
): Readonly<Record<string, string | boolean>> {
  if (client === "codex") {
    if (argv[0] !== "app-server" || !argv.includes("--stdio")) {
      throw new Error("Codex app-server transport policy is not enforced");
    }
    requireLastValue(
      argv,
      "--sandbox",
      workspaceAccess === "write" ? "workspace-write" : "read-only",
      client,
      workspaceAccess
    );
    if (!argv.some((argument) => argument === "approval_policy=\"never\"")) {
      throw new Error("Codex read-only provider policy is not enforced by argv");
    }
    reject(argv, ["--dangerously-bypass-approvals-and-sandbox"], client);
    const historyPolicyEnvironment = argv.some((argument) =>
      argument === "shell_environment_policy.exclude=[\"ROLLERSKATE_CLIENT_HISTORY_POLICY\"]")
      ? "excluded-from-shell"
      : "inherited-by-shell";
    return {
      transport: "app-server",
      sandbox: workspaceAccess === "write" ? "workspace-write" : "read-only",
      workspaceAccess,
      approvalPolicy: "never",
      historyPolicyEnvironment
    };
  }
  if (client === "claude-code") {
    requireLastValue(argv, "--permission-mode", "plan", client);
    requireLastValue(argv, "--tools", "Read,Glob,Grep", client);
    reject(argv, ["--dangerously-skip-permissions"], client);
    return { permissionMode: "plan", tools: "Read,Glob,Grep" };
  }
  if (client === "pi") {
    for (const flag of [
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files"
    ]) requireFlag(argv, flag, client, workspaceAccess);
    const mode = lastValue(argv, "--mode");
    if (mode !== "rpc") {
      throw new Error("pi output mode provider policy is not enforced by argv");
    }
    const expected = workspaceAccess === "write"
      ? "read,write,edit,bash,grep,find,ls"
      : "read,grep,find,ls,read_git_diff";
    const actualTools = lastValue(argv, "--tools");
    const configuredReadTools = (resources.piChatReadToolNames ?? "")
      .split(",").filter((name) => name !== "");
    const expectedChatToolSets = [
      ["read_chat_history"],
      configuredReadTools,
      ["read_chat_history", ...configuredReadTools]
    ].filter((names) => names.length > 0)
      .map((names) => `${expected},${names.join(",")}`);
    if (actualTools !== expected && !expectedChatToolSets.includes(actualTools ?? "")) {
      throw new Error(`pi ${workspaceAccess} provider policy is not enforced by argv`);
    }
    const chatToolsEnabled = actualTools !== expected;
    const readGitExtension = resources.piReadonlyGitExtensionPath;
    const chatHistoryExtension = resources.piChatHistoryExtensionPath;
    const readGitExtensionSource = resources.piReadonlyGitExtensionSource;
    const chatHistoryExtensionSource = resources.piChatHistoryExtensionSource;
    if (readGitExtension === undefined || chatHistoryExtension === undefined ||
      readGitExtensionSource === undefined || readGitExtensionSource.trim() === "" ||
      chatHistoryExtensionSource === undefined || chatHistoryExtensionSource.trim() === "" ||
      argv.some((argument) => argument.startsWith("--extension="))) {
      throw new Error(`pi ${workspaceAccess} extension policy is not enforced by argv`);
    }
    const expectedExtensions = [
      ...(workspaceAccess === "read" ? [readGitExtension] : []),
      ...(chatToolsEnabled ? [chatHistoryExtension] : [])
    ];
    if (!sameValues(valuesAfter(argv, "--extension"), expectedExtensions)) {
      throw new Error(`pi ${workspaceAccess} extension policy is not enforced by argv`);
    }
    reject(argv, [
      "--no-tools", "--no-builtin-tools", "--exclude-tools", "--api-key"
    ], client, workspaceAccess);
    return {
      mode: "rpc",
      tools: actualTools!,
      workspaceAccess,
      chatHistory: actualTools?.split(",").includes("read_chat_history") ?? false
    };
  }
  if (argv.length !== 1 || argv[0] !== "acp") {
    throw new Error(`${client} ACP provider policy is not enforced by argv`);
  }
  const writable = workspaceAccess === "write";
  const agentFileContent = writable
    ? resources.kimiWritableAgent
    : resources.kimiReadOnlyAgent;
  if (agentFileContent === undefined || agentFileContent.trim() === "") {
    throw new Error(`${client} ${workspaceAccess} provider policy resource is unverifiable`);
  }
  requireKimiTools(
    agentFileContent,
    writable
      ? ["Read", "Grep", "Glob", "Write", "Edit", "Bash"]
      : ["Read", "Grep", "Glob"],
    workspaceAccess
  );
  requireKimiRawResultDirective(agentFileContent, workspaceAccess);
  return {
    transport: "acp-v1",
    workspaceAccess,
    sessionMode: writable ? "default" : "plan",
    permissionPolicy: writable ? "allow-once" : "read-only-kinds",
    promptPolicy: writable ? "bundled-writable" : "bundled-read-only",
    promptPolicyDigest: createHash("sha256").update(agentFileContent).digest("hex")
  };
}

function requireKimiTools(
  agentFileContent: string,
  expected: readonly string[],
  workspaceAccess: ProviderWorkspaceAccess
): void {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(agentFileContent)?.[1];
  const toolsBlock = frontmatter === undefined
    ? undefined
    : /^tools:\s*\r?\n((?:[ \t]+-[^\r\n]+(?:\r?\n|$))+)/m.exec(frontmatter)?.[1];
  const actual = toolsBlock?.split(/\r?\n/)
    .map((line) => /^\s*-\s*(\S+)\s*$/.exec(line)?.[1])
    .filter((tool): tool is string => tool !== undefined) ?? [];
  if (actual.length !== expected.length ||
    actual.some((tool, index) => tool !== expected[index])) {
    throw new Error(
      `kimi-code ${workspaceAccess} provider policy tools do not match the grant`
    );
  }
}

function requireKimiRawResultDirective(
  agentFileContent: string,
  workspaceAccess: ProviderWorkspaceAccess
): void {
  if (!agentFileContent.includes(KIMI_RAW_RESULT_DIRECTIVE)) {
    throw new Error(
      `kimi-code ${workspaceAccess} provider policy is missing the raw-result first-character directive`
    );
  }
}

function requireFlag(
  argv: readonly string[],
  flag: string,
  client: string,
  workspaceAccess: ProviderWorkspaceAccess = "read"
): void {
  if (!argv.includes(flag)) {
    throw new Error(`${client} ${workspaceAccess} provider policy is not enforced by argv`);
  }
}

function requireLastValue(
  argv: readonly string[],
  flag: string,
  expected: string,
  client: string,
  workspaceAccess: ProviderWorkspaceAccess = "read"
): void {
  const index = argv.lastIndexOf(flag);
  if (index < 0 || argv[index + 1] !== expected) {
    throw new Error(`${client} ${workspaceAccess} provider policy is not enforced by argv`);
  }
}

function lastValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.lastIndexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

function valuesAfter(argv: readonly string[], flag: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && index + 1 < argv.length) values.push(argv[index + 1]!);
  }
  return values;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reject(
  argv: readonly string[],
  flags: readonly string[],
  client: string,
  workspaceAccess: ProviderWorkspaceAccess = "read"
): void {
  if (flags.some((flag) => argv.includes(flag))) {
    throw new Error(`${client} ${workspaceAccess} provider policy conflicts with unsafe argv`);
  }
}
