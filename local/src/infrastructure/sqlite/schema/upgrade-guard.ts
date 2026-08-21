import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export function assertNoLiveRuntimeSchemaUpgrade(
  database: DatabaseSync,
  declaredVersion: number | undefined,
  targetVersion: number
): void {
  if (declaredVersion === undefined || declaredVersion >= targetVersion) return;
  const databasePath = mainDatabasePath(database);
  if (databasePath === undefined) return;
  const lockPath = join(dirname(databasePath), "loop-state.json.lock");
  if (!existsSync(lockPath)) return;
  let pid: number;
  try {
    pid = Number(readFileSync(lockPath, "utf8").trim());
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) return;
  throw new Error(
    `Cannot upgrade Local database schema ${declaredVersion} to ${targetVersion} ` +
    `while Runtime pid ${pid} is running; stop and restart Runtime first`
  );
}

function mainDatabasePath(database: DatabaseSync): string | undefined {
  const rows = database.prepare("PRAGMA database_list").all() as unknown as Array<{
    name: string;
    file: string;
  }>;
  const path = rows.find((row) => row.name === "main")?.file.trim();
  return path === undefined || path === "" ? undefined : resolve(path);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
