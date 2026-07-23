import assert from "node:assert/strict";
import test from "node:test";

import { MatrixClient } from "../src/integrations/matrix/client.js";

test("sends an idempotent Matrix thread reply without putting the token in the URL", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const client = new MatrixClient({
    homeserver: "https://matrix.example",
    accessToken: "secret-token",
    timeoutMilliseconds: 1_000,
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ event_id: "$answer:example" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const receipt = await client.sendText({
    roomId: "!room:example",
    transactionId: "delivery-1",
    body: "Source answer",
    mentionedUserIds: ["@owner:example"],
    replyToEventId: "$question:example",
    threadRootEventId: "$question:example"
  });
  assert.deepEqual(receipt, {
    eventId: "$answer:example",
    roomId: "!room:example",
    transactionId: "delivery-1"
  });
  assert.equal(
    capturedUrl,
    "https://matrix.example/_matrix/client/v3/rooms/!room%3Aexample/send/m.room.message/delivery-1"
  );
  assert.doesNotMatch(capturedUrl, /secret-token/);
  assert.equal(capturedInit?.method, "PUT");
  assert.deepEqual(capturedInit?.headers, {
    authorization: "Bearer secret-token",
    "content-type": "application/json"
  });
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    msgtype: "m.text",
    body: "Source answer",
    "m.mentions": { user_ids: ["@owner:example"] },
    "m.relates_to": {
      rel_type: "m.thread",
      event_id: "$question:example",
      is_falling_back: true,
      "m.in_reply_to": { event_id: "$question:example" }
    }
  });
});

test("surfaces bounded Matrix error responses", async () => {
  const client = new MatrixClient({
    homeserver: "https://matrix.example",
    accessToken: "secret-token",
    timeoutMilliseconds: 1_000,
    fetch: async () => new Response(
      JSON.stringify({ errcode: "M_FORBIDDEN", error: "not joined" }),
      { status: 403 }
    )
  });
  await assert.rejects(
    client.sendText({
      roomId: "!room:example",
      transactionId: "delivery-2",
      body: "Source answer"
    }),
    /Matrix send failed with HTTP 403.*M_FORBIDDEN/
  );
});

test("verifies the authenticated Matrix user without putting the token in the URL", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const client = new MatrixClient({
    homeserver: "https://matrix.example",
    accessToken: "secret-token",
    timeoutMilliseconds: 1_000,
    fetch: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({
        user_id: "@rollerskate:example",
        device_id: "DEVICE-1"
      });
    }
  });

  assert.deepEqual(await client.whoAmI(), {
    userId: "@rollerskate:example",
    deviceId: "DEVICE-1"
  });
  assert.equal(
    capturedUrl,
    "https://matrix.example/_matrix/client/v3/account/whoami"
  );
  assert.doesNotMatch(capturedUrl, /secret-token/);
  assert.equal(capturedInit?.method, "GET");
  assert.deepEqual(capturedInit?.headers, {
    authorization: "Bearer secret-token",
    accept: "application/json"
  });
});

test("lists rooms joined by the authenticated Matrix user", async () => {
  let capturedUrl = "";
  const client = new MatrixClient({
    homeserver: "https://matrix.example",
    accessToken: "secret-token",
    timeoutMilliseconds: 1_000,
    fetch: async (input) => {
      capturedUrl = String(input);
      return Response.json({
        joined_rooms: ["!owner:example", "!agent:example"]
      });
    }
  });

  assert.deepEqual(
    await client.joinedRoomIds(),
    ["!owner:example", "!agent:example"]
  );
  assert.equal(
    capturedUrl,
    "https://matrix.example/_matrix/client/v3/joined_rooms"
  );
  assert.doesNotMatch(capturedUrl, /secret-token/);
});

test("bounds Matrix preflight responses while streaming", async () => {
  const client = new MatrixClient({
    homeserver: "https://matrix.example",
    accessToken: "secret-token",
    timeoutMilliseconds: 1_000,
    maxResponseBytes: 8,
    fetch: async () => Response.json({ user_id: "@rollerskate:example" })
  });
  await assert.rejects(client.whoAmI(), /whoami response exceeds 8 bytes/);
});
