import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runLocalApp } from "../src/entrypoints/cli/main.js";
import { runtimePaths } from "../src/infrastructure/runtime/config.js";
import { runtimeArtifactRevision } from "../src/infrastructure/runtime/revision.js";
import { initializeRuntimeSchema } from "../src/infrastructure/sqlite/schema.js";
import { bootstrapLocalFoundation, LocalFoundationStore } from "../src/infrastructure/sqlite/foundation-store.js";
import { openRuntimeDatabase } from "../src/infrastructure/sqlite/database.js";
import { deterministicRunId } from "../src/modules/run/intent.js";
import { parseWorkRunIntent, workDigest } from "../src/modules/run/intent.js";
import { RunAdmissionStore } from "../src/infrastructure/files/run-admission-store.js";
import { localId } from "../src/core/id.js";
import { PollProbeExecutor } from "../src/capabilities/subscription/plugin-runner.js";
import { SubscriptionStore } from "../src/capabilities/subscription/store.js";
import { SubscriptionRuntime } from "../src/capabilities/subscription/runtime.js";
import { DeterministicApplicationActionRegistry } from "../src/application/proactive/action-registry.js";
import { observeOnlyAction } from "../src/application/subscription/observation-control.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rs-run-preflight-"));
  const paths = runtimePaths(repo, root);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths);
  writeFileSync(paths.loopState, JSON.stringify({ schemaVersion: 1, pid: process.pid, status: "running", cycles: 0,
    paused: false, phase: "idle", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), runtimeRevision: runtimeArtifactRevision(repo) }), {mode:0o600});
  const pluginPath = join(root, "probe.mjs");
  const registry = { schemaVersion: "SubscriptionPluginRegistry@1", plugins: [{ ref: "plugin:test@1", pluginPath: `file://${pluginPath}`,
    pluginId: "test", workspaceRef: `file://${root}`, triggerKinds: ["until"], allowedHttpOrigins: ["https://probe.example"], allowedExecutables: [process.execPath] }] };
  writeFileSync(paths.subscriptionPlugins, JSON.stringify(registry));
  const setPlan = (body: string) => writeFileSync(pluginPath, `export default {kind:'subscription.probe',id:'test',schemaVersion:1,
    plan(input) { ${body} }, evaluate(input, result) { return {version:'done',facts:{status:result.status},terminal:'success'} } };`);
  setPlan("return {kind:'http',url:input.url}");
  const command = { schemaVersion: "RunIntent@2", requestId: "one-command", title: "test command", maxWaitMilliseconds: 60_000,
    work: { kind: "command", executable: process.execPath, args: ["-e", "require('node:fs').writeFileSync('effect','x')"], cwd: root } };
  const observe = { schemaVersion: "RunIntent@2", requestId: "one-observation", title: "test observation", maxWaitMilliseconds: 60_000,
    work: { kind: "observe", sourceRef: "plugin:test@1", input: {url:"https://probe.example/status"} } };
  const invoke = async (args: string[]) => {
    let output = "";
    const code = await runLocalApp(repo, ["--runtime", root, ...args], {}, {write(text: string) {output += text;}});
    return {code, body: JSON.parse(output)};
  };
  const submit = (operation: string, intent: unknown) => {
    const path = join(root, "intent.json"); writeFileSync(path, JSON.stringify(intent));
    return invoke(["run", operation, path]);
  };
  t.after(() => rmSync(root, {recursive:true,force:true}));
  return {root, paths, registry, pluginPath, command, observe, setPlan, submit, invoke};
}

