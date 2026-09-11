import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertCommandId, readCommandReceipt } from "../../infrastructure/command/receipt.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";

export function commandCompletion(receiptRoot: string, commandId: string) {
  assertCommandId(commandId);
  const directory = join(receiptRoot, commandId);
  return { ...readCommandReceipt(directory, commandId),
    logPath: join(directory, "output.log"), receiptPath: join(directory, "receipt.json") };
}

export function inspectCommand(repoRoot: string, commandId: string, runtimeDirectory?: string) {
  const root = join(runtimePaths(repoRoot, runtimeDirectory).runtimeDirectory, "commands");
  const completion = commandCompletion(root, commandId);
  const requestPath = join(root, commandId, "request.json");
  if (!statSync(requestPath).isFile() || statSync(requestPath).size > 65_536) throw new Error("command request must be a bounded regular file");
  const request = JSON.parse(readFileSync(requestPath, "utf8")) as { schemaVersion: string; commandId: string; subscriptionId: string; threadId?: string };
  if (request === null || !["ShellCommandRequest@1", "ShellCommandRequest@2"].includes(request.schemaVersion) ||
    request.commandId !== commandId || typeof request.subscriptionId !== "string" ||
    (request.threadId !== undefined && typeof request.threadId !== "string")) throw new Error("Command request identity or schema mismatch");
  return { ...completion, subscriptionId: request.subscriptionId, threadId: request.threadId };
}
