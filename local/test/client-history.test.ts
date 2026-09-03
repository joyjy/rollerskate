import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { postLocalChatMessage } from "../src/application/chat/control.js";
import { ChatHandler } from "../src/application/chat/handler.js";
import { withChatHistoryContinuation } from
  "../src/application/chat/agent-continuation.js";
import { createChatReadToolContext } from
  "../src/application/chat/read-tool-policy.js";
import {
  clientHistoryAudits,
  grantClientHistoryAccess,
  queryClientHistory,
  revokeClientHistoryAccess
} from "../src/application/activity/client-history.js";
import { AgentHandler } from "../src/core/runtime/handlers.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import type { ChatDispatchEvent } from "../src/core/event/model.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { LocalChatStore } from "../src/infrastructure/sqlite/chat-store.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import {
  admitSameClientHistoryPolicy
} from "../src/modules/agent/activity-policy.js";
import { codexAppServerPolicyObservation } from
  "../src/integrations/agent/provider-policy.js";

const AT = "2026-07-31T11:00:00.000Z";
const CODEX_SESSION = "11111111-1111-4111-8111-111111111111";
const CURRENT_CODEX_SESSION = "33333333-3333-4333-8333-333333333333";
const CLAUDE_SESSION = "22222222-2222-4222-8222-222222222222";
const CODEX_POLICY_OBSERVATION = codexAppServerPolicyObservation(
  {
    approvalPolicy: "never",
    sandbox: "read-only",
    config: {
      shell_environment_policy: {
        exclude: ["ROLLERSKATE_CLIENT_HISTORY_POLICY"]
      }
    }
  },
  "test-codex-hook"
);
const CODEX_HISTORY_POLICY = admitSameClientHistoryPolicy(CODEX_POLICY_OBSERVATION);
const KIMI_POLICY_OBSERVATION = {
  client: "kimi-code",
  controls: {
    prompt: true,
    outputFormat: "stream-json",
    agentFile: "bundled-read-only",
    auto: true,
    yolo: false
  },
  hook: { state: "enforced", helperDigest: "a".repeat(64) }
} as const;
const KIMI_HISTORY_POLICY = admitSameClientHistoryPolicy(KIMI_POLICY_OBSERVATION);

