import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  clientHistoryAudits,
  grantClientHistoryAccess,
  listCodexClientThreads,
  readCodexClientThread,
  revokeClientHistoryAccess
} from "../src/application/activity/client-history.js";
import {
  callClientHistoryTool,
  clientHistoryToolDefinitions
} from "../src/entrypoints/mcp/client-history.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import {
  bootstrapLocalFoundation,
  LocalFoundationStore
} from "../src/infrastructure/sqlite/foundation-store.js";
import { admitSameClientHistoryPolicy } from "../src/modules/agent/activity-policy.js";
import { codexAppServerPolicyObservation } from
  "../src/integrations/agent/provider-policy.js";

const NOW = "2026-08-12T04:00:00.000Z";
const SINCE = "2026-08-10T16:00:00.000Z";
const UNTIL = "2026-08-11T16:00:00.000Z";
const POLICY = admitSameClientHistoryPolicy(codexAppServerPolicyObservation(
  {
    approvalPolicy: "never",
    sandbox: "read-only",
    config: {
      shell_environment_policy: {
        exclude: ["ROLLERSKATE_CLIENT_HISTORY_POLICY"]
      }
    }
  },
  "codex-thread-tool-test"
));

test("Codex thread policy rejects a shell-visible authority environment", () => {
  assert.throws(() => admitSameClientHistoryPolicy(codexAppServerPolicyObservation(
    { approvalPolicy: "never", sandbox: "read-only", config: {} },
    "codex-thread-tool-unsafe-test"
  )), /history policy environment/);
});

test("Codex thread tools enumerate yesterday without literal search and recheck revoke", () => {
  const repo = mkdtempSync(join(tmpdir(), "rollerskate-codex-tools-"));
  const runtimeDirectory = join(repo, "runtime");
  const home = join(repo, "home");
  const active = join(home, ".codex", "sessions", "2026", "08", "11");
  const archived = join(home, ".codex", "archived_sessions");
  mkdirSync(runtimeDirectory, { recursive: true });
  mkdirSync(active, { recursive: true });
  mkdirSync(archived, { recursive: true });
  try {
    const paths = runtimePaths(repo, runtimeDirectory);
    bootstrapLocalFoundation(paths, NOW);
    const foundation = new LocalFoundationStore(paths.database);
    const agent = foundation.addAgent("codex", "codex", NOW);
    foundation.close();
    const activeSession = "11111111-1111-4111-8111-111111111111";
    const archivedSession = "22222222-2222-4222-8222-222222222222";
    const currentSession = "33333333-3333-4333-8333-333333333333";
    writeRollout(
      join(active, `rollout-2026-08-11T09-00-00-${activeSession}.jsonl`),
      activeSession,
      "2026-08-11T01:00:00.000Z",
      "Ship the adapter without keyword lookup.",
      "Implemented time-window enumeration and token=do-not-copy."
    );
    writeRollout(
      join(archived, `rollout-2026-08-11T13-00-00-${archivedSession}.jsonl`),
      archivedSession,
      "2026-08-11T05:00:00.000Z",
      "Review yesterday's release evidence.",
      "The release gate passed."
    );
    writeRollout(
      join(active, `rollout-2026-08-11T14-00-00-${currentSession}.jsonl`),
      currentSession,
      "2026-08-11T06:00:00.000Z",
      "This current request must not self-match.",
      "Current session."
    );
    const options = {
      runtimeDirectory,
      homeDirectory: home,
      policyReceipt: POLICY,
      excludedProviderSessionId: currentSession,
      excludeSessionsStartedAtOrAfter: NOW,
      now: () => new Date(NOW)
    };

    assert.throws(() => listCodexClientThreads(repo, agent.principalId, {
      since: SINCE,
      until: UNTIL,
      limit: 20
    }, options), /not granted/);
    grantClientHistoryAccess(repo, agent.principalId, options);
    assert.throws(() => listCodexClientThreads(repo, agent.principalId, {
      since: "2026-08-11",
      until: UNTIL,
      limit: 20
    }, options), /explicit offset/);
    const listed = listCodexClientThreads(repo, agent.principalId, {
      since: SINCE,
      until: UNTIL,
      limit: 20
    }, options);

    assert.equal(listed.schema, "CodexClientThreadListResult@1");
    assert.equal(listed.timeZone, "Asia/Shanghai");
    assert.equal(listed.items.length, 2);
    assert.deepEqual(new Set(listed.items.map((item) => item.state)),
      new Set(["active", "archived"]));
    assert.equal(listed.coverage.excluded, 1);
    assert.doesNotMatch(JSON.stringify(listed), /33333333|current request/i);
    assert.doesNotMatch(JSON.stringify(listed), /\.codex|rollout-/);

    const activeReference = listed.items.find((item) =>
      item.preview.includes("adapter"))?.reference;
    assert.ok(activeReference);
    const read = readCodexClientThread(repo, agent.principalId, activeReference, options);
    assert.equal(read.messages.length, 2);
    assert.match(JSON.stringify(read), /time-window enumeration/);
    assert.match(JSON.stringify(read), /\[REDACTED\]/);

    const definitions = clientHistoryToolDefinitions(NOW);
    assert.deepEqual(definitions.map((definition) => definition.name),
      ["list_client_threads", "read_client_thread"]);
    const throughMcp = callClientHistoryTool({
      repoRoot: repo,
      agentId: agent.principalId,
      now: NOW,
      options
    }, "list_client_threads", { since: SINCE, until: UNTIL, limit: 1 });
    assert.equal((throughMcp as { items: unknown[] }).items.length, 1);

    revokeClientHistoryAccess(repo, agent.principalId, options);
    assert.throws(
      () => callClientHistoryTool({
        repoRoot: repo,
        agentId: agent.principalId,
        now: NOW,
        options
      }, "read_client_thread", { reference: activeReference }),
      /not granted/
    );
    const denied = clientHistoryAudits(repo, agent.principalId, options).at(-1);
    assert.equal(denied?.action, "read");
    assert.equal(denied?.outcome, "failed");
    assert.equal(denied?.failureReason, "grant-inactive");
    assert.deepEqual(
      clientHistoryAudits(repo, agent.principalId, options)
        .filter((audit) => audit.outcome === "succeeded")
        .map((audit) => audit.action),
      ["list", "read", "list"]
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

function writeRollout(
  path: string,
  sessionId: string,
  startedAt: string,
  user: string,
  assistant: string
): void {
  writeFileSync(path, [
    JSON.stringify({
      timestamp: startedAt,
      type: "session_meta",
      payload: {
        id: sessionId,
        session_id: sessionId,
        timestamp: startedAt,
        cwd: "/workspace/rollerskate"
      }
    }),
    JSON.stringify({
      timestamp: startedAt,
      type: "event_msg",
      payload: { type: "user_message", message: user }
    }),
    JSON.stringify({
      timestamp: startedAt,
      type: "event_msg",
      payload: { type: "agent_message", message: assistant }
    })
  ].join("\n") + "\n");
  const at = new Date(startedAt);
  utimesSync(path, at, at);
}
