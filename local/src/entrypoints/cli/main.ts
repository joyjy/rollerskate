#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { eventTrace } from "../../application/event/query.js";
import {
  assertRuntimeSchemaUpgradeAllowed,
  controlRuntime,
  setupRuntime
} from "../../application/runtime/control.js";
import { doctorLocalRuntime } from "../../application/runtime/doctor.js";
import { runtimeOperationsView } from "../../application/runtime/query.js";
import { runAgentCommand, runWorkspaceCommand } from "./agent.js";
import { runChatCommand } from "./chat.js";
import { runChannelCommand } from "./channel.js";
import { runDeviceCommand } from "./device.js";
import {
  runActivityCommand,
  runEventCommand,
  runFailureCommand,
  runNoticeCommand,
  runWorkloadCommand
} from "./operations.js";
import { runAdminCommand, runRoomCommand } from "./room.js";
import { runStewardCommand } from "./run.js";
import { runScheduleCommand } from "./schedule.js";
import { collectSetupInput } from "./setup.js";
import type { AppOutput, LocalAppDependencies } from "./shared.js";
import { rejectArguments, requireCount } from "./shared.js";
import { parseStartOptions, runStartForeground } from "./start.js";
import { runSubscriptionCommand } from "./subscription.js";
import { runTopicCommand } from "./topic.js";
import { runWorkRequestCommand } from "./work-request.js";

export type {
  InteractivePrompts,
  LocalAppDependencies
} from "./shared.js";
export { roomAgentEnvironment } from "./start.js";

interface GlobalOptions {
  readonly argv: readonly string[];
  readonly runtimeDirectory?: string;
}

const HELP = [
  "Rollerskate MVP",
  "",
  "Usage:",
  "  scripts/rs [--runtime <absolute-path>] [command]",
  "  scripts/rs --help",
  "  scripts/rs start [--no-open] [--ui-port <port>]  run Local Runtime loop + Vite Console",
  "  scripts/rs doctor --local  validate Local-first state without legacy Matrix config",
  "  scripts/rs status         inspect Local Runtime loop state",
  "  scripts/rs trace <event-id>",
  "  scripts/rs event list|trace ...",
  "  scripts/rs workload status",
  "  scripts/rs failure list|inspect ...",
  "  scripts/rs recover        reconcile interrupted Runtime work",
  "  scripts/rs pause          pause Local Runtime cycles",
  "  scripts/rs resume         resume Local Runtime cycles",
  "  scripts/rs agent create <handle> --client <codex|claude-code|kimi-code|pi> [--launch-arg <arg>]...",
  "  scripts/rs agent configure <handle> [--launch-arg <arg>]...  replace launch args; omit to clear",
  "  scripts/rs agent status <handle>",
  "  scripts/rs agent list",
  "  scripts/rs agent rename <handle> <new-handle>",
  "  scripts/rs agent suspend|resume <handle>",
  "  scripts/rs agent request <name> [--session <ses_uuidv7>] <prompt...>",
  "  scripts/rs agent profile <handle> [update <json-file>]",
  "  scripts/rs activity access grant|status|revoke <agent-handle>",
  "  scripts/rs topic list|history [topic-id]  inspect passive Server Topic inbox",
  "  scripts/rs topic server-list              list Topics from the connected Server",
  "  scripts/rs topic create <json-file>",
  "  scripts/rs topic profile update <topic-id> <json-file>",
  "  scripts/rs topic join <topic-id> <agent-handle>",
  "  scripts/rs topic publish <topic-id> <agent-handle> <transaction-id> <message...>",
  "  scripts/rs chat post <message...>",
  "  scripts/rs chat history [--before <event-id>] [--limit <1-200>]",
  "  scripts/rs chat status",
  "  scripts/rs chat governance",
  "  scripts/rs chat pause|resume --revision <revision>",
  "  scripts/rs chat resume-and-wake --revision <revision> --idempotency-key <key>",
  "  scripts/rs chat participant add|remove <handle> --revision <revision>",
  "  scripts/rs chat free status|start|continue-now|exit ...",
  "  scripts/rs chat presence set <handle> --scope <topic|global> --mode <available|snoozed> [--until <iso>] [--wake-keyword <literal>]...",
  "  scripts/rs chat session new <handle>",
  "  scripts/rs channel bind|send|status|follow|revoke|stop ...",
  "  scripts/rs notice list [--limit <1-1000>]",
  "  scripts/rs notice inspect <notice-id>",
  "  scripts/rs notice mark-read|ack <notice-id>",
  "  scripts/rs notice rebuild",
  "  scripts/rs subscription add <json-file>",
  "  scripts/rs subscription list|inspect|pause|resume|cancel ...",
  "  scripts/rs schedule create|update|list|inspect ...",
  "  scripts/rs schedule pause|resume|cancel|run-now|runs|trace|resolve ...",
  "  scripts/rs run start|list|inspect|trace|decide|close|cancel ...",
  "  scripts/rs work-request inspect|accept|reject|await-owner ...",
  "",
  "Runtime: ~/.rollerskate, or the path selected with --runtime"
].join("\n");

