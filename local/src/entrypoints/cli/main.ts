#!/usr/bin/env node

import { accessSync, constants, createWriteStream, mkdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline/promises";

import { setupLocalRuntime, type SetupInput } from "../../application/runtime-config.js";
import { runtimePaths } from "../../application/runtime-config.js";
import { doctorLocalRuntime } from "../../application/doctor.js";
import {
  inspectLocalDevice,
  loginDevice,
  logoutDevice,
  statusDevice,
  type LocalDeviceStatus
} from "../../application/device/operations.js";
import {
  configureAgents,
  createAgent,
  enqueueAgentRequest,
  listAgents,
  statusAgent,
  type LocalAgentStatus
} from "../../application/agent/operations.js";
import { AgentConfigStore } from "../../application/agent/config.js";
import type { AgentClient } from "../../application/agent/registry-store.js";
import { runAdminCommand, runRoomCommand } from "./room.js";
import {
  reconcileRuntime,
  runtimeStatus,
  setLoopPaused
} from "../../application/loop-control.js";
import { runtimeTrace } from "../../application/runtime-audit.js";
import { startRuntime } from "../../bootstrap/runtime.js";
import { startUiServer } from "../console/launcher.js";
import { runSubscriptionCommand } from "./subscription.js";

interface AppOutput {
  readonly write: (text: string) => void;
}

export interface InteractivePrompts {
  readonly question: (prompt: string) => Promise<string>;
  readonly close: () => void;
}

export interface LocalAppDependencies {
  readonly prompts?: InteractivePrompts;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface GlobalOptions {
  readonly argv: readonly string[];
  readonly runtimeDirectory?: string;
}

const HELP = [
  "Rollerskate MVP",
  "",
  "Usage:",
  "  scripts/rs [--runtime <absolute-path>] [command]",
  "  scripts/rs                open the interactive Local Runtime console",
  "  scripts/rs setup          configure the legacy v0.1 runtime",
  "  scripts/rs doctor         verify legacy v0.1 Matrix access",
  "  scripts/rs start [--no-open] [--ui-port <port>]  run Local Runtime loop + Local UI",
  "  scripts/rs status         inspect Local Runtime loop state",
  "  scripts/rs trace <event-id>",
  "  scripts/rs recover        reconcile interrupted Runtime work",
  "  scripts/rs pause          pause Local Runtime cycles",
  "  scripts/rs resume         resume Local Runtime cycles",
  "  scripts/rs device login   authenticate this Local Runtime using saved configuration",
  "  scripts/rs device status|logout",
  "  scripts/rs admin allow <oidc-subject>",
  "  scripts/rs workspace set <absolute-path>",
  "  scripts/rs agent create <name> [--client codex]",
  "  scripts/rs agent status <name>",
  "  scripts/rs agent list",
  "  scripts/rs agent request <name> [--session <ses_uuidv7>] <prompt...>",
  "  scripts/rs subscription add <id> --plugin <absolute-path> --plugin-id <id> --config <json-file> --session <ses_uuidv7> --prompt-file <file> --interval-ms <n> --max-wait-ms <n> --max-attempts <n>",
  "  scripts/rs subscription list|inspect|pause|resume|cancel|revoke ...",
  "  scripts/rs room create <name> [--public]",
  "  scripts/rs room list|join|invite-human ...",
  "  scripts/rs room add-agent|set-wake|remove-agent|bindings|policy ...",
  "  scripts/rs room send <room-id> <message...>",
  "  scripts/rs room agent-send <room-id> <agent-name> <message...>",
  "  scripts/rs room history <room-id> <agent-name> [--limit <1-100>]",
  "",
  "Runtime: <this repo>/.rollerskate, or the path selected with --runtime"
].join("\n");

export async function runLocalApp(
  repoRoot: string,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  output: AppOutput = process.stdout,
  dependencies: LocalAppDependencies = {}
): Promise<number> {
  const global = parseGlobalOptions(argv, environment);
  const [command, ...rest] = global.argv;
  if (command === undefined) {
    return runInteractiveCli(
      repoRoot,
      global.runtimeDirectory,
      environment,
      output,
      dependencies
    );
  }
  if (command === "help" || command === "--help" || command === "-h") {
    rejectArguments(rest);
    output.write(`${HELP}\n`);
    return 0;
  }
  switch (command) {
    case "setup": {
      rejectArguments(rest);
      const input = await collectSetupInput(repoRoot, environment);
      const runtime = setupLocalRuntime(repoRoot, input);
      output.write([
        "Rollerskate setup complete.",
        `Runtime: ${runtime.paths.runtimeDirectory}`,
        `Source: ${runtime.config.projectRoot}`,
        "Next: scripts/rollerskate doctor"
      ].join("\n") + "\n");
      return 0;
    }
    case "doctor": {
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--local")) {
        throw new Error("doctor accepts only the optional --local flag");
      }
      const result = await doctorLocalRuntime(repoRoot, {
        includeMatrix: rest[0] !== "--local"
      });
      output.write([
        "Rollerskate is ready.",
        `Runtime: ${result.runtimeDirectory}`,
        `Source: ${result.projectRoot}`,
        result.matrix === undefined
          ? "Matrix: skipped (--local)"
          : `Matrix: ${result.matrix.userId} joined ${result.matrix.roomId}`
      ].join("\n") + "\n");
      return 0;
    }
    case "start": {
      const { noOpen, uiPort } = parseStartOptions(rest);
      return runStartForeground(
        repoRoot,
        global.runtimeDirectory,
        environment,
        output,
        { noOpen, uiPort }
      );
    }
    case "status": {
      rejectArguments(rest);
      const status = runtimeStatus(repoRoot, global.runtimeDirectory);
      output.write(status.state === undefined
        ? [
            "Local Runtime loop: not started",
            ...(status.activity === undefined ? [] : activityLines(status.activity))
          ].join("\n") + "\n"
        : [
            `Local Runtime loop: ${status.running ? "running" : status.state.status}`,
            `PID: ${status.state.pid}`,
            `Runtime: ${status.state.runtimeDirectory}`,
            `Agents: ${status.state.agentNames.join(", ") || "none"}`,
            `Rooms: ${status.state.roomIds.join(", ") || "none"}`,
            `Cycles: ${status.state.cycles}`,
            `Paused: ${status.state.paused ? "yes" : "no"}`,
            ...(status.activity === undefined ? [] : activityLines(status.activity)),
            ...(status.state.error === undefined ? [] : [`Error: ${status.state.error}`])
          ].join("\n") + "\n");
      return 0;
    }
    case "trace":
      requireCount(rest, 1, "trace requires exactly one Event id");
      output.write(`${JSON.stringify(runtimeTrace(repoRoot, rest[0]!, global.runtimeDirectory), null, 2)}\n`);
      return 0;
    case "recover": {
      rejectArguments(rest);
      if (runtimeStatus(repoRoot, global.runtimeDirectory).running) {
        throw new Error("stop the Local Runtime loop before running recovery");
      }
      const reconciled = reconcileRuntime(repoRoot, global.runtimeDirectory);
      output.write(`Reconciled interrupted Runtime work: ${reconciled}\n`);
      return 0;
    }
    case "pause":
    case "resume":
      rejectArguments(rest);
      setLoopPaused(repoRoot, command === "pause", global.runtimeDirectory);
      output.write(`Local Runtime ${command === "pause" ? "paused" : "resumed"}.\n`);
      return 0;
    case "device":
      return runDeviceCommand(
        repoRoot,
        rest,
        environment,
        output,
        global.runtimeDirectory,
        dependencies
      );
    case "workspace":
      return runWorkspaceCommand(repoRoot, rest, output, global.runtimeDirectory);
    case "agent":
      return runAgentCommand(repoRoot, rest, output, global.runtimeDirectory);
    case "subscription":
      return runSubscriptionCommand(repoRoot, rest, output, global.runtimeDirectory);
    case "room":
      return runRoomCommand(repoRoot, rest, output, global.runtimeDirectory);
    case "admin":
      return runAdminCommand(repoRoot, rest, output, global.runtimeDirectory);
    default:
      throw new Error(`unknown command: ${command}; run scripts/rollerskate help`);
  }
}

function runWorkspaceCommand(
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

async function runInteractiveCli(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  environment: NodeJS.ProcessEnv,
  output: AppOutput,
  dependencies: LocalAppDependencies
): Promise<number> {
  if (dependencies.prompts === undefined && !process.stdin.isTTY) {
    throw new Error("interactive CLI requires a terminal; use an explicit subcommand instead");
  }
  const prompts = dependencies.prompts ?? createInterface({
    input: process.stdin,
    output: process.stdout
  });
  let promptsClosed = false;
  const closePrompts = (): void => {
    if (!promptsClosed) {
      prompts.close();
      promptsClosed = true;
    }
  };
  const networkDependencies = {
    ...runtimeDependency(runtimeDirectory),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep })
  };

  try {
    output.write("Rollerskate Local Runtime\n\n");
    const inspection = inspectLocalDevice(repoRoot, runtimeDirectory);
    if (!inspection.hasCredential) {
      output.write("This Local Runtime is not logged in.\n");
      const serverUrl = await askText(
        prompts,
        "Rollerskate Server",
        environment.ROLLERSKATE_SERVER_URL?.trim() ||
          inspection.metadata?.serverUrl ||
          "http://localhost:4100"
      );
      const result = await loginDevice(repoRoot, { serverUrl }, {
        write: (text) => output.write(text),
        ...networkDependencies
      });
      output.write(`${formatDeviceStatus("Device paired.", result)}\n`);
    }

    while (true) {
      const action = await choose(prompts, output, "What would you like to do?", [
        { value: "agent-create", label: "Add an Agent" },
        { value: "agent-list", label: "List Agents" },
        { value: "device-status", label: "Device status" },
        { value: "start", label: "Start the Local Runtime" },
        { value: "rooms", label: "Manage Rooms" },
        { value: "exit", label: "Exit" }
      ]);
      if (action === "exit") return 0;
      if (action === "agent-create") {
        await createAgentInteractively(
          repoRoot,
          runtimeDirectory,
          prompts,
          output,
          networkDependencies
        );
      } else if (action === "agent-list") {
        const agents = await listAgents(repoRoot, networkDependencies);
        output.write(agents.length === 0
          ? "No Agents are registered on this Device.\n\n"
          : `${agents.map((agent) => formatAgentStatus("Agent", agent).trimEnd())
              .join("\n\n")}\n\n`);
      } else if (action === "device-status") {
        output.write(`${formatDeviceStatus(
          "Device is active.",
          await statusDevice(repoRoot, networkDependencies)
        )}\n`);
      } else if (action === "start") {
        closePrompts();
        return runStartForeground(repoRoot, runtimeDirectory, environment, output, {
          noOpen: false,
          uiPort: 4300
        });
      } else {
        await manageRoomsInteractively(repoRoot, runtimeDirectory, prompts, output);
      }
    }
  } finally {
    closePrompts();
  }
}

