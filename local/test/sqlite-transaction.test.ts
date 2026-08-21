import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { withImmediateTransaction } from "../src/infrastructure/sqlite/transaction.js";

test("shared immediate transaction commits return values and rolls back failures", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE facts (value TEXT NOT NULL)");
    const result = withImmediateTransaction(database, () => {
      database.prepare("INSERT INTO facts VALUES (?)").run("committed");
      return "result";
    });
    assert.equal(result, "result");
    assert.throws(() => withImmediateTransaction(database, () => {
      database.prepare("INSERT INTO facts VALUES (?)").run("rolled-back");
      throw new Error("stop");
    }), /stop/);
    assert.deepEqual(database.prepare("SELECT value FROM facts").all().map((row) => ({ ...row })), [
      { value: "committed" }
    ]);
  } finally {
    database.close();
  }
});