const RUNTIME_COMMANDS = new Set([
  "setup", "doctor", "status", "trace", "event", "workload", "failure",
  "recover", "pause", "resume", "device", "workspace", "agent", "activity",
  "topic", "notice", "chat", "channel", "subscription", "schedule", "run",
  "work-request", "room", "admin"
]);

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
    throw new Error("command required; run scripts/rs --help");
  }
  if (command === "--help") {
    rejectArguments(rest);
    output.write(`${HELP}\n`);
    return 0;
  }
  if (command === "start") {
    const { noOpen, uiPort } = parseStartOptions(rest);
    assertRuntimeSchemaUpgradeAllowed(repoRoot, global.runtimeDirectory);
    return runStartForeground(
      repoRoot,
      global.runtimeDirectory,
      environment,
      output,
      { noOpen, uiPort }
    );
  }
  if (!RUNTIME_COMMANDS.has(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  assertRuntimeSchemaUpgradeAllowed(repoRoot, global.runtimeDirectory);
  switch (command) {
    case "setup": {
      rejectArguments(rest);
      const input = await collectSetupInput(repoRoot, environment);
      const runtime = setupRuntime(
        repoRoot,
        input,
        new Date().toISOString(),
        global.runtimeDirectory
      );
      output.write([
        "Rollerskate setup complete.",
        `Runtime: ${runtime.paths.runtimeDirectory}`,
        `Source: ${runtime.config.projectRoot}`,
        "Next: scripts/rs doctor"
      ].join("\n") + "\n");
      return 0;
    }
    case "doctor": {
      if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--local")) {
        throw new Error("doctor accepts only the optional --local flag");
      }
      const result = await doctorLocalRuntime(repoRoot, {
        includeMatrix: rest[0] !== "--local",
        ...(global.runtimeDirectory === undefined
          ? {}
          : { runtimeDirectory: global.runtimeDirectory })
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
    case "status": {
      rejectArguments(rest);
      const status = runtimeOperationsView(repoRoot, global.runtimeDirectory, "");
      output.write([
        `Local Runtime: ${status.status}`,
        `Core Loop: ${status.loop.phase}`,
        `PID: ${status.pid ?? "none"}`,
        `Cycles: ${status.loop.totalCycles}`,
        `Workload: ${status.workload.state}`,
        `Failures: ${status.failures.length}`,
        `Reason: ${status.statusReason}`
      ].join("\n") + "\n");
      return 0;
    }
    case "trace":
      requireCount(rest, 1, "trace requires exactly one Event id");
      output.write(`${JSON.stringify(
        eventTrace(repoRoot, rest[0]!, global.runtimeDirectory),
        null,
        2
      )}\n`);
      return 0;
    case "event":
      return runEventCommand(repoRoot, rest, output, global.runtimeDirectory);
    case "workload":
      return runWorkloadCommand(repoRoot, rest, output, global.runtimeDirectory);
    case "failure":
      return runFailureCommand(repoRoot, rest, output, global.runtimeDirectory);
    case "recover": {
      rejectArguments(rest);
      const result = controlRuntime(repoRoot, "recover", global.runtimeDirectory);
      output.write(`${result.message}\n`);
      return 0;
    }
    case "pause":
    case "resume":
      rejectArguments(rest);
      output.write(`${controlRuntime(repoRoot, command, global.runtimeDirectory).message}\n`);
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
      return runAgentCommand(repoRoot, rest, output, global.runtimeDirectory, dependencies);
    case "activity":
      return runActivityCommand(repoRoot, rest, output, global.runtimeDirectory);
    case "topic":
      return runTopicCommand(repoRoot, rest, output, {
        ...(global.runtimeDirectory === undefined
          ? {}
          : { runtimeDirectory: global.runtimeDirectory }),
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
        ...(dependencies.cwd === undefined ? {} : { cwd: dependencies.cwd })
      });
    case "notice":
      return runNoticeCommand(repoRoot, rest, output, global.runtimeDirectory);
    case "chat":
      return runChatCommand(repoRoot, rest, output, global.runtimeDirectory);
    case "channel":
      return runChannelCommand(
        repoRoot, rest, output, global.runtimeDirectory, dependencies
      );
    case "subscription":
      return runSubscriptionCommand(
        repoRoot,
        rest,
        output,
        global.runtimeDirectory,
        dependencies.cwd ?? process.cwd()
      );
    case "schedule":
      return runScheduleCommand(repoRoot, rest, output, global.runtimeDirectory);
    case "run":
      return runStewardCommand(repoRoot, rest, output, global.runtimeDirectory);
    case "work-request":
      return runWorkRequestCommand(
        repoRoot, rest, output, global.runtimeDirectory, dependencies
      );
    case "room":
      return runRoomCommand(repoRoot, rest, output, global.runtimeDirectory);
    case "admin":
      return runAdminCommand(repoRoot, rest, output, global.runtimeDirectory);
    default:
      throw new Error(`unknown command: ${command}; run scripts/rs --help`);
  }
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
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
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
