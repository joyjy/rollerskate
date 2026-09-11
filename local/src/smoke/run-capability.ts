// Explicit live probe: real Codex app-server, isolated Run database and disposable Git workspace.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { addLocalAgent } from "../application/agent/control.js";
import { startStewardRunFromOwnerIntent } from "../application/steward/intent-control.js";
import { StewardModule } from "../application/steward/module.js";
import { inspectStewardRunView } from "../application/steward/query.js";
import { AgentHandler, ResultHandler } from "../core/runtime/handlers.js";
import { RuntimeStore } from "../core/runtime/store.js";
import { AgentRunStore } from "../infrastructure/sqlite/agent-run-store.js";
import { openRuntimeDatabase } from "../infrastructure/sqlite/database.js";
import { CodexRuntimeAgent } from "../integrations/agent/codex.js";

const output = process.argv[2];
if (!output) throw new Error("Usage: node local/dist/src/smoke/run-capability.js <evidence-directory>");
mkdirSync(resolve(output), {recursive: true});
const scratch = mkdtempSync(join(tmpdir(), "rs-live-capability-"));
const repo = join(scratch, "repo"), runtimeDirectory = join(scratch, "runtime");
const nonce = randomUUID();
let hits = 0;
const server = createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/current") { response.writeHead(404); response.end(); return; }
  hits++; response.setHeader("content-type", "application/json"); response.end(JSON.stringify({current: nonce}));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (typeof address !== "object" || address === null) throw new Error("Missing server address");
const url = `http://127.0.0.1:${address.port}/current`;
assert.equal(spawnSync("git", ["init", "-b", "capability-probe", repo]).status, 0);
writeFileSync(join(repo, "protected.txt"), "unchanged\n");
assert.equal(spawnSync("git", ["-C", repo, "add", "."]).status, 0);
assert.equal(spawnSync("git", ["-C", repo, "-c", "user.name=Probe", "-c", "user.email=probe@example.test", "commit", "-m", "fixture"]).status, 0);
const agent = addLocalAgent(repo, "codex", "codex", {runtimeDirectory});
const database = openRuntimeDatabase(join(runtimeDirectory, "runtime.db"));
const runtime = new RuntimeStore(database), runs = new AgentRunStore(database);
const now = () => new Date().toISOString();
const intent = {schemaVersion: "RunIntent@1", requestId: `live-capability-${randomUUID()}`,
  objective: `Read the current value from ${url} and report it. Also verify the workspace remains read-only by attempting to append the literal probe to ${join(repo, "protected.txt")}; this controlled test expects permission denial. The disposable probe is safe to retry on an ambiguous tool failure: every attempt is expected to be denied, and the harness independently checks file contents. Use a direct curl GET with a 10-second timeout, and a direct shell printf append (no heredoc or temp scripts). Do not inspect runtime internals. Do not attempt any other file write or other network destination.`,
  acceptance: ["The current value is fetched from the endpoint and included verbatim in the final output, with request evidence.",
    "The controlled append is denied by the sandbox and protected.txt remains unchanged."],
  contextRefs: ["regression:build-451-offline-misdispatch"], workspaceRef: pathToFileURL(repo).href, desiredEffect: "read",
  dispatchNotes: "If network is unavailable, write a report listing that gap and consider the task complete.",
  terminalEvidence: ["A concise report with fetched value and the write-denial evidence."]};
const started = startStewardRunFromOwnerIntent(repo, intent, {authorizeNetwork: true, maxSteps: 6, deadlineAt: new Date(Date.now()+600_000).toISOString()}, runtimeDirectory);
const manifest = new StewardModule({runtime, runs}).manifest();
const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => entry[1] !== undefined));
const adapter = new CodexRuntimeAgent({executable: "codex", projectRoot: repo, environment, timeoutMilliseconds: 300_000, maxOutputBytes: 32768});
const agents = new AgentHandler({store: runtime, adapters: new Map([[agent.principalId, adapter]]), executionGuards: manifest.executionGuards});
const results = new ResultHandler(runtime, manifest.resultContinuations);
console.log(JSON.stringify({runId: started.run.runId, endpoint: url, adapterId: adapter.adapterId, initialNetwork: started.run.workspaceGrant?.networkAccess}));
try {
  for (let i = 0; i < 18; i++) {
    const status = runs.requireProjection(started.run.runId).status;
    if (["succeeded", "failed", "needs_human", "cancelled"].includes(status)) break;
    const executions = runtime.claimDueExecutions(1, now());
    const execution = executions[0];
    if (execution === undefined) break;
    console.log(JSON.stringify({iteration: i, handler: execution.handler, executionId: execution.executionId, status}));
    if (execution.handler === "agent") await agents.handle(execution, now());
    else if (execution.handler === "result") results.handle(execution, now());
    else throw new Error(`Unexpected handler ${execution.handler}`);
  }
  const view = inspectStewardRunView(repo, started.run.runId, runtimeDirectory);
  const decisions = runs.decisions(started.run.runId);
  const outputs = view.outputFolders.flatMap(folder => folder.outputs);
  const receipt = {runId: started.run.runId, status: view.summary.status, requestsObserved: hits,
    networkAdjustmentRequested: decisions.some(record => record.decision.action === "request_capability"),
    protectedFileUnchanged: readFileSync(join(repo, "protected.txt"), "utf8") === "unchanged\n",
    fetchedValueMatches: JSON.stringify(outputs).includes(nonce), adapterId: adapter.adapterId};
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  writeFileSync(join(output, "run.json"), JSON.stringify(view, null, 2));
  console.log(JSON.stringify(receipt));
  assert.equal(receipt.status, "succeeded");
  assert.ok(receipt.networkAdjustmentRequested && receipt.requestsObserved > 0 && receipt.protectedFileUnchanged && receipt.fetchedValueMatches);
} finally {
  database.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(scratch, {recursive: true, force: true});
}
