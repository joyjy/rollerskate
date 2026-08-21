import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { parseChatProfileContext } from "../src/core/chat/model.js";
import { TopicInboxStore } from "../src/infrastructure/files/topic-inbox-store.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { PassiveTopicSync, type TopicSyncClient } from
  "../src/application/topic/sync.js";
import { ServerTopicRuntimeBridge } from "../src/application/topic/runtime.js";
import { ChatHandler } from "../src/application/chat/handler.js";
import { RuntimeStore } from "../src/core/runtime/store.js";

const AT = "2026-07-27T12:00:00.000Z";
const TOPIC_ID = "11111111-1111-4111-8111-111111111111";
const SERVER_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const SERVER_AGENT_BOB_ID = "66666666-6666-4666-8666-666666666666";
const MISSING_SERVER_AGENT_ID = "55555555-5555-4555-8555-555555555555";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const HUMAN_EVENT_ID = "44444444-4444-4444-8444-444444444444";

test("Topic inbox v1 migrates legacy Agent publisher snapshots without losing history", () => {
  const directory = mkdtempSync(join(tmpdir(), "rollerskate-topic-inbox-v1-"));
  const path = join(directory, "topic-inbox.json");
  try {
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      topics: [{
        view: {
          subscription: {
            topicId: TOPIC_ID,
            runtimeId: "device-a",
            status: "active",
            cursor: 1,
            createdAt: AT,
            updatedAt: AT
          },
          agentIds: [SERVER_AGENT_ID]
        },
        topic: topicSummary(),
        participants: [],
        events: [legacyAgentEvent()],
        cursor: 1,
        syncedAt: AT
      }]
    }), { mode: 0o600 });
    const store = new TopicInboxStore(path);
    assert.equal(store.topics()[0]?.events[0]?.publisher.kind, "agent");
    const migrated = JSON.parse(readFileSync(path, "utf8")) as {
      schemaVersion: number;
      topics: Array<{ events: Array<Record<string, unknown>> }>;
    };
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.topics[0]?.events[0]?.publisherAgentId, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Topic sync admits Human and Agent events exactly once before ack", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-topic-sync-"));
  const runtimeDirectory = join(repo, "runtime");
  mkdirSync(runtimeDirectory);
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    bootstrapLocalFoundation(paths, AT);
    const foundation = new LocalFoundationStore(paths.database);
    const alice = foundation.addAgent("alice", "codex", AT);
    const bob = foundation.addAgent("bob", "codex", AT);
    const charlie = foundation.addAgent("charlie", "codex", AT);
    foundation.close();
    const inbox = new TopicInboxStore(paths.topicInbox);
    const chat = new LocalChatStore(paths.database);
    const requestedAfter: number[] = [];
    let failAck = true;
    let acknowledgeCalls = 0;
    const missingProfileError = new Error("Agent public profile was not found");
    const transientProfileError = new Error("temporary profile transport failure");
    let profileFailure: "missing" | "transient" = "missing";
    const client: TopicSyncClient = {
      async runtimeTopics() {
        return [{
          subscription: {
            topicId: TOPIC_ID,
            runtimeId: "device-a",
            status: "active",
            cursor: 0,
            createdAt: AT,
            updatedAt: AT
          },
          agentIds: [SERVER_AGENT_ID, SERVER_AGENT_BOB_ID, MISSING_SERVER_AGENT_ID]
        }];
      },
      async topic() {
        return {
          id: TOPIC_ID,
          name: "Public research",
          visibility: "public",
          ownerHumanId: "human-a",
          profile: {
            topicId: TOPIC_ID,
            purpose: "Bounded public research",
            participationRules: ["Disclose automation."],
            expressionRules: ["Label uncertainty."],
            revision: 2,
            updatedAt: AT
          },
          createdAt: AT
        };
      },
      async agentProfile(agentId) {
        if (agentId === MISSING_SERVER_AGENT_ID) {
          throw profileFailure === "missing" ? missingProfileError : transientProfileError;
        }
        return {
          agentId,
          displayName: "Alice Researcher",
          role: "Independent Agent",
          disclosure: "Automated Agent",
          expressionRules: ["Separate evidence from inference."],
          revision: 3,
          updatedAt: AT
        };
      },
      isMissingAgentProfileError(error) {
        return error === missingProfileError;
      },
      async topicEvents(_topicId, after) {
        requestedAfter.push(after);
        return {
          topicId: TOPIC_ID,
          runtimeId: "device-a",
          events: [{
            eventId: EVENT_ID,
            topicId: TOPIC_ID,
            sequence: 1,
            publisher: {
              kind: "agent",
              agentId: SERVER_AGENT_ID,
              agentName: "alice",
              ownerHumanId: "human-a",
              ownerDisplayName: "Alice",
              deviceId: "device-a"
            },
            transactionId: "topic-transaction-1",
            body: "Passive event",
            agentProfileRevision: 3,
            topicProfileRevision: 2,
            createdAt: AT
          }, {
            eventId: HUMAN_EVENT_ID,
            topicId: TOPIC_ID,
            sequence: 2,
            publisher: {
              kind: "human",
              humanId: "human-a",
              displayName: "Alice",
              deviceId: "device-a"
            },
            transactionId: "topic-human-transaction-1",
            body: "@alice Human question",
            topicProfileRevision: 2,
            createdAt: AT
          }],
          nextCursor: 2,
          head: 2
        };
      },
      async acknowledgeTopic(_topicId, cursor) {
        acknowledgeCalls += 1;
        assert.equal(existsSync(paths.topicInbox), true);
        assert.equal(inbox.cursor(TOPIC_ID), 2);
        if (failAck) {
          failAck = false;
          throw new Error("simulated lost ack");
        }
        return {
          topicId: TOPIC_ID,
          runtimeId: "device-a",
          status: "active",
          cursor,
          createdAt: AT,
          updatedAt: AT
        };
      }
    };
    const agents = [alice, bob, charlie];
    const serverAgentIds = new Map([
      [alice.handle, SERVER_AGENT_ID],
      [bob.handle, SERVER_AGENT_BOB_ID],
      [charlie.handle, MISSING_SERVER_AGENT_ID]
    ]);
    const topics = new ServerTopicRuntimeBridge({
      localTopicId: "local-topic",
      listAgents: () => agents,
      serverAgentIdForHandle: (handle) => serverAgentIds.get(handle),
      hasTopicPublisher: (agentId) => agentId !== MISSING_SERVER_AGENT_ID,
      inbox,
      chat
    });
    const sync = () => new PassiveTopicSync({
      client,
      inbox: new TopicInboxStore(paths.topicInbox),
      participants: topics.participants,
      admitHumanEvent: topics.admitHumanEvent,
      admitAgentEvent: topics.admitAgentEvent,
      now: () => new Date(AT)
    });
    await assert.rejects(() => sync().syncOnce(), /simulated lost ack/);
    assert.equal(inbox.topics()[0]?.events.length, 2);
    assert.equal(inbox.cursor(TOPIC_ID), 2);

    const resumed = await sync().syncOnce();
    assert.deepEqual(requestedAfter, [0, 2]);
    assert.equal(resumed.admitted, 2);
    assert.equal(resumed.profileFailures, 1);
    assert.equal(inbox.topics()[0]?.events.length, 2);
    const resolution = inbox.profileResolution(alice.principalId, TOPIC_ID);
    assert.equal(resolution.kind, "public");
    if (resolution.kind === "public") {
      assert.equal(resolution.context?.agent.revision, 3);
      assert.throws(() => parseChatProfileContext(
        resolution.context,
        alice.principalId,
        TOPIC_ID,
        "2026-07-27T12:06:00.000Z"
      ), /stale/);
    }

    const database = new DatabaseSync(paths.database, { readOnly: true });
    try {
      assert.equal(count(database, "events"), 2);
      assert.equal(count(database, "executions"), 1);
      const admitted = database.prepare(`
        SELECT source_kind, source_external_id, payload_json
        FROM events WHERE source_external_id = ?
      `).get(HUMAN_EVENT_ID) as {
        source_kind: string;
        source_external_id: string;
        payload_json: string;
      };
      assert.equal(admitted.source_kind, "server");
      assert.equal(admitted.source_external_id, HUMAN_EVENT_ID);
      const payload = JSON.parse(admitted.payload_json);
      assert.equal(payload.body, "@alice Human question");
      assert.deepEqual(payload.targets, [{
        principalId: alice.principalId,
        handleSnapshot: "alice"
      }]);
      const agentPayload = JSON.parse((database.prepare(`
        SELECT payload_json FROM events WHERE source_external_id = ?
      `).get(EVENT_ID) as { payload_json: string }).payload_json);
      assert.equal(agentPayload.sender.kind, "agent");
      assert.equal(agentPayload.sender.principalId, alice.principalId);
      assert.equal(agentPayload.conversation, undefined);
    } finally {
      database.close();
    }
    const runtime = new RuntimeStore(paths.database);
    try {
      const executions = runtime.claimDueExecutions(2, AT);
      const dispatched = executions.flatMap((execution) => new ChatHandler({
          store: runtime,
          chat,
          listAgents: topics.agentsForTopic,
          resolveProfileContext: topics.profileResolution
        }).handle(execution, AT));
      assert.equal(dispatched.length, 1);
      const dispatchEvents = dispatched.map((eventId) => runtime.event(eventId))
        .filter((event) => event?.type === "chat.dispatch");
      assert.deepEqual(
        dispatchEvents.map((event) => event.agentId).sort(),
        [alice.principalId]
      );
      const dispatch = dispatchEvents[0]!;
      const replyRoute = topics.resolveChatReplyRoute(dispatch);
      assert.equal(replyRoute?.continueAttention, true);
      assert.equal(replyRoute?.delivery?.kind, "server-topic");
      assert.equal(
        replyRoute?.delivery?.address.agentId,
        dispatch.agentId === alice.principalId ? SERVER_AGENT_ID : SERVER_AGENT_BOB_ID
      );
      assert.equal(
        topics.resolveChatReplyRoute(dispatch)?.delivery?.destinationId,
        replyRoute?.delivery?.destinationId
      );
      assert.equal(runtime.claimDueExecutions(10, AT).length, 1);
    } finally {
      runtime.close();
    }
    profileFailure = "transient";
    const acknowledgedBeforeTransientFailure = acknowledgeCalls;
    await assert.rejects(() => sync().syncOnce(), /temporary profile transport failure/);
    assert.equal(acknowledgeCalls, acknowledgedBeforeTransientFailure);
    assert.equal(inbox.cursor(TOPIC_ID), 2);
    chat.close();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function count(database: DatabaseSync, table: string): number {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  }).count;
}

function topicSummary() {
  return {
    id: TOPIC_ID,
    name: "Public research",
    visibility: "public",
    ownerHumanId: "human-a",
    profile: {
      topicId: TOPIC_ID,
      purpose: "Bounded public research",
      participationRules: ["Disclose automation."],
      expressionRules: ["Label uncertainty."],
      revision: 2,
      updatedAt: AT
    },
    createdAt: AT
  };
}

function legacyAgentEvent() {
  return {
    eventId: EVENT_ID,
    topicId: TOPIC_ID,
    sequence: 1,
    publisherAgentId: SERVER_AGENT_ID,
    publisher: {
      agentId: SERVER_AGENT_ID,
      agentName: "alice",
      ownerHumanId: "human-a",
      ownerDisplayName: "Alice",
      deviceId: "device-a"
    },
    transactionId: "topic-transaction-1",
    body: "Passive event",
    agentProfileRevision: 3,
    topicProfileRevision: 2,
    createdAt: AT
  };
}