async function createAgentInteractively(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  prompts: InteractivePrompts,
  output: AppOutput,
  dependencies: ReturnType<typeof runtimeDependency> & {
    readonly fetch?: typeof fetch;
    readonly now?: () => Date;
  }
): Promise<void> {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  const configStore = new AgentConfigStore(paths.agentConfig);
  if (configStore.load() === undefined) {
    const workspaceRoot = await askText(
      prompts,
      "Agent workspace root",
      join(paths.runtimeDirectory, "agents")
    );
    configureAgents(repoRoot, workspaceRoot, runtimeDirectory);
  }
  const name = await askText(prompts, "Agent name");
  const client = await choose<AgentClient>(prompts, output, "Agent client", [
    { value: "codex", label: "Codex" }
  ]);
  output.write(`${formatAgentStatus("Agent created.", await createAgent(
    repoRoot,
    name,
    { ...dependencies, client }
  ))}\n`);
}

async function manageRoomsInteractively(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  prompts: InteractivePrompts,
  output: AppOutput
): Promise<void> {
  while (true) {
    const action = await choose(prompts, output, "Room management", [
      { value: "list", label: "List Rooms" },
      { value: "create", label: "Create a Room" },
      { value: "join", label: "Join a Room" },
      { value: "back", label: "Back" }
    ]);
    if (action === "back") return;
    if (action === "list") {
      await runRoomCommand(repoRoot, ["list"], output, runtimeDirectory);
    } else if (action === "create") {
      const name = await askText(prompts, "Room name");
      const visibility = await choose(prompts, output, "Room visibility", [
        { value: "private", label: "Private" },
        { value: "public", label: "Public" }
      ]);
      await runRoomCommand(
        repoRoot,
        ["create", name, ...(visibility === "public" ? ["--public"] : [])],
        output,
        runtimeDirectory
      );
    } else {
      await runRoomCommand(
        repoRoot,
        ["join", await askText(prompts, "Room ID")],
        output,
        runtimeDirectory
      );
    }
    output.write("\n");
  }
}

