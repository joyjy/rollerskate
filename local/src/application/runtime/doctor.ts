import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  realpathSync,
  statSync
} from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { MatrixClient } from "../../integrations/matrix/client.js";
import {
  loadLocalRuntime,
  runtimePaths,
  type LoadedLocalRuntime
} from "../../infrastructure/runtime/config.js";
import { LOCAL_SCHEMA_VERSION } from "../../infrastructure/sqlite/schema/index.js";

export interface LocalDoctorResult {
  readonly status: "ready";
  readonly repoRoot: string;
  readonly projectRoot: string;
  readonly runtimeDirectory: string;
  readonly database: string;
  readonly schemaVersion: number;
  readonly codexExecutable?: string;
  readonly grantExpiresAt?: string;
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
  readonly runtimeDirectory?: string;
}

export async function doctorLocalRuntime(
  repoRoot: string,
  options: DoctorOptions = {}
): Promise<LocalDoctorResult> {
  if (options.includeMatrix === false) {
    return doctorLocalFoundation(repoRoot, options.runtimeDirectory);
  }
  const runtime = loadLocalRuntime(repoRoot, options.runtimeDirectory);
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

function doctorLocalFoundation(
  repoRoot: string,
  runtimeDirectory?: string
): LocalDoctorResult {
  const paths = runtimePaths(repoRoot, runtimeDirectory);
  if (!existsSync(paths.database)) {
    throw new Error(`Local Runtime database is missing: ${paths.database}`);
  }
  if (lstatSync(paths.database).isSymbolicLink() ||
    !statSync(paths.database).isFile()) {
    throw new Error("Local Runtime database must be a regular file");
  }
  const database = new DatabaseSync(paths.database, { readOnly: true });
  try {
    const schemaVersion = schemaVersionFromDatabase(database);
    if (schemaVersion !== LOCAL_SCHEMA_VERSION) {
      throw new Error(
        `Local Runtime database schema ${schemaVersion} is not current ` +
        `${LOCAL_SCHEMA_VERSION}`
      );
    }
    const foundation = database.prepare(`
      SELECT workspace_path
      FROM local_foundation
      WHERE singleton = 1
    `).get() as { workspace_path: string } | undefined;
    if (foundation === undefined) {
      throw new Error("Local foundation is not initialized");
    }
    const workspace = realpathSync(foundation.workspace_path);
    if (workspace !== foundation.workspace_path ||
      !statSync(workspace).isDirectory()) {
      throw new Error("Local workspace is not a canonical directory");
    }
    return {
      status: "ready",
      repoRoot: paths.repoRoot,
      projectRoot: workspace,
      runtimeDirectory: paths.runtimeDirectory,
      database: paths.database,
      schemaVersion
    };
  } finally {
    database.close();
  }
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
    return schemaVersionFromDatabase(database);
  } finally {
    database.close();
  }
}

function schemaVersionFromDatabase(database: DatabaseSync): number {
  const row = database.prepare(`
    SELECT value FROM schema_meta WHERE key = 'schema_version'
  `).get() as { value: string } | undefined;
  const version = Number(row?.value);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("runtime database has no valid schema version");
  }
  return version;
}
