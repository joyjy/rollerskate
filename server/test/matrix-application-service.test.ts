import assert from "node:assert/strict";
import test from "node:test";

import { HttpMatrixApplicationServiceGateway } from "../src/adapter/matrix/application-service.js";

test("Matrix application service keeps AS tokens in Authorization headers", async () => {
  const requests: { readonly url: string; readonly authorization: string | null; readonly body?: string }[] = [];
  const gateway = new HttpMatrixApplicationServiceGateway({
    homeserverUrl: "https://matrix.example.com",
    serverName: "matrix.example.com",
    asToken: "as-secret",
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        ...(typeof init?.body === "string" ? { body: init.body } : {})
      });
      const body = url.includes("createRoom")
        ? { room_id: "!room:matrix.example.com" }
        : url.includes("/send/")
          ? { event_id: "$event" }
          : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const mxid = gateway.mxidFor("agent", "agent-1");
  await gateway.ensurePrincipal(mxid, "Agent One");
  const roomId = await gateway.createRoom({
    creatorMxid: mxid,
    name: "Room",
    visibility: "private"
  });
  const eventId = await gateway.sendMessage({
    roomId,
    senderMxid: mxid,
    transactionId: "txn-1",
    body: "hello",
    causalChainId: "chain-1",
    causalHop: 2
  });

  assert.equal(eventId, "$event");
  assert.ok(requests.length >= 4);
  for (const request of requests) {
    assert.equal(request.authorization, "Bearer as-secret");
    assert.equal(request.url.includes("as-secret"), false);
    assert.equal(request.url.includes("access_token"), false);
  }
  const send = requests.find((request) => request.url.includes("/send/"));
  assert.deepEqual(JSON.parse(send?.body ?? "{}"), {
    msgtype: "m.text",
    body: "hello",
    "org.rollerskate.causal": { chain_id: "chain-1", hop: 2 }
  });
});
