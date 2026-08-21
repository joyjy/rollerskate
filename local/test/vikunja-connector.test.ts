import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { VikunjaConnector } from "../src/integrations/vikunja/connector.js";

const INTEGRATION_ID = "integration-vikunja-test";
const PROJECT_ID = 41;
const TOKEN = "secret-token-never-persist";

test("Vikunja Connector observes and reads deterministically across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-vikunja-observe-"));
  try {
    const provider = new FakeVikunja();
    const ledgerPath = join(directory, "connector-ledger.json");
    const connector = connectorFor(provider, ledgerPath);
    assert.deepEqual(connector.describe().profiles[0], {
      profileId: "playground@1",
      readSchemaRefs: ["project.read@1", "work-item.read@1"]
    });

    const request = {
      schemaVersion: "ConnectorObserveRequest@1" as const,
      integrationBindingId: INTEGRATION_ID,
      limit: 25
    };
    const first = await connector.observe(request);
    assert.equal(first.observations.length, 1);
    assert.deepEqual(await connector.observe(request), first);
    assert.deepEqual(await connectorFor(provider, ledgerPath).observe(request), first);

    const acknowledged = await connector.observe({ ...request, cursor: first.nextCursor });
    assert.equal(acknowledged.observations.length, 0);
    provider.addComment("provider update");
    const changed = await connector.observe({
      ...request,
      cursor: acknowledged.nextCursor
    });
    assert.equal(changed.observations.length, 1);
    assert.notEqual(changed.observations[0]?.sourceRevision,
      first.observations[0]?.sourceRevision);

    const read = await connector.read({
      schemaVersion: "ConnectorReadRequest@1",
      ref: {
        schemaVersion: "ExternalRef@1",
        integrationBindingId: INTEGRATION_ID,
        kind: "work-item",
        externalId: "100"
      },
      profileId: "playground@1",
      schemaRef: "work-item.read@1",
      maxBytes: 65_536
    });
    assert.equal(read.ref.externalId, "100");
    assert.equal(record(read.boundedPayload).status, "open");
    assert.equal(readFileSync(ledgerPath, "utf8").includes(TOKEN), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("read-only Connector preserves retired effect ledger entries as inert tombstones", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-vikunja-ledger-"));
  try {
    const ledgerPath = join(directory, "connector-ledger.json");
    writeFileSync(ledgerPath, JSON.stringify({
      schemaVersion: 1,
      observedRevisions: {},
      effects: { retired: { state: "terminal", receipt: { legacy: true } } }
    }), { mode: 0o600 });
    const provider = new FakeVikunja();
    const connector = connectorFor(provider, ledgerPath);
    const first = await connector.observe({
      schemaVersion: "ConnectorObserveRequest@1",
      integrationBindingId: INTEGRATION_ID,
      limit: 25
    });
    await connector.observe({
      schemaVersion: "ConnectorObserveRequest@1",
      integrationBindingId: INTEGRATION_ID,
      cursor: first.nextCursor,
      limit: 25
    });
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      readonly effects: Readonly<Record<string, unknown>>;
    };
    assert.deepEqual(ledger.effects.retired, {
      state: "terminal",
      receipt: { legacy: true }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function connectorFor(provider: FakeVikunja, ledgerPath: string): VikunjaConnector {
  return new VikunjaConnector({
    endpoint: "http://127.0.0.1:3456",
    token: () => TOKEN,
    integrationBindingId: INTEGRATION_ID,
    projectExternalId: String(PROJECT_ID),
    ledgerPath,
    fetch: provider.fetch,
    now: () => new Date("2026-08-18T12:00:00.000Z")
  });
}

class FakeVikunja {
  readonly #task = {
    id: 100,
    project_id: PROJECT_ID,
    title: "Observed task",
    description: "",
    done: false,
    created: "2026-08-18T00:00:00.000Z",
    updated: "2026-08-18T00:00:00.000Z",
    assignees: [],
    buckets: [],
    labels: [],
    related_tasks: {},
    comments: [] as Array<{
      readonly id: number;
      readonly comment: string;
      readonly author: { readonly id: number };
      readonly created: string;
      readonly updated: string;
    }>
  };

  public addComment(body: string): void {
    const timestamp = "2026-08-18T00:01:00.000Z";
    this.#task.comments.push({
      id: 500,
      comment: body,
      author: { id: 7 },
      created: timestamp,
      updated: timestamp
    });
    this.#task.updated = timestamp;
  }

  public readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(init?.headers === undefined ? undefined :
      new Headers(init.headers).get("authorization"), "Bearer secret-token-never-persist");
    if (url.pathname === "/api/v1/tasks") {
      return json([this.#task], 200, { "x-pagination-total-pages": "1" });
    }
    if (url.pathname === "/api/v1/tasks/100") return json(this.#task);
    if (url.pathname === `/api/v1/projects/${PROJECT_ID}`) {
      return json({
        id: PROJECT_ID,
        title: "Fixture project",
        description: "",
        is_archived: false,
        created: "2026-08-18T00:00:00.000Z",
        updated: "2026-08-18T00:00:00.000Z",
        views: [{ id: 91, view_kind: "list" }]
      });
    }
    return json({ code: 404 }, 404);
  };
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Readonly<Record<string, unknown>>;
}
