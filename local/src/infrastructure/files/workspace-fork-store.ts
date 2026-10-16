import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, unlinkSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** An exclusive directory reserves one intent across processes, including unknown outcomes. */
export function workspaceForkStore(runtimeDirectory: string, authority: string, requestId: string) {
  const id = createHash("sha256").update(JSON.stringify([authority, requestId])).digest("hex");
  const directory = join(runtimeDirectory, "workspace-forks", id);
  return {
    reserve(): boolean {
      mkdirSync(join(runtimeDirectory, "workspace-forks"), {recursive: true, mode: 0o700});
      try { mkdirSync(directory, {mode: 0o700}); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    },
    read(name: "request" | "result"): unknown {
      const path = join(directory, `${name}.json`);
      if (!existsSync(path)) return undefined;
      if (statSync(path).size > 16_384) throw new Error("Fork receipt exceeds its size limit");
      return JSON.parse(readFileSync(path, "utf8"));
    },
    write(name: "request" | "result", value: unknown): void {
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text) > 16_384) throw new Error("Fork receipt exceeds its size limit");
      const temporary=join(directory,`${name}.${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary,text,{flag:"wx",mode:0o600});
        linkSync(temporary,join(directory,`${name}.json`));
      } finally { if (existsSync(temporary)) unlinkSync(temporary); }
    }
  };
}
