import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Connection, RowDataPacket } from "mysql2/promise";

export interface Migration {
  readonly version: string;
  readonly sql: string;
}

interface AppliedMigrationRow extends RowDataPacket {
  readonly version: string;
}

export const defaultMigrationsDirectory = fileURLToPath(
  new URL("../../../../../migrations/", import.meta.url)
);

export async function readMigrations(
  directory = defaultMigrationsDirectory
): Promise<Migration[]> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}_[a-z0-9_]+\.sql$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));

  return Promise.all(entries.map(async (entry) => ({
    version: entry.name.slice(0, -4),
    sql: await readFile(join(directory, entry.name), "utf8")
  })));
}

export async function migrateServerDatabase(
  connection: Connection,
  directory = defaultMigrationsDirectory
): Promise<readonly string[]> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const [rows] = await connection.query<AppliedMigrationRow[]>(
    "SELECT version FROM schema_migrations ORDER BY version"
  );
  const applied = new Set(rows.map((row) => row.version));
  const newlyApplied: string[] = [];

  for (const migration of await readMigrations(directory)) {
    if (applied.has(migration.version)) {
      continue;
    }
    await connection.query(migration.sql);
    await connection.execute(
      "INSERT INTO schema_migrations (version) VALUES (?)",
      [migration.version]
    );
    newlyApplied.push(migration.version);
  }

  return newlyApplied;
}
