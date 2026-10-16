import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimePaths } from "../../infrastructure/runtime/config.js";

export function cliUsageDirectory(repoRoot: string, runtimeDirectory?: string): string {
  return runtimePaths(repoRoot, runtimeDirectory).runtimeDirectory;
}

const WINDOW_DAYS = 30;
const DAY = 24 * 60 * 60 * 1_000;
const GROUP_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  "run-log": ["--help", "list", "read", "payload", "stats", "compress", "cleanup"],
  activity: ["access grant", "access status", "access revoke"],
  admin: ["allow"],
  agent: ["create", "configure", "list", "status", "rename", "suspend", "resume", "request", "profile inspect", "profile update"],
  chat: ["schedule status", "schedule create", "schedule pause", "schedule resume", "schedule cancel", "governance", "pause", "resume", "participant add", "participant remove", "post", "history", "status", "presence set", "session new"],
  channel: ["bind", "send", "status", "follow", "revoke", "stop"],
  command: ["inspect"],
  device: ["login", "status", "logout"],
  event: ["list", "trace"],
  failure: ["list", "inspect", "retry"],
  notice: ["list", "inspect", "mark-read", "ack", "rebuild"],
  room: ["create", "list", "join", "invite-human", "add-agent", "set-wake", "remove-agent", "bindings", "policy", "send", "agent-send", "history"],
  run: ["--help", "validate", "steward-policy", "steward-stats", "preflight", "start", "pipeline", "list", "legacy-inventory", "legacy-migration-plan", "legacy-migrate", "inspect", "outcome", "trace", "decide", "retry-orchestrator", "close", "cancel", "archive", "unarchive"],
  schedule: ["--help", "create", "update", "register-workflow", "register-reminder", "list", "inspect", "pause", "resume", "cancel", "run-now", "migrate-workflow", "occurrences", "runs", "trace", "resolve"],
  subscription: ["--help", "register-desktop", "receipt", "deliveries", "register-file", "recover-file", "recoveries", "add", "list", "inspect", "history", "pause", "resume", "cancel", "run-monitors", "resume-readback", "notifications inspect", "notifications mute", "notifications resume", "notifications close"],
  topic: ["list", "history", "server-list", "create", "profile update", "join", "publish"],
  "work-request": ["inspect", "accept", "reject", "await-owner"],
  workspace: ["set"],
  workload: ["status"]
};

const ROOT_COMMANDS = [
  "--help", "usage", "setup", "doctor", "status", "trace", "recover", "pause", "resume",
  "start", "restart", "stop", "codex-push", "admin", "activity", "agent", "chat",
  "channel", "command", "device", "event", "failure", "notice", "room", "run",
  "schedule", "subscription", "topic", "work-request", "workspace", "workload", "run-log"
] as const;

export interface CliUsageRecord {
  readonly command: string;
  readonly at: string;
  readonly durationMilliseconds: number;
  readonly exitCode: number;
  readonly source: "unknown";
}

export function resolveUsageCommand(
  arguments_: readonly string[],
  registeredRoots?: ReadonlySet<string>
): string | undefined {
  const [root, ...rest] = arguments_;
  if (root === undefined || root === "usage") return undefined;
  const registered = registeredRoots?.has(root) ?? (ROOT_COMMANDS as readonly string[]).includes(root);
  if (registered || ["--help", "start", "restart", "stop", "codex-push"].includes(root)) {
    if (root === "--help" || root === "codex-push" || !GROUP_COMMANDS[root]) return root;
    const candidates = GROUP_COMMANDS[root]!;
    if (rest[0] === "--help") return candidates.includes("--help") ? `${root} --help` : undefined;
    const leaf = root === "agent" && rest[0] === "profile"
      ? `profile ${rest[2] === "update" ? "update" : "inspect"}`
      : root === "topic" && rest[0] === "profile"
        ? `profile ${rest[1] ?? ""}`
        : root === "activity"
          ? `${rest[0] ?? ""} ${rest[1] ?? ""}`.trim()
          : root === "chat" && ["participant", "presence", "session", "schedule"].includes(rest[0] ?? "")
            ? `${rest[0]} ${rest[1] ?? ""}`.trim()
            : rest[0];
    return candidates.includes(leaf ?? "") ? `${root} ${leaf}` : undefined;
  }
  return undefined;
}

