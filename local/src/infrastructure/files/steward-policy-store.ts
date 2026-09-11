import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseStewardPolicy, type StewardPolicy } from "../../modules/steward/steward-policy.js";

export class StewardPolicyStore {
  public constructor(readonly path: string) {}

  public load(): StewardPolicy | undefined {
    if (!existsSync(this.path)) return undefined;
    const stat = lstatSync(this.path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16_384) {
      throw new Error("Steward policy must be a private bounded regular file");
    }
    return parseStewardPolicy(JSON.parse(readFileSync(this.path, "utf8")));
  }

  public save(policy: StewardPolicy): void {
    this.load();
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(parseStewardPolicy(policy), null, 2)}\n`,
        { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