async function askText(
  prompts: InteractivePrompts,
  label: string,
  defaultValue?: string
): Promise<string> {
  const suffix = defaultValue === undefined ? ": " : ` [${defaultValue}]: `;
  const answer = (await prompts.question(`${label}${suffix}`)).trim();
  const value = answer || defaultValue;
  if (value === undefined || value === "") throw new Error(`${label} is required`);
  return value;
}

async function choose<T extends string>(
  prompts: InteractivePrompts,
  output: AppOutput,
  title: string,
  options: readonly { readonly value: T; readonly label: string }[]
): Promise<T> {
  while (true) {
    output.write(`${title}\n${options.map((option, index) =>
      `  ${index + 1}. ${option.label}`).join("\n")}\n`);
    const answer = Number.parseInt((await prompts.question("Select: ")).trim(), 10);
    const selected = options[answer - 1];
    if (selected !== undefined) return selected.value;
    output.write("Choose one of the listed numbers.\n\n");
  }
}

function activityLines(activity: NonNullable<ReturnType<typeof runtimeStatus>["activity"]>): string[] {
  return [
    `Events: ${activity.events}`,
    `Executions: ${JSON.stringify(activity.executions)}`,
    `Result Events: ${JSON.stringify(activity.resultEvents)}`,
    `Deliveries: ${JSON.stringify(activity.deliveries)}`,
    `Sessions: ${activity.sessions}`
  ];
}

