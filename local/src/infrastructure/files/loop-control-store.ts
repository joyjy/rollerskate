import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";

interface StoredLoopControl {
  readonly schemaVersion: 1;
  readonly paused: boolean;
}

export class LoopControlStore {
  readonly #path: string;

  public constructor(path: string) {
    this.#path = path;
  }

  public paused(): boolean {
    return this.#load().paused;
  }

  public setPaused(paused: boolean): void {
    this.#write({ schemaVersion: 1, paused });
  }

  #load(): StoredLoopControl {
    if (!existsSync(this.#path)) return { schemaVersion: 1, paused: false };
    assertPrivateRegularFile(this.#path);
    const value = JSON.parse(readFileSync(this.#path, "utf8")) as StoredLoopControl;
    if (value.schemaVersion !== 1 || typeof value.paused !== "boolean") {
      throw new Error("Loop control file has an unsupported schema");
    }
    return value;
  }

  #write(value: StoredLoopControl): void {
    if (existsSync(this.#path) && lstatSync(this.#path).isSymbolicLink()) {
      throw new Error("Loop control file must not be a symlink");
    }
    const temporary = `${this.#path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.#path);
      chmodSync(this.#path, 0o600);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}

function assertPrivateRegularFile(path: string): void {
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
    throw new Error("Loop control path must be a regular file");
  }
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error("Loop control file must not be accessible by group or others");
  }
}
