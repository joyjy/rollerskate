import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { addLocalAgent } from "../src/application/agent/control.js";
import { postLocalChatMessage } from "../src/application/chat/control.js";
import { chatPromptResourceId } from "../src/core/chat/model.js";
import type { ChatAttentionPlan } from "../src/core/chat/state-machine.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { startUiServer } from "../src/entrypoints/console/launcher.js";

test("Console confirms only the current Chat Run proposal revision", async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "rollerskate-proposal-api-"));
  const at = "2026-09-02T04:00:00.000Z";
  const alice = addLocalAgent(repoRoot, "alice-proposal-api", "codex", {
    runtimeDirectory
  });
  addLocalAgent(repoRoot, "codex", "codex", { runtimeDirectory });
  const source = postLocalChatMessage(repoRoot, "@alice-proposal-api inspect this", {
    runtimeDirectory,
    now: () => new Date(at)
  }).message;
  let declinedSource: { eventId: string; dispatchEventId: string } | undefined;
  const runtime = new RuntimeStore(join(runtimeDirectory, "runtime.db"));
  try {
    const chatExecution = runtime.claimDueExecutions(1, at)[0]!;
    runtime.admitChatAttention(chatExecution.executionId, [{
      plan: availablePlan(alice.principalId, alice.handle),
      prompt: "proposal prompt",
      promptResourceId: chatPromptResourceId
    }], at);
    const agentExecution = runtime.claimDueExecutions(1, at)[0]!;
    runtime.completeExecution(agentExecution.executionId, {
      adapterId: "fixture",
      workspace: repoRoot,
      providerSessionId: "proposal-api-session",
      chatDecision: {
        schema: "ChatDecision@2",
        speech: {
          action: "propose_run",
          proposal: {
            schema: "ChatRunProposalDraft@1",
            goal: "Inspect the API fixture",
            scope: { include: ["Read the fixture"], exclude: [] },
            acceptance: ["Report the result"],
            desiredEffect: "read"
          }
        },
        presence: { scope: "topic", mode: "available", wakeKeywords: [] }
      }
    }, at);
    const secondSource = postLocalChatMessage(
      repoRoot,
      "@alice-proposal-api propose an alternative",
      { runtimeDirectory, now: () => new Date("2026-09-02T04:00:01.000Z") }
    ).message;
    const secondChatExecution = runtime.claimDueExecutions(
      1,
      "2026-09-02T04:00:01.000Z"
    )[0]!;
    const secondDispatch = runtime.admitChatAttention(secondChatExecution.executionId, [{
      plan: availablePlan(alice.principalId, alice.handle),
      prompt: "alternative proposal prompt",
      promptResourceId: chatPromptResourceId
    }], "2026-09-02T04:00:01.000Z")[0]!;
    const secondAgentExecution = runtime.claimDueExecutions(
      1,
      "2026-09-02T04:00:01.000Z"
    )[0]!;
    runtime.completeExecution(secondAgentExecution.executionId, {
      adapterId: "fixture",
      workspace: repoRoot,
      providerSessionId: "proposal-api-session",
      chatDecision: {
        schema: "ChatDecision@2",
        speech: {
          action: "propose_run",
          proposal: {
            schema: "ChatRunProposalDraft@1",
            goal: "Inspect the alternative",
            scope: { include: ["Read the alternative"], exclude: [] },
            acceptance: ["Report the alternative"],
            desiredEffect: "none"
          }
        },
        presence: { scope: "topic", mode: "available", wakeKeywords: [] }
      }
    }, "2026-09-02T04:00:01.000Z");
    declinedSource = {
      eventId: secondSource.eventId,
      dispatchEventId: secondDispatch.eventId
    };
  } finally {
    runtime.close();
  }

  const controller = new AbortController();
  try {
    const server = await startUiServer({
      repoRoot,
      runtimeDirectory,
      port: 0,
      signal: controller.signal
    });
    const origin = new URL(server.url).origin;
    try {
      const chat = await jsonRequest(`${origin}/api/chat`);
      const proposal = (chat.body as {
        messages: { items: Array<{ eventId: string; runProposals?: Array<{
          revision: string;
          ready: boolean;
          dispatchEventId: string;
          blocker?: { code: string };
        }> }> };
      }).messages.items.find(({ eventId }) => eventId === source.eventId)?.runProposals?.[0];
      assert.ok(proposal);
      assert.equal(proposal.ready, false);
      assert.equal(proposal.blocker?.code, "workspace_required");

      const checked = await jsonRequest(
        `${origin}/api/chat/proposals/${source.eventId}/${proposal.dispatchEventId}/preflight`,
        {
          method: "POST",
          headers: consoleHeaders(),
          body: JSON.stringify({ revision: proposal.revision, workspaceKind: "project" })
        }
      );
      assert.equal(checked.response.status, 200, JSON.stringify(checked.body));
      const checkedProposal = (checked.body as {
        proposal: { revision: string; ready: boolean; authority: { workspace: { root: string } } };
      }).proposal;
      assert.equal(checkedProposal.ready, true);
      assert.equal(checkedProposal.authority.workspace.root, repoRoot);

      const unauthorized = await jsonRequest(
        `${origin}/api/chat/proposals/${source.eventId}/${proposal.dispatchEventId}/confirm`,
        {
          method: "POST",
          body: JSON.stringify({
            revision: checkedProposal.revision,
            workspaceKind: "project"
          })
        }
      );
      assert.equal(unauthorized.response.status, 403);

      const stale = await jsonRequest(
        `${origin}/api/chat/proposals/${source.eventId}/${proposal.dispatchEventId}/confirm`,
        {
          method: "POST",
          headers: consoleHeaders(),
          body: JSON.stringify({ revision: "sha256:stale", workspaceKind: "project" })
        }
      );
      assert.equal(stale.response.status, 400);

      const accepted = await jsonRequest(
        `${origin}/api/chat/proposals/${source.eventId}/${proposal.dispatchEventId}/confirm`,
        {
          method: "POST",
          headers: consoleHeaders(),
          body: JSON.stringify({
            revision: checkedProposal.revision,
            workspaceKind: "project"
          })
        }
      );
      assert.equal(accepted.response.status, 201, JSON.stringify(accepted.body));
      const runId = (accepted.body as { run: { runId: string } }).run.runId;

      const duplicate = await jsonRequest(
        `${origin}/api/chat/proposals/${source.eventId}/${proposal.dispatchEventId}/confirm`,
        {
          method: "POST",
          headers: consoleHeaders(),
          body: JSON.stringify({
            revision: checkedProposal.revision,
            workspaceKind: "project"
          })
        }
      );
      assert.equal(duplicate.response.status, 200);
      assert.equal((duplicate.body as { run: { runId: string } }).run.runId, runId);
      const declineStarted = await jsonRequest(
        `${origin}/api/chat/proposals/${source.eventId}/${proposal.dispatchEventId}/decline`,
        {
          method: "POST",
          headers: consoleHeaders(),
          body: JSON.stringify({ revision: proposal.revision })
        }
      );
      assert.equal(declineStarted.response.status, 400);

      assert.ok(declinedSource);
      const beforeDecline = await jsonRequest(`${origin}/api/chat`);
      const declineProposal = (beforeDecline.body as {
        messages: { items: Array<{ eventId: string; runProposals?: Array<{
          revision: string;
          dispatchEventId: string;
        }> }> };
      }).messages.items.find(({ eventId }) =>
        eventId === declinedSource!.eventId)?.runProposals?.[0];
      assert.ok(declineProposal);
      const declined = await jsonRequest(
        `${origin}/api/chat/proposals/${declinedSource.eventId}/` +
          `${declinedSource.dispatchEventId}/decline`,
        {
          method: "POST",
          headers: consoleHeaders(),
          body: JSON.stringify({ revision: declineProposal.revision })
        }
      );
      assert.equal(declined.response.status, 201, JSON.stringify(declined.body));
      const declinedReceipt = declined.body as {
        status: string;
        proposal: {
          decision?: {
            status: string;
            eventId: string;
            actorPrincipalId: string;
            decidedAt: string;
          };
          ready: boolean;
          blocker?: unknown;
        };
      };
      assert.equal(declinedReceipt.status, "declined");
      assert.equal(declinedReceipt.proposal.decision?.status, "declined");
      assert.match(declinedReceipt.proposal.decision?.eventId ?? "", /^evt_/u);
      assert.match(declinedReceipt.proposal.decision?.actorPrincipalId ?? "", /^prn_/u);
      assert.match(declinedReceipt.proposal.decision?.decidedAt ?? "", /Z$/u);
      assert.equal(declinedReceipt.proposal.ready, false);
      assert.equal(declinedReceipt.proposal.blocker, undefined);

      const duplicateDecline = await jsonRequest(
        `${origin}/api/chat/proposals/${declinedSource.eventId}/` +
          `${declinedSource.dispatchEventId}/decline`,
        {
          method: "POST",
          headers: consoleHeaders(),
          body: JSON.stringify({ revision: declineProposal.revision })
        }
      );
      assert.equal(duplicateDecline.response.status, 200);
      const declinedChat = await jsonRequest(`${origin}/api/chat`);
      const declinedReadback = (declinedChat.body as {
        messages: { items: Array<{ eventId: string; runProposals?: Array<{
          decision?: { status: string };
          blocker?: unknown;
          workspaceChoices?: unknown;
        }> }> };
      }).messages.items.find(({ eventId }) =>
        eventId === declinedSource!.eventId)?.runProposals?.[0];
      assert.equal(declinedReadback?.decision?.status, "declined");
      assert.equal(declinedReadback?.blocker, undefined);
      assert.equal(declinedReadback?.workspaceChoices, undefined);
      const linkedReadback = (declinedChat.body as {
        messages: { items: Array<{ eventId: string; runProposals?: Array<{
          linkedRun?: { runId: string };
          blocker?: unknown;
          workspaceChoices?: unknown;
        }> }> };
      }).messages.items.find(({ eventId }) =>
        eventId === source.eventId)?.runProposals?.[0];
      assert.equal(linkedReadback?.linkedRun?.runId, runId);
      assert.equal(linkedReadback?.blocker, undefined);
      assert.equal(linkedReadback?.workspaceChoices, undefined);
    } finally {
      controller.abort();
      await server.close();
    }
  } finally {
    controller.abort();
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

function availablePlan(agentId: string, handle: string): ChatAttentionPlan {
  return {
    agentId,
    handle,
    outcome: "dispatch",
    reason: "direct-mention",
    presenceSnapshot: {
      global: { scope: "global", mode: "available", wakeKeywords: [] },
      topic: { scope: "topic", mode: "available", wakeKeywords: [] }
    }
  };
}

function consoleHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Rollerskate-Request": "console"
  };
}

async function jsonRequest(
  input: string,
  init?: RequestInit
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const response = await fetch(input, init);
  return { response, body: await response.json() as unknown };
}