async function runAgentCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: AppOutput,
  runtimeDirectory?: string
): Promise<number> {
  const [command, ...rest] = arguments_;
  const dependencies = runtimeDependency(runtimeDirectory);
  if (command === "create") {
    const { name, client } = parseAgentCreate(rest);
    output.write(formatAgentStatus("Agent created.", await createAgent(
      repoRoot,
      name,
      { ...dependencies, ...(client === undefined ? {} : { client }) }
    )));
    return 0;
  }
  if (command === "list") {
    rejectArguments(rest);
    const agents = await listAgents(repoRoot, dependencies);
    if (agents.length === 0) {
      output.write("No Agents are registered on this Device.\n");
    } else {
      output.write(`${agents.map((agent) => formatAgentStatus("Agent", agent).trimEnd())
        .join("\n\n")}\n`);
    }
    return 0;
  }
  if (command === "status") {
    if (rest.length !== 1) {
      throw new Error("agent status requires exactly one name");
    }
    output.write(formatAgentStatus("Agent is active.", await statusAgent(
      repoRoot,
      rest[0] ?? "",
      dependencies
    )));
    return 0;
  }
  if (command === "request") {
    const request = parseAgentRequest(rest);
    const receipt = enqueueAgentRequest(repoRoot, request.name, request.prompt, {
      ...dependencies,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId })
    });
    output.write(`${JSON.stringify({
      eventId: receipt.event.eventId,
      executionId: receipt.execution.executionId,
      status: receipt.execution.status,
      ...(receipt.event.sessionId === undefined ? {} : { sessionId: receipt.event.sessionId })
    })}\n`);
    return 0;
  }
  throw new Error("agent requires create, list, status or request");
}

