import assert from "node:assert/strict";
import test from "node:test";
import { evaluateJev } from "../src/integrations/jev/client.js";
import { jevMcpServers } from "../src/application/judgment/jev.js";
import type { AgentInputEvent, AgentRequestEvent } from "../src/core/event/model.js";
const request = { state: "Synthetic duplicate notification", questions: { duplicate: { type: "noul", instructions: "Is this a duplicate?" } } };
const result = { model: "jev-test", answers: { duplicate: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 1 } };
test("Jev preserves typed raw evidence and uses only the fixed authenticated endpoint", async () => {
  const actual = await evaluateJev(request, { key: () => "private-key", fetch: async (url, options) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(options?.redirect, "error");
    assert.equal((options?.headers as Record<string, string>).Authorization, "Bearer private-key");
    assert.equal(JSON.parse(String(options?.body)).model, "jev-latest");
    return Response.json(result);
  } });
  assert.deepEqual(actual, result);
});
test("Jev errors do not expose upstream content and do not become negative answers", async () => {
  for (const status of [401, 422]) await assert.rejects(evaluateJev(request, { key: () => "secret", fetch: async () => new Response("secret source text", {status}) }), new RegExp(`http_${status}`));
  await assert.rejects(evaluateJev(request, { key: () => "secret", fetch: async () => Response.json({ model: "jev-test", answers: {} }) }), /invalid_response/);
  await assert.rejects(evaluateJev(request, { key: () => "secret", fetch: async () => new Response("x".repeat(131_073)) }), /response_too_large/);
});
test("Jev backs off bounded overloads within one deadline", async () => {
  let attempts = 0;
  await evaluateJev(request, { key: () => "secret", fetch: async () => ++attempts < 2 ? new Response("overload", {status: 529}) : Response.json(result) });
  assert.equal(attempts, 2);
  await assert.rejects(evaluateJev(request, { key: () => "secret", timeoutMilliseconds: 10, fetch: async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new Error("private trace")), {once:true});
  }) }), /cancelled_or_timeout/);
});
test("Jev tool is confined to network-authorized Run requests", () => {
  const event = { type: "agent.request", runContext: { workspaceGrant: {networkAccess:false} } } as AgentRequestEvent;
  assert.deepEqual(jevMcpServers(event, "/private/jev.env"), []);
  const allowed = {...event, runContext: {...event.runContext, workspaceGrant: {...event.runContext?.workspaceGrant, networkAccess:true}}} as AgentInputEvent;
  assert.deepEqual(jevMcpServers(allowed, "/private/jev.env")[0]?.tools, ["evaluate_jev"]);
  assert.deepEqual(jevMcpServers({...event, type:"subscription.fire"} as AgentInputEvent, "/private/jev.env"), []);
});

for (const mode of ["cancel", "disconnect"]) test(`MCP ${mode} reaches an active tool call`, {timeout: 5000}, async (t) => {
  const { spawn } = await import("node:child_process");
  const server = new URL("../src/entrypoints/mcp/stdio-server.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { runStdioMcpToolServer } from ${JSON.stringify(server)};
    await runStdioMcpToolServer({name:'test',version:'1',tools:[],call:(_name,_args,signal)=> {
      process.stderr.write('started\\n');
      return new Promise((_resolve,reject)=> {
        signal.addEventListener('abort',()=>reject(new Error('cancelled')), {once:true});
      });
    }});
  `], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "";
  let errors = "";
  child.stderr.on("data", data => { errors += String(data); });
  child.stdout.on("data", data => { output += String(data); });
  const exit = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"evaluate_jev",arguments:request}}) + "\n");
  await new Promise<void>(resolve => child.stderr.once("data", () => resolve()));
  child.stdin.end(mode === "cancel" ? JSON.stringify({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:1}}) + "\n" : "");
  assert.equal(await exit, 0, errors);
  const reply = JSON.parse(output);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /cancelled/);
});
