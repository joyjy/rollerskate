import assert from "node:assert/strict";
import test from "node:test";

import { RoomServerClient } from "../src/integrations/server/room-client.js";

test("Room Server client authenticates head/range and publishes causal metadata", async () => {
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const client = new RoomServerClient({ baseUrl: "http://localhost:3000", agentId: "agent/one",
    credential: "secret", allowInsecureHttp: true, fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, ...(init === undefined ? {} : { init }) });
      if (url.pathname.endsWith("/rooms")) return Response.json([]);
      if (url.pathname.endsWith("/head")) return Response.json({ roomId: "room-1", head: "r1.MQ" });
      if (url.pathname.endsWith("/events")) return Response.json({ roomId: "room-1", through: "r1.MQ", events: [], complete: true });
      return Response.json({ eventId: "$reply", transactionId: "txn-1" });
    } });
  await client.head("room-1");
  await client.bindings();
  await client.events({ roomId: "room-1", after: "r1.MA", through: "r1.MQ", limit: 25 });
  await client.send({ agentId: "agent/one", roomId: "room-1", transactionId: "txn-1", body: "answer",
    causalChainId: "chain-1", causalHop: 2 });
  assert.equal(requests[0]?.init?.headers instanceof Headers, false);
  assert.equal(requests[2]?.url.searchParams.get("after"), "r1.MA");
  assert.deepEqual(JSON.parse(String(requests[3]?.init?.body)), {
    transactionId: "txn-1", body: "answer", causalChainId: "chain-1", causalHop: 2
  });
  assert.equal((requests[3]?.init?.headers as Record<string, string>).authorization, "Bearer secret");
});

test("Room Server client permits insecure HTTP only for localhost", () => {
  assert.throws(() => new RoomServerClient({
    baseUrl: "http://server.example",
    agentId: "agent-1",
    credential: "secret",
    allowInsecureHttp: true
  }), /must use https/);
});
