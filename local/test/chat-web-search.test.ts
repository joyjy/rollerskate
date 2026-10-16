import assert from "node:assert/strict";
import { chmodSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { temporaryDirectory } from "./support/temp-directory.js";
import { addLocalAgent } from "../src/application/agent/control.js";
import { postLocalChatMessage } from "../src/application/chat/control.js";
import { chatWebSearchEnabled, inspectWebSearchAccess, setWebSearchAccess } from "../src/application/chat/web-search.js";
import { materializeLocalTopicGovernance, removeLocalTopicParticipant } from "../src/application/topic/governance-control.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { chatPromptResourceId } from "../src/core/chat/model.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { startUiServer } from "../src/entrypoints/console/launcher.js";
import { WebSearchAccessStore } from "../src/infrastructure/files/web-search-access-store.js";

test("native search is resolved from current Owner grant, roster and running dispatch", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const runtimeDirectory = temporaryDirectory("rs-native-search-");
  const options = {runtimeDirectory};
  const agent = addLocalAgent(repoRoot, "alice", "codex", options);
  const kimi = addLocalAgent(repoRoot, "kimi", "kimi-code", options);
  const governance = materializeLocalTopicGovernance(repoRoot, runtimeDirectory);
  assert.equal(inspectWebSearchAccess(repoRoot, agent.principalId, agent.client, runtimeDirectory).status, "revoked");
  assert.throws(() => setWebSearchAccess(repoRoot, kimi.principalId, true, runtimeDirectory), /no supported native search switch/);
  const database = openRuntimeDatabase(join(runtimeDirectory, "runtime.db"));
  const runtime = new RuntimeStore(database);
  try {
    const at = () => new Date().toISOString();
    const message = postLocalChatMessage(repoRoot, "@alice search the web", options).message;
    const execution = runtime.claimDueExecutions(100, at()).find(item => item.eventId === message.eventId)!;
    const dispatch = runtime.admitChatAttention(execution.executionId, [{plan: {
      agentId: agent.principalId, handle: agent.handle, outcome: "dispatch", reason: "direct-mention",
      presenceSnapshot: {global: {scope: "global", mode: "available", wakeKeywords: []}, topic: {scope: "topic", mode: "available", wakeKeywords: []}}
    }, prompt: "fixture", promptResourceId: chatPromptResourceId}], at())[0]!;
    const enabled = () => chatWebSearchEnabled(repoRoot, dispatch, runtimeDirectory);
    setWebSearchAccess(repoRoot, agent.principalId, true, runtimeDirectory);
    assert.equal(enabled(), false, "pending dispatch cannot use tools");
    runtime.claimDueExecutions(100, at());
    assert.equal(enabled(), true);
    setWebSearchAccess(repoRoot, agent.principalId, false, runtimeDirectory);
    assert.equal(enabled(), false, "revocation is read for the next invocation, including same Session");
    setWebSearchAccess(repoRoot, agent.principalId, true, runtimeDirectory);
    const path = join(runtimeDirectory, "web-search-access.json");
    const store = new WebSearchAccessStore(path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const grant = store.inspect(agent.principalId)!;
    assert.deepEqual(store.set(agent.principalId, grant.ownerPrincipalId, true), grant);
    store.set(agent.principalId, "different-owner", true);
    assert.equal(enabled(), false);
    setWebSearchAccess(repoRoot, agent.principalId, true, runtimeDirectory);
    chmodSync(path, 0o644);
    assert.equal(enabled(), false, "invalid private policy fails closed");
    chmodSync(path, 0o600);
    assert.equal(enabled(), true);
    removeLocalTopicParticipant(repoRoot, agent.principalId, governance.governance.revision, options);
    assert.equal(enabled(), false, "removing a participant prevents retained settings from granting tools");
    assert.throws(() => setWebSearchAccess(repoRoot, agent.principalId, true, runtimeDirectory), /Add this participant/);
    setWebSearchAccess(repoRoot, agent.principalId, false, runtimeDirectory);
  } finally {runtime.close(); database.close();}
});


test("Console search control requires its request marker and exposes native capability readback", async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const runtimeDirectory = temporaryDirectory("rs-native-search-api-");
  const agent = addLocalAgent(repoRoot, "alice", "codex", {runtimeDirectory});
  materializeLocalTopicGovernance(repoRoot, runtimeDirectory);
  const controller = new AbortController();
  const server = await startUiServer({repoRoot, runtimeDirectory, port: 0, signal: controller.signal});
  const base = new URL(server.url).origin;
  const endpoint = `${base}/api/chat/agents/${agent.principalId}/web-search-access`;
  const headers = {"Content-Type": "application/json", "X-Rollerskate-Request": "console"};
  try {
    const blocked = await fetch(endpoint, {method: "POST", body: JSON.stringify({action: "grant"})});
    assert.equal(blocked.status, 403);
    const malformed = await fetch(endpoint, {method: "POST", headers, body: JSON.stringify({action: "grant", provider: "unknown-client"})});
    assert.equal(malformed.status, 400);
    const granted = await fetch(endpoint, {method: "POST", headers, body: JSON.stringify({action: "grant"})});
    assert.equal(granted.status, 200);
    assert.deepEqual(await granted.json(), {status: "active", supported: true, tool: "web_search", reason: "Uses Codex native live search"});
    const presence = await (await fetch(`${base}/api/chat/presence`)).json() as {agents: {principalId: string; webSearch: {status: string}}[]};
    assert.equal(presence.agents.find(item => item.principalId === agent.principalId)?.webSearch.status, "active");
    const revoked = await fetch(endpoint, {method: "POST", headers, body: JSON.stringify({action: "revoke"})});
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json() as {status: string}).status, "revoked");
  } finally {controller.abort(); await server.close();}
});
