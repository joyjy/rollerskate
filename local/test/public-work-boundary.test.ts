import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const LOCAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("public work handlers admit only RunIntent-backed Steward Runs", () => {
  const stewardApi = source("src/entrypoints/console/steward-api.ts");
  const chatControl = source("src/application/chat/control.ts");
  const workRequest = source("src/application/work-request/control.ts");
  const scheduleCli = source("src/entrypoints/cli/schedule.ts");
  const subscriptionCli = source("src/entrypoints/cli/subscription.ts");
  const agentCli = source("src/entrypoints/cli/agent.ts");

  assert.match(stewardApi, /startStewardRunFromIntent/);
  assert.doesNotMatch(stewardApi, /\bstartStewardRun\s*\(/);
  assert.match(chatControl, /startStewardRunFromIntent/);
  assert.doesNotMatch(chatControl, /\bstartStewardRun\s*\(/);
  assert.match(workRequest, /startStewardRunFromOwnerIntent/);
  assert.doesNotMatch(workRequest, /\bstartStewardRun\s*\(/);

  for (const publicSource of [stewardApi, chatControl, workRequest]) {
    assert.doesNotMatch(publicSource, /ProactiveCallbackRuntime/);
    assert.doesNotMatch(publicSource, /\bcreateSchedule\s*\(/);
    assert.doesNotMatch(publicSource, /\bregisterSubscription\s*\(/);
  }
  assert.match(scheduleCli, /legacy_trigger_write_closed: start RunIntent@1/);
  assert.match(subscriptionCli, /legacy_trigger_write_closed: start RunIntent@1/);
  assert.match(agentCli, /direct_agent_work_closed: start RunIntent@1/);
  assert.doesNotMatch(agentCli, /enqueueAgentRequest/);
});

function source(relativePath: string): string {
  return readFileSync(join(LOCAL_ROOT, relativePath), "utf8");
}
