import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** One bounded proposal snapshot per Run; Run lifecycle remains in AgentRunStore. */
export function runRecoveryStore(runtimeDirectory: string, runId: string) {
  if (!/^run_[A-Za-z0-9_-]+$/u.test(runId)) throw new Error("Invalid recovery Run ID");
  const directory = join(runtimeDirectory, "run-recovery");
  const path = join(directory, `${runId}.json`);
  return {
    read(): unknown {
      try {
        const bytes = readFileSync(path);
        if (bytes.length > 65_536) throw new Error("Recovery proposal exceeds 64 KiB");
        return JSON.parse(bytes.toString("utf8"));
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    },
    write(value: unknown) {
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > 65_536) throw new Error("Recovery proposal exceeds 64 KiB");
      mkdirSync(directory, {recursive: true, mode: 0o700});
      const temporary = join(directory, `${runId}.${randomUUID()}.tmp`);
      try { writeFileSync(temporary, text, {flag: "wx", mode: 0o600}); renameSync(temporary, path); }
      finally { if (existsSync(temporary)) unlinkSync(temporary); }
    }
  };
}
