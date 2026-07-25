import { openRuntimeDatabase, openRuntimeDatabaseReadOnly } from "./database.js";
import { migrateLocalDatabase } from "./local-schema.js";

export interface RuntimeDiagnostics {
  readonly schemaVersion: number;
  readonly journalMode: string;
  readonly tables: string[];
}

export function initializeRuntimeSchema(databasePath: string): RuntimeDiagnostics {
  const writable = openRuntimeDatabase(databasePath);
  try {
    migrateLocalDatabase(writable);
  } finally {
    writable.close();
  }

  const database = openRuntimeDatabaseReadOnly(databasePath);
  try {
    const version = database.prepare(`
      SELECT value FROM schema_meta WHERE key = 'schema_version'
    `).get() as { value: string } | undefined;
    const journal = database.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    const rows = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `).all() as unknown as Array<{ name: string }>;
    return {
      schemaVersion: Number(version?.value ?? 0),
      journalMode: journal.journal_mode,
      tables: rows.map((row) => row.name)
    };
  } finally {
    database.close();
  }
}