function parseAgentRequest(arguments_: readonly string[]): {
  readonly name: string;
  readonly prompt: string;
  readonly sessionId?: string;
} {
  const name = arguments_[0];
  if (name === undefined || name.trim() === "") {
    throw new Error("agent request requires an Agent name");
  }
  let sessionId: string | undefined;
  const promptParts: string[] = [];
  for (let offset = 1; offset < arguments_.length; offset += 1) {
    const value = arguments_[offset]!;
    if (value === "--session") {
      const candidate = arguments_[offset + 1];
      if (candidate === undefined || candidate.trim() === "") {
        throw new Error("--session requires a local Session ID");
      }
      sessionId = candidate;
      offset += 1;
    } else if (value.startsWith("--")) {
      throw new Error(`unexpected agent request option: ${value}`);
    } else {
      promptParts.push(value);
    }
  }
  const prompt = promptParts.join(" ").trim();
  if (prompt === "") throw new Error("agent request requires a non-empty prompt");
  return { name, prompt, ...(sessionId === undefined ? {} : { sessionId }) };
}

async function runDeviceCommand(
  repoRoot: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  output: AppOutput,
  runtimeDirectory: string | undefined,
  appDependencies: LocalAppDependencies
): Promise<number> {
  const [command, ...rest] = arguments_;
  const dependencies = {
    ...runtimeDependency(runtimeDirectory),
    ...(appDependencies.fetch === undefined ? {} : { fetch: appDependencies.fetch }),
    ...(appDependencies.now === undefined ? {} : { now: appDependencies.now }),
    ...(appDependencies.sleep === undefined ? {} : { sleep: appDependencies.sleep })
  };
  if (command === "login") {
    rejectArguments(rest);
    const serverUrl = environment.ROLLERSKATE_SERVER_URL?.trim();
    const result = await loginDevice(repoRoot, {
      ...(serverUrl === undefined || serverUrl === "" ? {} : { serverUrl })
    }, { write: (text) => output.write(text), ...dependencies });
    output.write(formatDeviceStatus("Device paired.", result));
    return 0;
  }
  if (command === "status") {
    rejectArguments(rest);
    output.write(formatDeviceStatus(
      "Device is active.",
      await statusDevice(repoRoot, dependencies)
    ));
    return 0;
  }
  if (command === "logout") {
    rejectArguments(rest);
    await logoutDevice(repoRoot, dependencies);
    output.write("Device credential revoked and removed from this Local Runtime.\n");
    return 0;
  }
  throw new Error("device requires login, status or logout");
}

function formatDeviceStatus(prefix: string, result: LocalDeviceStatus): string {
  return [
    prefix,
    `Device: ${result.summary.name} (${result.summary.id})`,
    `Human: ${result.summary.human.displayName} (${result.summary.human.id})`,
    `Admin: ${result.summary.human.isAdmin ? "yes" : "no"}`,
    `Server: ${result.metadata.serverUrl}`
  ].join("\n") + "\n";
}

function formatAgentStatus(prefix: string, result: LocalAgentStatus): string {
  return [
    prefix,
    `Agent: ${result.summary.name} (${result.summary.id})`,
    `Status: ${result.summary.status}`,
    `Client: ${result.metadata.client}`,
    `Placement: ${result.summary.placement.id} (generation ${result.summary.placement.generation})`,
    `Workspace: ${result.metadata.workspacePath}`,
    `Owner: ${result.summary.owner.displayName} (${result.summary.owner.id})`
  ].join("\n") + "\n";
}

function parseAgentCreate(arguments_: readonly string[]): {
  readonly name: string;
  readonly client?: "codex";
} {
  const name = arguments_[0];
  if (name === undefined || arguments_.length > 3 ||
    (arguments_.length > 1 && arguments_[1] !== "--client")) {
    throw new Error("agent create requires <name> [--client codex]");
  }
  const client = arguments_[2];
  if (arguments_.length === 2 ||
    (client !== undefined && client !== "codex")) {
    throw new Error("--client must be codex");
  }
  return {
    name,
    ...(client === undefined ? {} : { client })
  };
}

