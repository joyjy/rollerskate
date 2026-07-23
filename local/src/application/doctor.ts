import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { MatrixClient } from "../integrations/matrix/client.js";
import {
  loadLocalRuntime,
  type LoadedLocalRuntime
} from "./runtime-config.js";

export interface LocalDoctorResult {
  readonly status: "ready";
  readonly repoRoot: string;
  readonly projectRoot: string;
  readonly runtimeDirectory: string;
  readonly database: string;
  readonly schemaVersion: number;
  readonly codexExecutable: string;
  readonly grantExpiresAt: string;
  readonly matrix?: {
    readonly homeserver: string;
    readonly roomId: string;
    readonly userId: string;
    readonly deviceId?: string;
  };
}

export interface DoctorOptions {
  readonly includeMatrix?: boolean;
  readonly fetch?: typeof fetch;
}

export async function doctorLocalRuntime(
  repoRoot: string,
  options: DoctorOptions = {}
): Promise<LocalDoctorResult> {
  const runtime = loadLocalRuntime(repoRoot);
  validateLocalRuntime(runtime);
  const result: LocalDoctorResult = {
    status: "ready",
    repoRoot: runtime.paths.repoRoot,
    projectRoot: runtime.config.projectRoot,
    runtimeDirectory: runtime.paths.runtimeDirectory,
    database: runtime.paths.database,
    schemaVersion: readSchemaVersion(runtime.paths.database),
    codexExecutable: runtime.config.codexExecutable,
    grantExpiresAt: runtime.config.grantExpiresAt
  };
  if (options.includeMatrix === false) {
    return result;
  }
  const client = new MatrixClient({
    homeserver: runtime.config.matrix.homeserver,
    accessToken: runtime.matrixAccessToken,
    timeoutMilliseconds: runtime.config.runtime.sendTimeoutMilliseconds,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });
  const identity = await client.whoAmI();
  if (identity.userId !== runtime.config.matrix.agentUserId) {
    throw new Error(
      `Matrix token user ${identity.userId} does not match configured Agent ` +
      runtime.config.matrix.agentUserId
    );
  }
  const rooms = await client.joinedRoomIds();
  if (!rooms.includes(runtime.config.matrix.roomId)) {
    throw new Error(
      `Matrix token user ${identity.userId} has not joined room ` +
      runtime.config.matrix.roomId
    );
  }
  return {
    ...result,
    matrix: {
      homeserver: runtime.config.matrix.homeserver,
      roomId: runtime.config.matrix.roomId,
      userId: identity.userId,
      ...(identity.deviceId === undefined ? {} : { deviceId: identity.deviceId })
    }
  };
}

function validateLocalRuntime(runtime: LoadedLocalRuntime): void {
  if (realpathSync(runtime.config.projectRoot) !== runtime.config.projectRoot) {
    throw new Error("configured projectRoot is no longer canonical");
  }
  if (!statSync(runtime.config.projectRoot).isDirectory()) {
    throw new Error("configured projectRoot is not a directory");
  }
  accessSync(runtime.config.codexExecutable, constants.X_OK);
  if (Date.parse(runtime.config.grantExpiresAt) <= Date.now()) {
    throw new Error("configured Matrix owner grant has expired; rerun setup");
  }
}

function readSchemaVersion(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(`
      SELECT value FROM schema_meta WHERE key = 'schema_version'
    `).get() as { value: string } | undefined;
    const version = Number(row?.value);
    if (!Number.isInteger(version) || version < 1) {
      throw new Error("runtime database has no valid schema version");
    }
    return version;
  } finally {
    database.close();
  }
}