export function registeredUsageCommands(): readonly string[] {
  return [
    ...ROOT_COMMANDS.filter((root) => !GROUP_COMMANDS[root]),
    ...Object.entries(GROUP_COMMANDS).flatMap(([group, commands]) =>
      commands.map((command) => `${group} ${command}`))
  ];
}

export function appendCliUsage(
  runtimeDirectory: string,
  record: CliUsageRecord
): void {
  try {
    if (!registeredUsageCommands().includes(record.command)) return;
    const logsDirectory = join(runtimeDirectory, "logs");
    mkdirSync(logsDirectory, { recursive: true, mode: 0o700 });
    const safeRecord: CliUsageRecord = {
      command: record.command,
      at: record.at,
      durationMilliseconds: record.durationMilliseconds,
      exitCode: record.exitCode,
      source: "unknown"
    };
    appendFileSync(join(logsDirectory, "cli-usage.jsonl"), `${JSON.stringify(safeRecord)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  } catch {
    // Usage logging is best-effort and must not change CLI behavior.
  }
}

export function renderCliUsage(runtimeDirectory: string, now = new Date()): string {
  const path = join(runtimeDirectory, "logs", "cli-usage.jsonl");
  let records: CliUsageRecord[] = [];
  let readStatus: "available" | "not_started" | "unavailable" = "available";
  try {
    records = readFileSync(path, "utf8").split(/\r?\n/u).flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return isUsageRecord(value) ? [value] : [];
      } catch { return []; }
    });
  } catch (error) {
    readStatus = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_started" : "unavailable";
  }

  const start = now.getTime() - WINDOW_DAYS * DAY;
  const recent = records.filter((record) => {
    const timestamp = Date.parse(record.at);
    return Number.isFinite(timestamp) && timestamp >= start && timestamp <= now.getTime();
  });
  const details = registeredUsageCommands().map((command) => {
    const matching = recent.filter((record) => record.command === command);
    return {
      command,
      calls: matching.length,
      activeDays: new Set(matching.map((record) => record.at.slice(0, 10))).size,
      lastUsed: matching.map((record) => record.at).sort().at(-1) ?? null,
      exitCodes: countExitCodes(matching)
    };
  });
  const groups = Object.keys(GROUP_COMMANDS).map((command) => {
    const children = details.filter((entry) => entry.command.startsWith(`${command} `));
    const matching = recent.filter((record) => record.command.startsWith(`${command} `));
    return {
      command,
      calls: matching.length,
      activeDays: new Set(matching.map((record) => record.at.slice(0, 10))).size,
      lastUsed: matching.map((record) => record.at).sort().at(-1) ?? null,
      exitCodes: countExitCodes(matching),
      children: children.map(({ command: child, ...usage }) => ({ command: child.slice(command.length + 1), ...usage }))
    };
  });
  const firstRecord = records.map((record) => record.at).sort().at(0) ?? null;
  return `${JSON.stringify({
    window: { from: new Date(start).toISOString(), to: now.toISOString(), days: WINDOW_DAYS },
    recordingSince: firstRecord,
    source: "unknown",
    aggregation: "Group totals include their listed subcommands; do not add group and child counts together.",
    coverage: "Local CLI invocations that match the registered command whitelist since recording began; calls before installation, unmatched invocations, background Runtime work, and source identity are not covered. Logging is best-effort.",
    readStatus,
    groups,
    commands: details.filter((entry) =>
      !Object.keys(GROUP_COMMANDS).some((group) => entry.command.startsWith(`${group} `)))
  }, null, 2)}\n`;
}

function countExitCodes(records: readonly CliUsageRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) counts[String(record.exitCode)] = (counts[String(record.exitCode)] ?? 0) + 1;
  return counts;
}

function isUsageRecord(value: unknown): value is CliUsageRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.command === "string" && registeredUsageCommands().includes(record.command) &&
    typeof record.at === "string" && Number.isFinite(Date.parse(record.at)) &&
    typeof record.durationMilliseconds === "number" && Number.isFinite(record.durationMilliseconds) &&
    typeof record.exitCode === "number" && Number.isInteger(record.exitCode) && record.source === "unknown";
}