test("same-client history is explicit, bounded, redacted, audited and revocable", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-client-history-"));
  const runtimeDirectory = join(repo, "runtime");
  const codexRoot = join(repo, "sources", "codex");
  const claudeRoot = join(repo, "sources", "claude");
  mkdirSync(runtimeDirectory, { recursive: true });
  mkdirSync(codexRoot, { recursive: true });
  mkdirSync(claudeRoot, { recursive: true });
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    bootstrapLocalFoundation(paths, AT);
    const foundation = new LocalFoundationStore(paths.database);
    const alice = foundation.addAgent("alice", "codex", AT);
    foundation.addAgent("bob", "claude-code", AT);
    foundation.close();
    writeFileSync(
      join(codexRoot, `rollout-${CODEX_SESSION}.jsonl`),
      `${JSON.stringify({ message: "x".repeat(128_000) })}\n${JSON.stringify({
        message: "Old launch plan uses token=secret-value and needs a rollback."
      })}\n${JSON.stringify({ message: "x".repeat(80_000) })}\n`
    );
    writeFileSync(
      join(codexRoot, `rollout-${CURRENT_CODEX_SESSION}.jsonl`),
      `${JSON.stringify({
        message: JSON.stringify({
          schema: "ClientHistoryRequest@1",
          action: "search",
          query: "launch plan",
          limit: 5
        })
      })}\n`
    );
    writeFileSync(
      join(claudeRoot, `${CLAUDE_SESSION}.jsonl`),
      `${JSON.stringify({ message: "Claude-only private history" })}\n`
    );
    const options = {
      runtimeDirectory,
      sourceRoots: {
        codex: codexRoot,
        "claude-code": claudeRoot
      },
      policyReceipt: CODEX_HISTORY_POLICY,
      excludedProviderSessionId: CURRENT_CODEX_SESSION,
      now: () => new Date(AT)
    };
    const search = {
      schema: "ClientHistoryRequest@1" as const,
      action: "search" as const,
      query: "launch plan",
      limit: 5
    };

    assert.throws(
      () => queryClientHistory(repo, alice.principalId, search, options),
      /not granted/
    );
    const grant = grantClientHistoryAccess(repo, alice.principalId, options);
    assert.equal(grant.client, "codex");
    assert.throws(
      () => queryClientHistory(repo, alice.principalId, search, {
        runtimeDirectory,
        sourceRoots: options.sourceRoots,
        now: options.now
      }),
      /provider policy receipt/
    );
    const policyAudit = clientHistoryAudits(repo, alice.principalId, options).at(-1);
    assert.equal(policyAudit?.outcome, "failed");
    assert.equal(policyAudit?.failureReason, "policy-rejected");
    assert.equal(policyAudit?.policyFingerprint, undefined);
    const found = queryClientHistory(repo, alice.principalId, search, options);
    assert.equal(found.client, "codex");
    assert.equal(found.items.length, 1);
    assert.match(found.items[0]!.content, /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(found), /Claude-only/);

    const read = queryClientHistory(repo, alice.principalId, {
      schema: "ClientHistoryRequest@1",
      action: "read",
      reference: found.items[0]!.reference
    }, options);
    assert.equal(read.items.length, 1);
    assert.match(read.items[0]!.content, /rollback/);
    assert.throws(() => queryClientHistory(repo, alice.principalId, {
      schema: "ClientHistoryRequest@1",
      action: "read",
      reference: "claude-code:aaaaaaaaaaaaaaaaaaaaaaaa"
    }, options), /another client/);
    assert.deepEqual(
      clientHistoryAudits(repo, alice.principalId, options).map((audit) => audit.action),
      ["grant", "search", "search", "read", "read"]
    );
    assert.equal(
      clientHistoryAudits(repo, alice.principalId, options).at(-1)?.failureReason,
      "cross-client-reference"
    );

    revokeClientHistoryAccess(repo, alice.principalId, options);
    assert.throws(
      () => queryClientHistory(repo, alice.principalId, search, options),
      /not granted/
    );

    grantClientHistoryAccess(repo, alice.principalId, options);
    const document = JSON.parse(readFileSync(paths.clientHistoryAccess, "utf8")) as {
      grants: Array<{ ownerPrincipalId: string }>;
    };
    document.grants[0]!.ownerPrincipalId = "prn_another-owner";
    writeFileSync(paths.clientHistoryAccess, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600
    });
    assert.throws(
      () => queryClientHistory(repo, alice.principalId, search, options),
      /not granted/
    );
    const recovered = grantClientHistoryAccess(repo, alice.principalId, options);
    assert.notEqual(recovered.ownerPrincipalId, "prn_another-owner");
    assert.throws(
      () => queryClientHistory(repo, alice.principalId, search, {
        ...options,
        sourceRoots: {
          ...options.sourceRoots,
          codex: join(repo, "sources", "missing-codex")
        }
      }),
      /source is unavailable/
    );
    const failedAudit = clientHistoryAudits(repo, alice.principalId, options).at(-1);
    assert.equal(failedAudit?.outcome, "failed");
    assert.equal(failedAudit?.failureReason, "source-unavailable");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("same-client history search excludes the current Kimi provider Session", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-kimi-history-"));
  const runtimeDirectory = join(repo, "runtime");
  const kimiRoot = join(repo, "sources", "kimi");
  const currentSession = "ses_current";
  const previousSession = "ses_previous";
  mkdirSync(runtimeDirectory, { recursive: true });
  mkdirSync(join(kimiRoot, `session_${currentSession}`), { recursive: true });
  mkdirSync(join(kimiRoot, `session_${previousSession}`), { recursive: true });
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    bootstrapLocalFoundation(paths, AT);
    const foundation = new LocalFoundationStore(paths.database);
    const kimi = foundation.addAgent("kimi", "kimi-code", AT);
    foundation.close();
    writeFileSync(
      join(kimiRoot, `session_${currentSession}`, "wire.jsonl"),
      `${JSON.stringify({
        message: JSON.stringify({
          schema: "ClientHistoryRequest@1",
          action: "search",
          query: "governance boundaries",
          limit: 10
        })
      })}\n`
    );
    writeFileSync(
      join(kimiRoot, `session_${previousSession}`, "wire.jsonl"),
      `${JSON.stringify({ message: "Earlier governance boundaries decision." })}\n`
    );
    const options = {
      runtimeDirectory,
      sourceRoots: { "kimi-code": kimiRoot },
      policyReceipt: KIMI_HISTORY_POLICY,
      excludedProviderSessionId: `rollerskate-kimi-session-v1:read:${currentSession}`,
      now: () => new Date(AT)
    };
    grantClientHistoryAccess(repo, kimi.principalId, options);

    const result = queryClientHistory(repo, kimi.principalId, {
      schema: "ClientHistoryRequest@1",
      action: "search",
      query: "governance boundaries",
      limit: 10
    }, options);

    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.content, "Earlier governance boundaries decision.");
    assert.doesNotMatch(JSON.stringify(result), /ClientHistoryRequest@1/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Codex Chat advertises real thread tools instead of JSON history requests", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-client-history-chat-"));
  const runtimeDirectory = join(repo, "runtime");
  mkdirSync(runtimeDirectory, { recursive: true });
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    bootstrapLocalFoundation(paths, AT);
    const foundation = new LocalFoundationStore(paths.database);
    const alice = foundation.addAgent("alice", "codex", AT);
    foundation.close();
    const source = postLocalChatMessage(repo, "What did we decide before?", {
      runtimeDirectory,
      now: () => new Date(AT)
    }).message;
    const runtime = new RuntimeStore(paths.database);
    const chat = new LocalChatStore(paths.database);
    try {
      const chatExecution = runtime.claimDueExecutions(1, AT)[0]!;
      const dispatchId = new ChatHandler({
        store: runtime,
        chat,
        listAgents: () => [alice],
        resolveClientHistory: () => ({
          schema: "ClientThreadToolsCapability@1",
          scope: "same-client-history-read",
          client: "codex",
          tools: ["list_client_threads", "read_client_thread"],
          timeZone: "Asia/Shanghai"
        })
      }).handle(chatExecution, AT)[0]!;
      const dispatch = runtime.event(dispatchId);
      assert.equal(dispatch?.type, "chat.dispatch");
      if (dispatch?.type !== "chat.dispatch") return;
      assert.match(dispatch.prompt, /ClientThreadToolsCapability@1/);
      assert.match(dispatch.prompt, /list_client_threads/);
      assert.match(dispatch.prompt, /never return `ClientHistoryRequest@1` for Codex/);
      assert.doesNotMatch(dispatch.prompt, /Earlier decision content/);

      let calls = 0;
      const agentExecution = runtime.claimDueExecutions(1, AT)[0]!;
      const adapter = withChatHistoryContinuation({
        adapterId: "fixture",
        workspace: repo,
        providerPolicy: CODEX_POLICY_OBSERVATION,
        async invoke(input) {
          calls += 1;
          assert.equal(input.providerSessionId, undefined);
          return {
            providerSessionId: "same-provider-session",
            outcome: {
              kind: "message" as const,
              body: JSON.stringify({
                schema: "ChatDecision@1",
                speech: { action: "reply", body: "We chose the bounded option." },
                presence: { scope: "topic", mode: "available", wakeKeywords: [] }
              })
            }
          };
        }
      }, {
        chatHistory: () => {
          throw new Error("Chat history was not requested");
        },
        clientHistory: () => {
          throw new Error("Codex JSON history continuation must be disabled");
        }
      });
      const reply = await new AgentHandler({
        store: runtime,
        adapters: new Map([[alice.principalId, adapter]])
      }).handle(agentExecution, AT);
      assert.equal(calls, 1);
      assert.equal(reply?.type, "chat.message");
      assert.equal(reply?.type === "chat.message" ? reply.body : undefined,
        "We chose the bounded option.");
      assert.equal(source.sender.kind, "owner");
    } finally {
      chat.close();
      runtime.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("non-Codex Chat keeps structured same-client history continuation", async () => {
  let calls = 0;
  const adapter = withChatHistoryContinuation({
    adapterId: "kimi-fixture",
    workspace: "/workspace",
    providerPolicy: KIMI_POLICY_OBSERVATION,
    async invoke(input) {
      calls += 1;
      if (calls === 1) return {
        providerSessionId: "kimi-session",
        outcome: {
          kind: "message" as const,
          body: JSON.stringify({
            schema: "ClientHistoryRequest@1",
            action: "search",
            query: "prior decision",
            limit: 5
          })
        }
      };
      assert.equal(input.providerSessionId, "kimi-session");
      assert.match(input.event.prompt, /bounded prior decision/);
      return {
        providerSessionId: "kimi-session",
        outcome: {
          kind: "message" as const,
          body: JSON.stringify({
            schema: "ChatDecision@1",
            speech: { action: "silent", reason: "History confirmed." },
            presence: { scope: "topic", mode: "available", wakeKeywords: [] }
          })
        }
      };
    }
  }, {
    chatHistory: () => {
      throw new Error("Chat history was not requested");
    },
    clientHistory: (_agentId, request, policyReceipt, currentProviderSessionId) => {
      assert.equal(request.action, "search");
      assert.equal(policyReceipt?.fingerprint, KIMI_HISTORY_POLICY.fingerprint);
      assert.equal(currentProviderSessionId, "kimi-session");
      return {
        schema: "ClientHistoryResult@1",
        client: "kimi-code",
        action: "search",
        items: [{
          reference: "kimi-code:aaaaaaaaaaaaaaaaaaaaaaaa",
          occurredAt: AT,
          content: "bounded prior decision"
        }],
        truncated: false
      };
    }
  });

  const eventId = "evt_019f92c9-0000-7000-8000-000000000004";
  const result = await adapter.invoke({
    event: {
      eventId,
      type: "chat.dispatch",
      source: { kind: "handler" },
      agentId: "prn_kimi",
      topicId: "topic-local",
      sourceAttentionEventId: eventId,
      targetHandleSnapshot: "kimi",
      promptResourceId: "rollerskate.chat.free-turn.v1",
      prompt: "respond",
      destinationIds: [],
      causality: { rootEventId: eventId, hop: 1 },
      createdAt: AT
    } satisfies ChatDispatchEvent
  });

  assert.equal(calls, 2);
  assert.equal(result.providerSessionId, "kimi-session");
});

test("Kimi Chat can use the provider-neutral safe read request fallback", async () => {
  let calls = 0;
  const adapter = withChatHistoryContinuation({
    adapterId: "kimi-read-tools-fixture",
    workspace: "/workspace",
    providerPolicy: KIMI_POLICY_OBSERVATION,
    async invoke(input) {
      calls += 1;
      if (calls === 1) return {
        providerSessionId: "kimi-read-tools-session",
        outcome: {
          kind: "message" as const,
          body: JSON.stringify({
            schema: "ChatReadToolRequest@1",
            tool: "describe_capabilities",
            arguments: {}
          })
        }
      };
      assert.equal(input.providerSessionId, "kimi-read-tools-session");
      assert.match(input.event.prompt, /ChatReadCapabilities@1/);
      assert.match(input.event.prompt, /mutationAllowed/);
      return {
        providerSessionId: "kimi-read-tools-session",
        outcome: {
          kind: "message" as const,
          body: JSON.stringify({
            schema: "ChatDecision@1",
            speech: { action: "silent", reason: "Capabilities confirmed." },
            presence: { scope: "topic", mode: "available", wakeKeywords: [] }
          })
        }
      };
    }
  }, {
    chatHistory: () => {
      throw new Error("Chat history was not requested");
    },
    clientHistory: () => {
      throw new Error("Client history was not requested");
    },
    chatReadTools: () => createChatReadToolContext({ repoRoot: "/repo" })
  });
  const eventId = "evt_019f92c9-0000-7000-8000-000000000005";
  const result = await adapter.invoke({
    event: {
      eventId,
      type: "chat.dispatch",
      source: { kind: "handler" },
      agentId: "prn_kimi",
      topicId: "topic-local",
      sourceAttentionEventId: eventId,
      targetHandleSnapshot: "kimi",
      promptResourceId: "rollerskate.chat.free-turn.v1",
      prompt: "respond",
      destinationIds: [],
      causality: { rootEventId: eventId, hop: 1 },
      createdAt: AT
    } satisfies ChatDispatchEvent
  });
  assert.equal(calls, 2);
  assert.equal(result.providerSessionId, "kimi-read-tools-session");
});
