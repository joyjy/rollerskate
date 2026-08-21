import assert from "node:assert/strict";
import test from "node:test";

import type {
  RuntimeDelivery,
  RuntimeDestination
} from "../src/core/runtime/model.js";
import { VikunjaTaskDestinationAdapter } from
  "../src/integrations/vikunja/task-destination.js";

test("Vikunja Task destination recovers an ambiguous write without duplicating it", async () => {
  const provider = new FakeVikunjaComments();
  const adapter = new VikunjaTaskDestinationAdapter({
    endpoint: "http://127.0.0.1:3456",
    token: () => "secret-token",
    fetch: provider.fetch
  });
  const input = {
    delivery: delivery(),
    destination: destination()
  };

  provider.failAfterNextWrite = true;
  await assert.rejects(adapter.deliver(input), /connection loss/u);
  assert.equal(provider.writeCount, 1);

  assert.deepEqual(await adapter.deliver(input), { receipt: "vikunja-comment:500" });
  assert.equal(provider.writeCount, 1);
  assert.match(provider.comments[0]!.comment, /rollerskate-delivery:del_/u);
});

test("Vikunja Task destination returns the existing marker receipt on replay", async () => {
  const provider = new FakeVikunjaComments();
  const adapter = new VikunjaTaskDestinationAdapter({
    endpoint: "http://127.0.0.1:3456",
    token: () => "secret-token",
    fetch: provider.fetch
  });
  const input = { delivery: delivery(), destination: destination() };

  const first = await adapter.deliver(input);
  const replay = await adapter.deliver(input);
  assert.deepEqual(replay, first);
  assert.equal(provider.writeCount, 1);
});

test("Vikunja Task destination rejects another origin before using the token", async () => {
  let tokenReads = 0;
  let fetches = 0;
  const adapter = new VikunjaTaskDestinationAdapter({
    endpoint: "https://vikunja.example.com",
    token: () => {
      tokenReads += 1;
      return "secret-token";
    },
    fetch: async () => {
      fetches += 1;
      throw new Error("fetch must not run");
    }
  });
  const input = {
    delivery: delivery(),
    destination: {
      ...destination(),
      address: { taskUrl: "https://attacker.example/tasks/41" }
    }
  };

  await assert.rejects(adapter.deliver(input), /origin does not match/u);
  assert.equal(tokenReads, 0);
  assert.equal(fetches, 0);
});

function destination(): RuntimeDestination {
  return {
    destinationId: "dst_019fa649-637b-7bf2-ad2b-a9b7be044fcd",
    kind: "vikunja-task",
    address: { taskUrl: "http://127.0.0.1:3456/tasks/41" },
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z"
  };
}

function delivery(): RuntimeDelivery {
  return {
    deliveryId: "del_019fa649-637b-7bf2-ad2b-a9b7be044fce",
    origin: { kind: "host", id: "steward-run:run_test:terminal" },
    destinationId: destination().destinationId,
    payload: {
      schemaVersion: "VikunjaTaskComment@1",
      runId: "run_test",
      body: "Completed by the Steward Orchestrator."
    },
    status: "delivering",
    attemptCount: 1,
    maxAttempts: 5,
    nextAttemptAt: "2026-08-18T00:00:00.000Z",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z"
  };
}

class FakeVikunjaComments {
  public readonly comments: Array<{ readonly id: number; readonly comment: string }> = [];
  public writeCount = 0;
  public failAfterNextWrite = false;

  public readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    assert.equal(url.pathname, "/api/v1/tasks/41/comments");
    assert.equal(init?.headers === undefined ? undefined : new Headers(init.headers).get("authorization"),
      "Bearer secret-token");
    if (method === "GET") return json(this.comments);
    assert.equal(method, "PUT");
    this.writeCount += 1;
    const body = JSON.parse(String(init?.body)) as { readonly comment: string };
    const comment = { id: 499 + this.writeCount, comment: body.comment };
    this.comments.unshift(comment);
    if (this.failAfterNextWrite) {
      this.failAfterNextWrite = false;
      throw new TypeError("simulated connection loss after provider commit");
    }
    return json(comment, 201);
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
