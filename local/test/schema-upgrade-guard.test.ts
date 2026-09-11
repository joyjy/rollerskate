import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { migrateLocalDatabase as runMigration } from "../src/bootstrap/migrate.js";
import { runLocalApp } from "../src/entrypoints/cli/main.js";
import {
  openInitializedRuntimeDatabase,
  openRuntimeDatabase,
  openRuntimeDatabaseReadOnly
} from "../src/infrastructure/sqlite/database.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";

test("new CLI cannot upgrade the database while an older Runtime owns the loop", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-schema-guard-repo-"));
  const runtime = mkdtempSync(join(tmpdir(), "rollerskate-schema-guard-runtime-"));
  const databasePath = join(runtime, "runtime.db");
  const loopLock = join(runtime, "loop-state.json.lock");
  try {
    initializeRuntimeSchema(databasePath);
    setSchemaVersion(databasePath, 59);
    writeFileSync(loopLock, `${process.pid}\n`, { mode: 0o600 });

    await assert.rejects(
      () => runLocalApp(repo, [
        "--runtime", runtime, "start", "--no-open", "--ui-port", "4300"
      ]),
      /Cannot upgrade Local database schema 59 to 75 while Runtime pid \d+ is running/
    );
    await assert.rejects(
      () => runLocalApp(repo, ["--runtime", runtime, "run", "list"]),
      /Cannot upgrade Local database schema 59 to 75 while Runtime pid \d+ is running/
    );
    assert.equal(readSchemaVersion(databasePath), 59);
    assert.throws(
      () => runMigration([databasePath]),
      /Cannot upgrade Local database schema 59 to 75 while Runtime pid \d+ is running/
    );
    assert.equal(readSchemaVersion(databasePath), 59);

    setSchemaVersion(databasePath, 75);
    let sameVersionOutput = "";
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtime, "run", "list"
    ], {}, { write(text) { sameVersionOutput += text; } }), 0);
    assert.deepEqual(JSON.parse(sameVersionOutput), []);

    setSchemaVersion(databasePath, 59);
    rmSync(loopLock);
    for (const command of [["run", "list"], ["agent", "list"], ["subscription", "list"], ["notice", "list"]]) {
      await assert.rejects(
        () => runLocalApp(repo, ["--runtime", runtime, ...command]),
        /read-only queries do not migrate schema.*scripts\/rs start/
      );
    }
    assert.equal(readSchemaVersion(databasePath), 59);
    runMigration([databasePath]);
    let output = "";
    assert.equal(await runLocalApp(repo, [
      "--runtime", runtime, "run", "list"
    ], {}, { write(text) { output += text; } }), 0);
    assert.deepEqual(JSON.parse(output), []);
    assert.equal(readSchemaVersion(databasePath), 75);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("owned database initialization closes its handle when migration fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-schema-close-"));
  let opened: DatabaseSync | undefined;
  try {
    assert.throws(() => openInitializedRuntimeDatabase(
      join(directory, "runtime.db"),
      (database) => {
        opened = database;
        throw new Error("migration failed");
      }
    ), /migration failed/);
    assert.throws(() => opened!.prepare("SELECT 1"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setSchemaVersion(databasePath: string, version: number): void {
  const database = openRuntimeDatabase(databasePath);
  try {
    database.prepare(
      "UPDATE schema_meta SET value = ? WHERE key = 'schema_version'"
    ).run(String(version));
  } finally {
    database.close();
  }
}

function readSchemaVersion(databasePath: string): number {
  const database = openRuntimeDatabaseReadOnly(databasePath);
  try {
    const row = database.prepare(
      "SELECT value FROM schema_meta WHERE key = 'schema_version'"
    ).get() as { value: string };
    return Number(row.value);
  } finally {
    database.close();
  }
}

test("diagnostic queries never create a missing Runtime", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-query-missing-"));
  const runtime = join(repo, "missing-runtime");
  try {
    for (const command of [["agent", "list"], ["subscription", "list"], ["notice", "list"], ["chat", "history"]]) {
      await assert.rejects(() => runLocalApp(repo, ["--runtime", runtime, ...command]));
      assert.equal(existsSync(runtime), false);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
