#!/usr/bin/env node

import { connectMysql } from "./connection.js";
import { migrateServerDatabase } from "./migrations.js";

export async function runMigrationCli(
  environment: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const databaseUrl = environment.ROLLERSKATE_DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    process.stderr.write("ROLLERSKATE_DATABASE_URL is required\n");
    return 2;
  }

  const connection = await connectMysql(databaseUrl);
  try {
    const applied = await migrateServerDatabase(connection);
    process.stdout.write(`${JSON.stringify({
      status: "ready",
      applied
    })}\n`);
    return 0;
  } finally {
    await connection.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = await runMigrationCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
