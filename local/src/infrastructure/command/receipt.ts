import { constants, closeSync, fstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CommandReceipt {
  readonly schemaVersion: "ShellCommandReceipt@1";
  readonly commandId: string;
  readonly state: "running" | "completed";
  readonly startedAt: string;
  readonly pid?: number;
  readonly completedAt?: string;
  readonly outcome?: "success" | "failure" | "cancelled";
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly error?: string;
}

export function assertCommandId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
    throw new Error("command ID must use 1-128 safe characters and start with a letter or digit");
  }
}

export function writeCommandReceipt(directory: string, receipt: CommandReceipt): void {
  const path = join(directory, "receipt.json");
  const temporary = join(directory, `receipt.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

export function readCommandReceipt(directory: string, commandId: string): CommandReceipt {
  const fd = openSync(join(directory, "receipt.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384) throw new Error("command receipt must be a bounded regular file");
    const receipt = JSON.parse(readFileSync(fd, "utf8")) as CommandReceipt;
    if (receipt === null || receipt.schemaVersion !== "ShellCommandReceipt@1" || receipt.commandId !== commandId ||
      !["running", "completed"].includes(receipt.state) || typeof receipt.startedAt !== "string") {
      throw new Error("command receipt identity or schema mismatch");
    }
    if (receipt.state === "completed" && (typeof receipt.completedAt !== "string" ||
      !["success", "failure", "cancelled"].includes(receipt.outcome ?? "") ||
      (receipt.exitCode !== null && (!Number.isInteger(receipt.exitCode) || receipt.exitCode! < 0)) ||
      (receipt.outcome === "success" && (receipt.exitCode !== 0 || receipt.signal != null)))) {
      throw new Error("command receipt has no valid terminal outcome");
    }
    return receipt;
  } finally { closeSync(fd); }
}
