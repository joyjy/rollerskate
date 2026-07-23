import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { migrateLocalDatabase } from "../src/bootstrap/migrate.js";
import { eventEnvelopeSchema } from "../src/protocol.js";

test("local migration has an independent entrypoint", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-local-migrate-"));
  try {
    const databasePath = join(directory, "runtime.db");
    assert.equal(migrateLocalDatabase([databasePath]), 0);
    assert.equal(existsSync(databasePath), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local imports the shared network envelope", () => {
  const result = eventEnvelopeSchema.safeParse({
    protocolVersion: 1,
    eventId: "event-local-1",
    type: "placement.desired",
    occurredAt: "2026-07-19T01:00:00.000Z",
    source: { kind: "server", id: "server-1" },
    subject: { kind: "device", id: "device-1" },
    payload: { placementId: "placement-1" }
  });

  assert.equal(result.success, true);
});
