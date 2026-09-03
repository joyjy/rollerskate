import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DeterministicApplicationActionRegistry
} from "../src/application/proactive/action-registry.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { withImmediateTransaction } from
  "../src/infrastructure/sqlite/transaction.js";

test("Owner action registry executes once and returns the durable terminal receipt", () => {
  const fixture = setup();
  try {
    const registry = new DeterministicApplicationActionRegistry(fixture.database, [
      registration("action:test/record@1", "TestRecordInput@1", ({ database, actionInput }) => {
        const input = actionInput as { readonly value: string };
        database.prepare("INSERT INTO action_effects (value) VALUES (?)").run(input.value);
        return { status: "succeeded", output: { recorded: input.value } };
      })
    ]);
    const target = registry.compileTarget("action:test/record@1", { value: "once" });
    const source = {
      kind: "schedule" as const,
      id: "sch_test",
      definitionRevision: "ScheduleRevision@3:1"
    };
    const first = withImmediateTransaction(fixture.database, () =>
      registry.executeInTransaction({
        target,
        source,
        occurrenceKey: "2026-09-03T00:00:00.000Z",
        observation: { scheduledFor: "2026-09-03T00:00:00.000Z" },
        at: "2026-09-03T00:00:01.000Z"
      })
    );
    const duplicate = withImmediateTransaction(fixture.database, () =>
      registry.executeInTransaction({
        target,
        source,
        occurrenceKey: "2026-09-03T00:00:00.000Z",
        observation: { scheduledFor: "2026-09-03T00:00:00.000Z" },
        at: "2026-09-03T00:00:02.000Z"
      })
    );
    assert.equal(first.status, "succeeded");
    assert.deepEqual(duplicate, first);
    assert.equal(count(fixture.database, "action_effects"), 1);
    assert.equal(count(fixture.database, "deterministic_action_receipts"), 1);
    assert.deepEqual(registry.receipt(source, first.occurrenceKey), first);
  } finally {
    fixture.close();
  }
});

test("Owner action registry rolls back partial writes and terminalizes a failure", () => {
  const fixture = setup();
  try {
    const registry = new DeterministicApplicationActionRegistry(fixture.database, [
      registration("action:test/fail@1", "TestFailInput@1", ({ database }) => {
        database.prepare("INSERT INTO action_effects (value) VALUES ('rolled-back')").run();
        throw new Error("expected action failure");
      })
    ]);
    const target = registry.compileTarget("action:test/fail@1", {});
    const receipt = withImmediateTransaction(fixture.database, () =>
      registry.executeInTransaction({
        target,
        source: {
          kind: "subscription",
          id: "sub_test",
          definitionRevision: "SubscriptionDefinition@5:1"
        },
        occurrenceKey: "subscription:sub_test:terminal",
        observation: { terminal: "success" },
        at: "2026-09-03T00:01:00.000Z"
      })
    );
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.error, "expected action failure");
    assert.equal(count(fixture.database, "action_effects"), 0);
    assert.equal(count(fixture.database, "deterministic_action_receipts"), 1);
  } finally {
    fixture.close();
  }
});

test("Owner action registry terminalizes registration drift without executing", () => {
  const fixture = setup();
  try {
    const original = new DeterministicApplicationActionRegistry(fixture.database, [
      registration("action:test/drift@1", "DriftInput@1", () => ({ status: "succeeded" }))
    ]);
    const target = original.compileTarget("action:test/drift@1", {});
    const changed = new DeterministicApplicationActionRegistry(fixture.database, [
      registration("action:test/drift@1", "DriftInput@2", () => ({ status: "succeeded" }))
    ]);
    const receipt = withImmediateTransaction(fixture.database, () =>
      changed.executeInTransaction({
        target,
        source: {
          kind: "continuous_subscription",
          id: "sub_drift",
          definitionRevision: "ContinuousSubscriptionDefinition@3:1"
        },
        occurrenceKey: "delta-1",
        observation: {},
        at: "2026-09-03T00:02:00.000Z"
      })
    );
    assert.equal(receipt.status, "failed");
    assert.match(receipt.error!, /registry changed after admission/);
    assert.equal(count(fixture.database, "deterministic_action_receipts"), 1);
  } finally {
    fixture.close();
  }
});

function registration(
  ref: string,
  inputSchema: string,
  executeInTransaction: Parameters<
    typeof DeterministicApplicationActionRegistry.prototype.executeInTransaction
  > extends never ? never : (input: {
    readonly database: DatabaseSync;
    readonly actionInput: unknown;
  }) => { readonly status: "succeeded" } | {
    readonly status: "succeeded";
    readonly output: unknown;
  }
) {
  return {
    ref,
    inputSchema,
    parseInput(value: unknown) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("test input must be an object");
      }
      return value;
    },
    executeInTransaction
  };
}

function setup(): {
  readonly database: DatabaseSync;
  readonly close: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-action-registry-"));
  const databasePath = join(directory, "runtime.db");
  initializeRuntimeSchema(databasePath);
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON; CREATE TABLE action_effects (value TEXT NOT NULL)");
  return {
    database,
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function count(database: DatabaseSync, table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number | bigint;
  }).count);
}