test("public preflight is effect-free; command paths, unsupported grant and exact target errors are actionable", async t => {
  const f = fixture(t);
  const valid = await f.submit("preflight", f.command);
  assert.equal(valid.code, 0, JSON.stringify(valid.body));
  assert.equal(valid.body.plan.executor, "command");
  assert.equal(valid.body.plan.authority.execution, "caller-inherited");
  assert.ok(valid.body.unverified.some((item: {field:string}) => item.field === "work"));
  const invalid = {...f.command, resultDestinationRef:"recent", work:{...f.command.work,cwd:join(f.root,"missing"), executable:"rs-nonexistent-tool"}};
  for (const operation of ["preflight", "start"]) {
    const response = await f.submit(operation, invalid);
    assert.equal(response.code, 2);
    assert.deepEqual(new Set(response.body.diagnostics.map((issue:{code:string})=>issue.code)), new Set(["DESTINATION_INVALID","PATH_INVALID","TOOL_UNAVAILABLE"]));
    assert.ok(response.body.diagnostics.every((issue:{field:string;fix:string})=>issue.field && issue.fix));
  }
  const grant = await f.submit("preflight", {...f.command, authority:{network:true}});
  assert.equal(grant.code,2);
  assert.equal(grant.body.diagnostics[0].code,"INTENT_SCHEMA");
  assert.equal(existsSync(join(f.root,"effect")),false);
  assert.equal(existsSync(join(f.root,"commands")),false);
  assert.equal(existsSync(join(f.root,"runs")),false);
  const database = openRuntimeDatabase(f.paths.database);
  try {
    for (const table of ["events","executions","subscriptions","deliveries"]) assert.equal((database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n,0);
  } finally {database.close();}
});

test("source tool/schema and permission mismatches fail before registration or probe effects", async t => {
  const f = fixture(t);
  for (const [plan, code] of [
    ["return {kind:'shell',command:'echo invalid'}", "TOOL_PLAN_INVALID"],
    ["return {kind:'http',url:input.url,method:'POST'}", "TOOL_PLAN_INVALID"],
    ["return {kind:'http',url:'https://unauthorized.example/status'}", "PERMISSION_DENIED"],
    ["return {kind:'http',url:input.url,headers:{authorization:{environment:'PRIVATE_TOKEN'}}}", "PERMISSION_DENIED"],
    ["return {kind:'command',executable:'/bin/sh',args:['-c','touch effect']}", "PERMISSION_DENIED"]
  ]) {
    f.setPlan(plan!);
    for (const op of ["preflight","start"]) {
      const response = await f.submit(op,f.observe);
      assert.equal(response.code,2,JSON.stringify(response.body));
      assert.ok(response.body.diagnostics.some((issue:{code:string})=>issue.code === code),JSON.stringify(response.body));
    }
  }
  assert.equal(existsSync(join(f.root,"runs")),false);
  assert.equal(existsSync(join(f.root,"effect")),false);
});

test("source cwd checks resolve symlinks against the registered workspace; start rechecks edited plugin", async t => {
  const f = fixture(t);
  assert.equal((await f.submit("preflight", f.observe)).code,0);
  symlinkSync(tmpdir(),join(f.root,"outside"));
  f.setPlan(`return {kind:'command',executable:${JSON.stringify(process.execPath)},args:['--version'],cwd:'outside'}`);
  const response = await f.submit("start",f.observe);
  assert.equal(response.code,2);
  assert.equal(response.body.diagnostics[0].code,"PATH_OUTSIDE_WORKSPACE");
  assert.equal(existsSync(join(f.root,"runs")),false);
});

test("deterministic observation creates no Agent, survives readback, and presents source terminal without a delivery", async t => {
  const f = fixture(t);
  const response = await f.submit("start",f.observe);
  assert.equal(response.code,0,JSON.stringify(response.body));
  assert.equal(response.body.runId,deterministicRunId(f.observe.requestId));
  assert.equal((await f.submit("start",f.observe)).body.status,"already_admitted");
  assert.equal((await f.submit("start",{...f.observe,title:"different work"})).body.diagnostics[0].code,"REQUEST_CONFLICT");
  const database = openRuntimeDatabase(f.paths.database);
  try {
    const actions = new DeterministicApplicationActionRegistry(database,[observeOnlyAction]);
    const store = new SubscriptionStore(database,{migrate:false,applicationActions:actions});
    const source = store.require(response.body.sourceId);
    const runtime = new SubscriptionRuntime({databasePath:f.paths.database,store, probeExecutor:new PollProbeExecutor({fetch:async()=>new Response('{}',{status:200})})});
    await runtime.runCycle(new AbortController().signal,source.nextPollAt);
    const detail = (await f.invoke(["run","inspect",response.body.runId])).body;
    assert.equal(detail.result,"success");
    assert.equal(detail.deliveryStatus,"not_requested");
    assert.equal(detail.source.status,"completed");
    assert.equal((await f.invoke(["run","list"])).body[0].runId,response.body.runId);
    for (const table of ["agent_runs","executions","deliveries"]) assert.equal((database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n,0);
    assert.equal(JSON.parse(readFileSync(join(f.root,"runs",response.body.runId,"admission.json"),"utf8")).intent.work.kind,"observe");
  } finally {database.close();}
});

test("execution also rejects an unauthorized dynamic tool plan without calling fetch", async () => {
  let calls = 0;
  const executor = new PollProbeExecutor({fetch:async()=>{calls++;return new Response('{}');}});
  await assert.rejects(executor.execute({kind:"http",url:"https://wrong.example"}, {workspaceRoot:repo,allowedHttpOrigins:[],
    allowedExecutables:[],allowedEnvironment:[],timeoutMilliseconds:1000,maxOutputBytes:1024}),/origin is not allowed/);
  assert.equal(calls,0);
});

test("Agent flag input shares Run preflight without creating Agent work", async t => {
  const f = fixture(t);
  const foundation = new LocalFoundationStore(f.paths.database);
  foundation.addAgent("codex", "codex", new Date().toISOString());
  foundation.close();
  const response = await f.invoke(["run","preflight","--id","agent-work","--objective","Assess the evidence","--acceptance","A cited conclusion"]);
  assert.equal(response.code,0,JSON.stringify(response.body));
  assert.equal(response.body.plan.executor,"agent");
  const database = openRuntimeDatabase(f.paths.database);
  try { assert.equal((database.prepare("SELECT count(*) AS n FROM events").get() as {n:number}).n,0); }
  finally { database.close(); }
});

test("continuous observation remains accessible through Run and cancellation stops its source", async t => {
  const f = fixture(t);
  f.registry.plugins[0]!.triggerKinds.push("continuous");
  writeFileSync(f.paths.subscriptionPlugins,JSON.stringify(f.registry));
  const {maxWaitMilliseconds: _, ...intent} = f.observe;
  const response = await f.submit("start",{...intent,work:{...intent.work,mode:"continuous"}});
  assert.equal(response.code,0,JSON.stringify(response.body));
  assert.equal(response.body.run.source.kind,"continuous");
  assert.equal(response.body.run.status,"running");
  const cancelled = (await f.invoke(["run","cancel",response.body.runId])).body;
  assert.equal(cancelled.scope,"observation");
  assert.equal(cancelled.run.source.status,"cancelled");
});

test("an interrupted immutable admission is unknown and cannot be replayed as a fresh command", async t => {
  const f = fixture(t);
  const intent = parseWorkRunIntent(f.command);
  assert.equal(intent.schemaVersion,"RunIntent@2");
  if (intent.schemaVersion !== "RunIntent@2") throw new Error("fixture intent");
  const runId = deterministicRunId(intent.requestId);
  new RunAdmissionStore(f.root).reserve({schemaVersion:"RunAdmission@1",runId,sourceId:localId("sub"),createdAt:new Date().toISOString(),
    intent, intentDigest:workDigest(intent),planDigest:`sha256:${"0".repeat(64)}`});
  const duplicate = await f.submit("start", f.command);
  assert.equal(duplicate.body.status,"already_admitted");
  assert.equal(duplicate.body.run.status,"unknown");
  assert.equal(duplicate.body.run.result,"unknown");
  assert.ok(duplicate.body.run.errors.length);
  assert.equal(existsSync(join(f.root,"effect")),false);
  assert.equal(existsSync(join(f.root,"commands")),false);
});
