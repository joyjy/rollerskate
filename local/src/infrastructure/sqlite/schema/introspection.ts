import type { DatabaseSync } from "node:sqlite";

export function writeSchemaVersion(database: DatabaseSync, version: number): void {
  database.prepare(`
    INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(version));
}

export function tableExists(database: DatabaseSync, table: string): boolean {
  return database.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table) !== undefined;
}

export function tableColumns(database: DatabaseSync, table: string): string[] {
  return (database.prepare(
    `PRAGMA table_info(${quoteIdentifier(table)})`
  ).all() as unknown as Array<{ name: string }>).map(({ name }) => name);
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

export function schemaVersion(database: DatabaseSync): number | undefined {
  if (!tableExists(database, "schema_meta")) return undefined;
  const row = database.prepare(`
    SELECT value FROM schema_meta WHERE key = 'schema_version'
  `).get() as { value: string } | undefined;
  if (row === undefined) return undefined;
  const value = Number(row.value);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Local database schema version is invalid: ${row.value}`);
  }
  return value;
}

export function productTables(database: DatabaseSync): string[] {
  return (database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as unknown as Array<{ name: string }>).map(({ name }) => name);
}

export function preV61ProductTables(database: DatabaseSync): string[] {
  return productTables(database).filter((table) =>
    !(["agent_run_decisions", "agent_run_cycles",
      "chat_rotations",
      "deterministic_action_receipts", "external_workflow_executions", "external_workflow_recovery_receipts",
      "legacy_trigger_migration_receipts", "proactive_source_migration_receipts"].includes(table) &&
      rowCount(database, table) === 0));
}

export function rowCount(database: DatabaseSync, table: string): number {
  return scalarCount(database, `SELECT COUNT(*) AS count FROM "${table}"`);
}

export function scalarCount(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as { count: number | bigint };
  return Number(row.count);
}
