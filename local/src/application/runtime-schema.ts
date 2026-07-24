import { openRuntimeDatabase, openRuntimeDatabaseReadOnly } from "../infrastructure/sqlite/database.js";
import { LocalDeviceStore } from "../application/device/store.js";
import { LocalAgentRegistryStore } from "../application/agent/registry-store.js";
import { PollSubscriptionStore } from "../capabilities/subscription/store.js";
import { RuntimeStore } from "../core/runtime/store.js";
import { LocalFoundationStore } from "./local-foundation.js";

export interface RuntimeDiagnostics {
  readonly schemaVersion: number;
  readonly journalMode: string;
  readonly tables: string[];
}

export function initializeRuntimeSchema(databasePath: string): RuntimeDiagnostics {
  const runtime = new RuntimeStore(databasePath);
  runtime.close();
  const device = new LocalDeviceStore(databasePath);
  device.close();
  const agents = new LocalAgentRegistryStore(databasePath);
  agents.close();
  const subscriptions = new PollSubscriptionStore(databasePath);
  subscriptions.close();
  const foundation = new LocalFoundationStore(databasePath);
  foundation.close();
  const writable = openRuntimeDatabase(databasePath);
  try {
    writable.prepare(`
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '34')
      ON CONFLICT(key) DO UPDATE SET value = '34'
    `).run();
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