async function collectSetupInput(
  repoRoot: string,
  environment: NodeJS.ProcessEnv
): Promise<SetupInput> {
  let prompts: Interface | undefined;
  const ask = async (
    environmentName: string,
    label: string,
    defaultValue?: string
  ): Promise<string> => {
    const configured = environment[environmentName]?.trim();
    if (configured !== undefined && configured !== "") {
      return configured;
    }
    if (!process.stdin.isTTY) {
      throw new Error(`${environmentName} is required for non-interactive setup`);
    }
    prompts ??= createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultValue === undefined ? ": " : ` [${defaultValue}]: `;
    const answer = (await prompts.question(`${label}${suffix}`)).trim();
    if (answer !== "") {
      return answer;
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`${label} is required`);
  };

  try {
    const projectRoot = await ask(
      "ROLLERSKATE_PROJECT_ROOT",
      "Local source directory",
      realpathSync(repoRoot)
    );
    const defaultCodex = findExecutable("codex", environment.PATH);
    const codexExecutable = await ask(
      "ROLLERSKATE_CODEX_EXECUTABLE",
      "Codex executable",
      defaultCodex
    );
    const homeserver = await ask(
      "ROLLERSKATE_MATRIX_HOMESERVER",
      "Matrix homeserver"
    );
    const roomId = await ask("ROLLERSKATE_MATRIX_ROOM_ID", "Matrix room ID");
    const ownerUserId = await ask(
      "ROLLERSKATE_MATRIX_OWNER_USER",
      "Your Matrix user ID"
    );
    const agentUserId = await ask(
      "ROLLERSKATE_MATRIX_AGENT_USER",
      "Agent Matrix user ID"
    );
    prompts?.close();
    prompts = undefined;
    const configuredToken = environment.ROLLERSKATE_MATRIX_ACCESS_TOKEN?.trim();
    const matrixAccessToken = configuredToken === undefined || configuredToken === ""
      ? await promptSecret("Agent access token (hidden): ")
      : configuredToken;
    return {
      homeserver,
      roomId,
      ownerUserId,
      agentUserId,
      matrixAccessToken,
      projectRoot,
      codexExecutable
    };
  } finally {
    prompts?.close();
  }
}

