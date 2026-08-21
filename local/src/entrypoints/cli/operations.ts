import {
  grantOwnerWideActivityAccess,
  inspectActivityAccess,
  revokeOwnerWideActivityAccess
} from "../../application/activity/control.js";
import { eventTrace, listEventTraces } from "../../application/event/query.js";
import {
  acknowledgeNotice,
  markNoticeRead,
  rebuildNoticeIndex
} from "../../application/notice/control.js";
import {
  inspectNoticeView,
  listNoticeViews
} from "../../application/notice/query.js";
import {
  inspectRuntimeFailure,
  listRuntimeFailures
} from "../../application/runtime/failure-query.js";
import { runtimeWorkloadStatus } from "../../application/runtime/workload-query.js";
import type { AppOutput } from "./shared.js";
import {
  parseBoundedInteger,
  rejectArguments,
  requireCount,
  runtimeDependency
} from "./shared.js";

export function runActivityCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: AppOutput,
  runtimeDirectory?: string
): number {
  const [group, command, handle, ...rest] = arguments_;
  if (group !== "access" || handle === undefined || rest.length !== 0 ||
    (command !== "grant" && command !== "status" && command !== "revoke")) {
    throw new Error("activity access requires grant, status or revoke and one Agent handle");
  }
  const options = runtimeDependency(runtimeDirectory);
  const result = command === "grant"
    ? grantOwnerWideActivityAccess(repoRoot, handle, options)
    : command === "revoke"
      ? revokeOwnerWideActivityAccess(repoRoot, handle, options)
      : inspectActivityAccess(repoRoot, handle, options);
  output.write(`${JSON.stringify(result ?? {
    agent: handle,
    scope: "owner-wide-read",
    status: "not-granted"
  }, null, 2)}\n`);
  return 0;
}

export function runEventCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: AppOutput,
  runtimeDirectory?: string
): number {
  const [command, ...rest] = arguments_;
  if (command === "list") {
    rejectArguments(rest);
    output.write(`${JSON.stringify(listEventTraces(repoRoot, runtimeDirectory), null, 2)}\n`);
    return 0;
  }
  if (command === "trace") {
    requireCount(rest, 1, "event trace requires exactly one Event id");
    output.write(`${JSON.stringify(eventTrace(repoRoot, rest[0]!, runtimeDirectory), null, 2)}\n`);
    return 0;
  }
  throw new Error("event requires list or trace");
}

export function runWorkloadCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: AppOutput,
  runtimeDirectory?: string
): number {
  if (arguments_[0] !== "status" || arguments_.length !== 1) {
    throw new Error("workload requires status");
  }
  const workload = runtimeWorkloadStatus(repoRoot, runtimeDirectory);
  output.write([
    `Loop workload: ${workload.state}`,
    `Ready: ${workload.ready}`,
    `Running: ${workload.running}`,
    `Retrying: ${workload.retrying}`,
    `Total: ${workload.total}`,
    `As of: ${workload.asOf}`
  ].join("\n") + "\n");
  return 0;
}

export function runFailureCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: AppOutput,
  runtimeDirectory?: string
): number {
  const [command, ...rest] = arguments_;
  if (command === "list") {
    rejectArguments(rest);
    output.write(`${JSON.stringify(listRuntimeFailures(
      repoRoot,
      runtimeDirectory
    ), null, 2)}\n`);
    return 0;
  }
  if (command === "inspect") {
    requireCount(rest, 1, "failure inspect requires exactly one failure ref");
    output.write(`${JSON.stringify(inspectRuntimeFailure(
      repoRoot,
      rest[0]!,
      runtimeDirectory
    ), null, 2)}\n`);
    return 0;
  }
  throw new Error("failure requires list or inspect");
}

export function runNoticeCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: AppOutput,
  runtimeDirectory?: string
): number {
  const [command, ...rest] = arguments_;
  if (command === "list") {
    let limit = 100;
    if (rest.length !== 0) {
      if (rest.length !== 2 || rest[0] !== "--limit") {
        throw new Error("notice list accepts only --limit <1-1000>");
      }
      limit = parseBoundedInteger(rest[1]!, "notice list limit", 1, 1_000);
    }
    output.write(`${JSON.stringify(listNoticeViews(
      repoRoot,
      runtimeDirectory,
      limit
    ), null, 2)}\n`);
    return 0;
  }
  if (command === "inspect") {
    requireCount(rest, 1, "notice inspect requires exactly one Notice id");
    output.write(`${JSON.stringify(inspectNoticeView(
      repoRoot,
      rest[0]!,
      runtimeDirectory
    ), null, 2)}\n`);
    return 0;
  }
  if (command === "mark-read" || command === "ack") {
    requireCount(rest, 1, `notice ${command} requires exactly one Notice id`);
    const detail = command === "mark-read"
      ? markNoticeRead(repoRoot, rest[0]!, runtimeDirectory)
      : acknowledgeNotice(repoRoot, rest[0]!, runtimeDirectory);
    output.write(`${JSON.stringify(detail, null, 2)}\n`);
    return 0;
  }
  if (command === "rebuild") {
    rejectArguments(rest);
    output.write(`${JSON.stringify(
      rebuildNoticeIndex(repoRoot, runtimeDirectory),
      null,
      2
    )}\n`);
    return 0;
  }
  throw new Error("notice requires list, inspect, mark-read, ack, or rebuild");
}
