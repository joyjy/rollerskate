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

export interface DeviceCredential {
  readonly serverUrl: string;
  readonly deviceId: string;
  readonly credentialId: string;
  readonly credential: string;
}

interface StoredDeviceCredential extends DeviceCredential {
  readonly schemaVersion: 1;
}

export class DeviceCredentialStore {
  readonly #path: string;

  public constructor(path: string) {
    this.#path = path;
  }

  public load(): DeviceCredential | undefined {
    if (!existsSync(this.#path)) {
      return undefined;
    }
    assertRegularPrivateFile(this.#path);
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.#path, "utf8")) as unknown;
    } catch (error) {
      throw new Error(
        `invalid device credential file: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!isRecord(value) || value.schemaVersion !== 1) {
      throw new Error("device credential file has an unsupported schema");
    }
    for (const field of ["serverUrl", "deviceId", "credentialId", "credential"] as const) {
      if (typeof value[field] !== "string" || value[field].trim() === "") {
        throw new Error(`device credential file has an invalid ${field}`);
      }
    }
    return value as unknown as DeviceCredential;
  }

  public save(credential: DeviceCredential): void {
    if (existsSync(this.#path) && lstatSync(this.#path).isSymbolicLink()) {
      throw new Error("device credential file must not be a symlink");
    }
    const temporary = `${this.#path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({
        schemaVersion: 1,
        ...credential
      } satisfies StoredDeviceCredential, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.#path);
      chmodSync(this.#path, 0o600);
    } finally {
      if (existsSync(temporary)) {
        unlinkSync(temporary);
      }
    }
  }

  public remove(): void {
    if (!existsSync(this.#path)) {
      return;
    }
    if (lstatSync(this.#path).isSymbolicLink()) {
      throw new Error("device credential file must not be a symlink");
    }
    unlinkSync(this.#path);
  }
}

function assertRegularPrivateFile(path: string): void {
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error("device credential file must not be a symlink");
  }
  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new Error("device credential path must be a regular file");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("device credential file must not be accessible by group or others");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