async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY || process.stdin.setRawMode === undefined) {
    throw new Error(
      "ROLLERSKATE_MATRIX_ACCESS_TOKEN is required for non-interactive setup"
    );
  }
  process.stdout.write(label);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolvePromise, rejectPromise) => {
    let value = "";
    const finish = (error?: Error): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(wasRaw);
      process.stdout.write("\n");
      if (error !== undefined) {
        rejectPromise(error);
      } else if (value.trim() === "") {
        rejectPromise(new Error("Agent access token is required"));
      } else {
        resolvePromise(value);
      }
    };
    const onData = (chunk: Buffer): void => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          finish(new Error("setup cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
        } else {
          value += character;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

interface StartOptions {
  readonly noOpen: boolean;
  readonly uiPort: number;
}

async function runStartForeground(
  repoRoot: string,
  runtimeDirectory: string | undefined,
  environment: NodeJS.ProcessEnv,
  output: AppOutput,
  startOptions: StartOptions
): Promise<number> {
  const codexExecutable = environment.ROLLERSKATE_CODEX_EXECUTABLE?.trim() ||
    findExecutable("codex", environment.PATH);
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const log = createWriteStream(paths.daemonLog, { flags: "a", mode: 0o600 });
  const sink: AppOutput = {
    write(text) {
      output.write(text);
      log.write(text);
    }
  };
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  sink.write("Rollerskate starting. Press Ctrl-C to stop.\n");
  sink.write(`Log: ${paths.daemonLog}\n`);

  let uiUrl: string | undefined;
  let uiClose: (() => Promise<void>) | undefined;
  try {
    const ui = await startUiServer({
      repoRoot,
      ...(runtimeDirectory === undefined ? {} : { runtimeDirectory }),
      port: startOptions.uiPort,
      signal: controller.signal,
      output: sink
    });
    uiUrl = ui.url;
    uiClose = ui.close;
    sink.write(`Rollerskate UI: ${ui.url}\n`);
    if (!startOptions.noOpen) {
      openBrowser(ui.url, sink);
    }
  } catch (error) {
    sink.write(`Local UI failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    stop();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    log.end();
    return 1;
  }

  try {
    const result = await startRuntime({
      repoRoot,
      ...(runtimeDirectory === undefined ? {} : { runtimeDirectory }),
      ...(codexExecutable === undefined ? {} : { codexExecutable }),
      environment: roomAgentEnvironment(environment),
      output: sink
    }, controller.signal);
    sink.write(`Rollerskate stopped after ${result.cycles} Runtime cycle(s).\n`);
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (uiClose !== undefined) {
      await uiClose();
    }
    log.end();
  }
}

function openBrowser(url: string, output: AppOutput): void {
  const platform = process.platform;
  const child = platform === "darwin"
    ? spawn("open", [url], { stdio: "ignore", detached: true })
    : platform === "win32"
      ? spawn("cmd", ["/c", "start", url], { stdio: "ignore", detached: true })
      : spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  child.on("error", () => {
    output.write(`Warning: could not open browser; visit ${url} manually.\n`);
  });
}

export function roomAgentEnvironment(
  environment: NodeJS.ProcessEnv
): Readonly<Record<string, string>> {
  const home = environment.HOME?.trim();
  if (home === undefined || home === "") throw new Error("HOME is required to start Rollerskate");
  const path = environment.PATH?.trim();
  if (path === undefined || path === "") throw new Error("PATH is required to start Rollerskate");
  return {
    HOME: home,
    PATH: path,
    ...(environment.CODEX_HOME === undefined ? {} : { CODEX_HOME: environment.CODEX_HOME })
  };
}

function findExecutable(name: string, pathValue: string | undefined): string | undefined {
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

function rejectArguments(arguments_: readonly string[]): void {
  if (arguments_.length > 0) {
    throw new Error(`unexpected arguments: ${arguments_.join(" ")}`);
  }
}

function requireCount(arguments_: readonly string[], count: number, message: string): void {
  if (arguments_.length !== count) throw new Error(message);
}

function runtimeDependency(runtimeDirectory: string | undefined): {
  readonly runtimeDirectory?: string;
} {
  return runtimeDirectory === undefined ? {} : { runtimeDirectory };
}

function parseStartOptions(argv: readonly string[]): StartOptions {
  let noOpen = false;
  let uiPort = 4300;
  let offset = 0;
  while (offset < argv.length) {
    const arg = argv[offset];
    if (arg === "--no-open") {
      noOpen = true;
      offset += 1;
    } else if (arg === "--ui-port") {
      const value = argv[offset + 1];
      if (value === undefined || value.trim() === "") {
        throw new Error("--ui-port requires a port number");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
        throw new Error("--ui-port must be an integer between 1 and 65535");
      }
      uiPort = parsed;
      offset += 2;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return { noOpen, uiPort };
}

function parseGlobalOptions(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv
): GlobalOptions {
  let runtimeDirectory = environment.ROLLERSKATE_RUNTIME_DIR?.trim() || undefined;
  let offset = 0;
  if (argv[0] === "--runtime") {
    const value = argv[1];
    if (value === undefined || value.trim() === "") {
      throw new Error("--runtime requires an absolute path");
    }
    runtimeDirectory = value;
    offset = 2;
  }
  return {
    argv: argv.slice(offset),
    ...(runtimeDirectory === undefined ? {} : { runtimeDirectory })
  };
}

function resolveRepoRoot(): string {
  const configured = process.env.ROLLERSKATE_REPO_ROOT;
  if (configured !== undefined && configured.trim() !== "") {
    return realpathSync(configured);
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  runLocalApp(resolveRepoRoot(), process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `rollerskate: ${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exitCode = 1;
    }
  );
}
