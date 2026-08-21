import {
  decideWorkRequest,
  inspectWorkRequest
} from "../../application/work-request/control.js";
import type { AppOutput, LocalAppDependencies } from "./shared.js";

export async function runWorkRequestCommand(
  repoRoot: string,
  arguments_: readonly string[],
  output: AppOutput,
  runtimeDirectory: string | undefined,
  dependencies: LocalAppDependencies
): Promise<number> {
  if (arguments_[0] === "inspect") {
    if (arguments_.length !== 3) {
      throw new Error("work-request inspect requires <agent-handle> <request-id>");
    }
    const request = await inspectWorkRequest(
      repoRoot,
      arguments_[1]!,
      arguments_[2]!,
      {
        ...(runtimeDirectory === undefined ? {} : { runtimeDirectory }),
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
      }
    );
    output.write(`${JSON.stringify(request, null, 2)}\n`);
    return 0;
  }
  const [decision, agentHandle, workRequestId, revisionFlag, revisionValue, ...rest] = arguments_;
  if ((decision !== "accept" && decision !== "reject" && decision !== "await-owner") ||
    agentHandle === undefined || workRequestId === undefined || revisionFlag !== "--revision" ||
    revisionValue === undefined || rest.length !== 0) {
    throw new Error(
      "work-request requires inspect or accept|reject|await-owner <agent-handle> <request-id> --revision <revision>"
    );
  }
  const expectedRevision = Number(revisionValue);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error("work-request revision must be a positive integer");
  }
  const result = await decideWorkRequest(repoRoot, {
    agentHandle,
    workRequestId,
    expectedRevision,
    decision: decision === "accept"
      ? "accepted"
      : decision === "reject" ? "rejected" : "awaiting-owner"
  }, {
    ...(runtimeDirectory === undefined ? {} : { runtimeDirectory }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch })
  });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}
