import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const BUSY_TIMEOUT_MILLISECONDS = 5_000;

export function openRuntimeDatabase(databasePath: string): DatabaseSync {
  return new DatabaseSync(resolve(databasePath), {
    timeout: BUSY_TIMEOUT_MILLISECONDS
  });
}

export function openInitializedRuntimeDatabase(
  databasePath: string,
  initialize: (database: DatabaseSync) => void
): DatabaseSync {
  const database = openRuntimeDatabase(databasePath);
  try {
    initialize(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function openRuntimeDatabaseReadOnly(databasePath: string): DatabaseSync {
  return new DatabaseSync(resolve(databasePath), {
    readOnly: true,
    timeout: BUSY_TIMEOUT_MILLISECONDS
  });
}
