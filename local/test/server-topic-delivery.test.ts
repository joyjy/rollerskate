import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeDelivery, RuntimeDestination } from
  "../src/core/runtime/model.js";
import { ServerTopicDeliveryAdapter } from
  "../src/integrations/server/topic-delivery.js";

const AT = "2026-07-28T08:00:00.000Z";

test("Server Topic Delivery publishes with the matching Agent identity and stable transaction", async () => {
  const calls: unknown[] = [];
  const adapter = new ServerTopicDeliveryAdapter(new Map([[
    "agent-server-a",
    {
      async publishTopic(topicId: string, request: { transactionId: string; body: string }) {
        calls.push({ topicId, request });
        return {
          eventId: "server-event-a",
          topicId,
          sequence: 2,
          publisher: {
            kind: "agent" as const,
            agentId: "agent-server-a",
            agentName: "alice",
            ownerHumanId: "human-a",
            ownerDisplayName: "Alice",
            deviceId: "device-a"
          },
          transactionId: request.transactionId,
          body: request.body,
          agentProfileRevision: 1,
          topicProfileRevision: 1,
          createdAt: AT
        };
      }
    }
  ]]));
  const delivery: RuntimeDelivery = {
    deliveryId: "del_019f0000-0000-7000-8000-000000000001",
    origin: { kind: "host", id: "evt_019f0000-0000-7000-8000-000000000002" },
    destinationId: "dst_019f0000-0000-7000-8000-000000000003",
    payload: { body: "Agent reply" },
    status: "delivering",
    attemptCount: 1,
    maxAttempts: 5,
    nextAttemptAt: AT,
    createdAt: AT,
    updatedAt: AT
  };
  const destination: RuntimeDestination = {
    destinationId: delivery.destinationId,
    kind: "server-topic",
    address: { topicId: "topic-a", agentId: "agent-server-a" },
    createdAt: AT,
    updatedAt: AT
  };

  assert.deepEqual(await adapter.deliver({ delivery, destination }), {
    receipt: "server-event-a"
  });
  assert.deepEqual(calls, [{
    topicId: "topic-a",
    request: {
      transactionId: delivery.origin.id,
      body: "Agent reply"
    }
  }]);
});
