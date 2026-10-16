import { callChatReadTool, createChatReadToolContext } from "../src/application/chat/read-tool-policy.js";
import { addLocalAgent } from "../src/application/agent/control.js";
import { postLocalChatMessage } from "../src/application/chat/control.js";
import { RuntimeStore } from "../src/core/runtime/store.js";
import { chatPromptResourceId } from "../src/core/chat/model.js";
import { chatCallbackAction } from "../src/application/chat/callback.js";
import { admitChatWorkReturns } from "../src/application/chat/work-return.js";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { compileGitLabPipelineRunIntent } from "../src/application/run/gitlab-pipeline-source.js";
import { preflightRun } from "../src/application/run/admission.js";
import { startRun } from "../src/application/run/control.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

interface PluginRegistryEntry {
  readonly ref: string;
  readonly pluginPath: string;
  readonly pluginId: string;
  readonly workspaceRef: string;
  readonly triggerKinds: string[];
  readonly allowedHttpOrigins: string[];
  readonly allowedExecutables: string[];
  readonly gitlabPipeline?: {
    readonly inputSchema: string;
    readonly transport: { readonly kind: string; readonly executable: string; readonly cwd?: string };
  };
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rs-run-preflight-"));
  const paths = runtimePaths(repo, root);
  initializeRuntimeSchema(paths.database);
  bootstrapLocalFoundation(paths);
  writeFileSync(paths.loopState, JSON.stringify({ schemaVersion: 1, pid: process.pid, status: "running", cycles: 0,
    paused: false, phase: "idle", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), runtimeRevision: runtimeArtifactRevision(repo) }), {mode:0o600});
  const pluginPath = join(root, "probe.mjs");
  const registry: { schemaVersion: string; plugins: PluginRegistryEntry[] } = { schemaVersion: "SubscriptionPluginRegistry@1", plugins: [{ ref: "plugin:test@1", pluginPath: `file://${pluginPath}`,
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

test("deterministic checkpoint is optional, bounded by the fixed total budget, and excluded from Agent work", () => {
  const legacy = {schemaVersion:"RunIntent@2",requestId:"legacy-command",title:"legacy command",maxWaitMilliseconds:60_000,
    work:{kind:"command",executable:"node",args:["--version"],cwd:"/tmp/example"}};
  assert.deepEqual(parseWorkRunIntent(legacy), legacy);
  assert.equal(workDigest(parseWorkRunIntent(legacy)), "sha256:7ba55a13b545da7731698bcd806c17dc42fcdd5fb261502802fd0321d423588d");
  const checkpointed = parseWorkRunIntent({...legacy, checkpointMilliseconds:5_000});
  assert.equal(checkpointed.schemaVersion, "RunIntent@2");
  if (checkpointed.schemaVersion !== "RunIntent@2") throw new Error("expected deterministic intent");
  assert.equal(checkpointed.checkpointMilliseconds, 5_000);
  assert.equal(checkpointed.maxWaitMilliseconds, 60_000);
  assert.throws(() => parseWorkRunIntent({...legacy, checkpointMilliseconds:60_001}), /checkpointMilliseconds must be an integer between 1000 and 60000/u);
  const {maxWaitMilliseconds: _, ...continuousLegacy} = legacy;
  assert.throws(() => parseWorkRunIntent({...continuousLegacy, checkpointMilliseconds:5_000,
    work:{kind:"observe",mode:"continuous",sourceRef:"plugin:test@1",input:{}}}), /no checkpoint deadline/u);
  assert.throws(() => parseWorkRunIntent({schemaVersion:"RunIntent@1",requestId:"agent",objective:"work",acceptance:["done"],
    terminalEvidence:["done"],contextRefs:[],checkpointMilliseconds:5_000}), /unknown field: checkpointMilliseconds/u);
});

test("checkpoint CLI requires an explicit total budget and preserves that budget", async t => {
  const f = fixture(t);
  const base = ["run","preflight","--id","checkpoint-command","--title","checkpoint command","--cwd",f.root];
  const legacy = await f.invoke([...base,"--timeout","60","--",process.execPath,"--version"]);
  assert.equal(legacy.code,0,JSON.stringify(legacy.body));
  const expectedLegacy = {schemaVersion:"RunIntent@2",requestId:"checkpoint-command",title:"checkpoint command",maxWaitMilliseconds:60_000,
    work:{kind:"command",executable:process.execPath,args:["--version"],cwd:f.root}};
  assert.deepEqual(legacy.body.plan.intent,expectedLegacy);
  assert.equal(workDigest(legacy.body.plan.intent),workDigest(expectedLegacy));
  const missingBudget = await f.invoke([...base,"--checkpoint","5","--",process.execPath,"--version"]);
  assert.equal(missingBudget.code,2);
  assert.match(missingBudget.body.diagnostics[0].actual,/requires an explicit --timeout/u);
  const accepted = await f.invoke([...base,"--timeout","60","--checkpoint","5","--",process.execPath,"--version"]);
  assert.equal(accepted.code,0,JSON.stringify(accepted.body));
  assert.equal(accepted.body.plan.intent.maxWaitMilliseconds,60_000);
  assert.equal(accepted.body.plan.intent.checkpointMilliseconds,5_000);
  const overBudget = await f.invoke([...base,"--timeout","5","--checkpoint","6","--",process.execPath,"--version"]);
  assert.equal(overBudget.code,2);
  assert.match(overBudget.body.diagnostics[0].actual,/checkpointMilliseconds must be an integer between 1000 and 5000/u);
  const agent = await f.invoke(["run","preflight","--id","agent-checkpoint","--objective","work","--acceptance","done",
    "--timeout","60","--checkpoint","5"]);
  assert.equal(agent.code,2);
  assert.match(agent.body.diagnostics[0].actual,/Agent and deterministic work options cannot be mixed/u);
});

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

test("typed pipeline CLI compiles the Owner-declared build source into the ordinary Run boundary", async t => {
  const f = fixture(t);
  const threadId = "01a08e63-109a-7452-9d23-f9fa9f236343";
  const executable = realpathSync(process.execPath);
  f.registry.plugins[0] = {
    ref: "plugin:build-pipeline@1",
    pluginPath: `file://${f.pluginPath}`,
    pluginId: "build-pipeline",
    workspaceRef: `file://${f.root}`,
    triggerKinds: ["until"],
    allowedHttpOrigins: [],
    allowedExecutables: [executable],
    gitlabPipeline: {
      inputSchema: "GitLabPipelineInput@1",
      transport: { kind: "command", executable, cwd: f.root }
    }
  };
  writeFileSync(f.paths.subscriptionPlugins, JSON.stringify(f.registry));
  writeFileSync(f.pluginPath, `export default {kind:'subscription.probe',id:'build-pipeline',schemaVersion:1,
    plan(input) { if (input.schemaVersion !== 'GitLabPipelineInput@1' || input.expectedSha !== '${"a".repeat(40)}') throw new Error('typed input missing'); return {kind:'command',executable:input.transport.executable,args:['--version'],cwd:input.transport.cwd}; },
    evaluate(input, result) { return {version:String(input.transport.pipelineId),facts:{pipelineId:input.transport.pipelineId,sha:input.expectedSha},terminal:'success'}; } };`);
  const args = ["run", "pipeline", "preflight", "--id", "pipeline-request", "--project", "group/project", "--pipeline", "42",
    "--expected-sha", "a".repeat(40), "--timeout", "60"];
  const missingReturnTarget = await f.invoke(args);
  assert.equal(missingReturnTarget.code, 2);
  assert.match(missingReturnTarget.body.diagnostics[0].actual, /--return-to is required/u);
  const pipelineSubmission = {
    requestId: "pipeline-request", project: "group/project", pipelineId: 42, expectedSha: "a".repeat(40),
    resultDestinationRef: `codex-desktop:${threadId}`, timeoutSeconds: 60
  };
  const legacyGenerated = compileGitLabPipelineRunIntent(repo, pipelineSubmission, f.root);
  assert.equal("checkpointMilliseconds" in legacyGenerated, false);
  const generated = compileGitLabPipelineRunIntent(repo, {...pipelineSubmission, checkpointSeconds:5}, f.root);
  assert.equal(generated.maxWaitMilliseconds, 60_000);
  assert.equal(generated.checkpointMilliseconds, 5_000);
  const {resultDestinationRef: _, ...localIntent} = generated;
  const preflight = await preflightRun(repo, localIntent, f.root);
  assert.equal(preflight.status, "passed", JSON.stringify(preflight));
  if (preflight.plan?.executor !== "observe") throw new Error("expected observation plan");
  const work = preflight.plan.intent.work;
  if (work.kind !== "observe") throw new Error("expected observe work");
  assert.equal(work.sourceRef, "plugin:build-pipeline@1");
  assert.deepEqual(work.input, {
    schemaVersion: "GitLabPipelineInput@1",
    transport: {kind:"command",executable,project:"group/project",pipelineId:42,cwd:f.root},
    expectedSha: "a".repeat(40)
  });
  const database = openRuntimeDatabase(f.paths.database);
  try { assert.equal((database.prepare("SELECT count(*) AS n FROM subscriptions").get() as {n:number}).n, 0); }
  finally {database.close();}
  const started = await startRun(repo, localIntent, f.root);
  assert.equal(started.status, "admitted");
  if (!("sourceId" in started)) throw new Error("expected deterministic Run admission");
  assert.equal(started.runId, deterministicRunId("pipeline-request"));
});

test("typed pipeline CLI rejects a missing compatible source rather than starting a command watcher", async t => {
  const f = fixture(t);
  const result = await f.invoke(["run", "pipeline", "preflight", "--id", "missing-source", "--project", "group/project", "--pipeline", "42",
    "--expected-sha", "a".repeat(40), "--return-to", "codex-desktop:01a08e63-109a-7452-9d23-f9fa9f236343", "--timeout", "60"]);
  assert.equal(result.code, 2);
  assert.match(result.body.diagnostics[0].actual, /not registered.*no command fallback/u);
  assert.equal(existsSync(join(f.root, "runs")), false);
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

test("Agent flags bind explicit Steward and Worker before creating any work", async t => {
  const f = fixture(t);
  const foundation = new LocalFoundationStore(f.paths.database);
  const codex = foundation.addAgent("codex", "codex");
  const kimi = foundation.addAgent("kimi", "kimi-code");
  const pi = foundation.addAgent("pi-deepseek", "pi");
  foundation.close();
  const flags = ["run", "preflight", "--id", "agent-work", "--objective", "Assess the evidence", "--acceptance", "A cited conclusion"];
  const implicit = await f.invoke(flags);
  assert.equal(implicit.code, 0, JSON.stringify(implicit.body));
  assert.ok(implicit.body.plan.admission.authority.participantAgentIds.includes(codex.principalId));
  for (const [steward, worker] of [[kimi, pi], [pi, kimi]] as const) {
    const response = await f.invoke([...flags, "--steward", steward.handle, "--worker", `principal:${worker.principalId}`]);
    assert.equal(response.code, 0, JSON.stringify(response.body));
    const admission = response.body.plan.admission;
    assert.equal(admission.stewardSelection.agentId, steward.principalId);
    assert.equal(admission.authority.workerAgentId, worker.principalId);
    assert.deepEqual(admission.authority.participantAgentIds, [kimi.principalId, pi.principalId].sort());
  }
  assert.equal((await f.invoke([...flags, "--steward", "missing", "--worker", "kimi"])).code, 2);
  assert.equal((await f.invoke(["run", "preflight", "--id", "command", "--title", "command", "--worker", "kimi", "--cwd", f.root, "--", process.execPath, "--version"])).code, 2);
  const database = openRuntimeDatabase(f.paths.database);
  try { assert.equal((database.prepare("SELECT count(*) AS n FROM events").get() as {n:number}).n, 0); }
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

test("observed result returns to exact Chat origin through public Run admission and inspection", async t => {
  const f = fixture(t);
  const agent = addLocalAgent(repo,"alice","codex",{runtimeDirectory:f.root});
  const message = postLocalChatMessage(repo,"@alice wait for the bounded observation",{runtimeDirectory:f.root}).message;
  const database = openRuntimeDatabase(f.paths.database);
  const runtime = new RuntimeStore(database);
  try {
    const at = new Date().toISOString();
    const attention = runtime.claimDueExecutions(100,at).find(item=>item.eventId===message.eventId)!;
    const [dispatch] = runtime.admitChatAttention(attention.executionId,[{plan:{agentId:agent.principalId,handle:agent.handle,
      outcome:"dispatch",reason:"direct-mention",presenceSnapshot:{global:{scope:"global",mode:"available",wakeKeywords:[]},topic:{scope:"topic",mode:"available",wakeKeywords:[]}}},prompt:"fixture",promptResourceId:chatPromptResourceId}],at);
    const execution = runtime.claimDueExecutions(100,at).find(item=>item.eventId===dispatch!.eventId)!;
    const response = await f.submit("start",{...f.observe,resultDestinationRef:`rs-chat:${dispatch!.eventId}`});
    assert.equal(response.code,0,JSON.stringify(response.body));
    const actions = new DeterministicApplicationActionRegistry(database,[chatCallbackAction]);
    const store = new SubscriptionStore(database,{migrate:false,applicationActions:actions});
    const source = store.require(response.body.sourceId);
    const observer = new SubscriptionRuntime({databasePath:f.paths.database,store,probeExecutor:new PollProbeExecutor({fetch:async()=>new Response('{}')})});
    await observer.runCycle(new AbortController().signal,source.nextPollAt);
    const detail = (await f.invoke(["run","inspect",response.body.runId])).body;
    const chatContext = createChatReadToolContext({repoRoot:repo,runtimeDirectory:f.root,dispatchEventId:dispatch!.eventId});
    const chatEvidence = callChatReadTool(chatContext,"get_run",{runId:response.body.runId}) as {work:{kind:string;result:string};source:{sourceId:string;status:string}};
    assert.equal(chatEvidence.work.kind,"observe");
    assert.equal(chatEvidence.work.result,"success");
    assert.equal(chatEvidence.source.sourceId,response.body.sourceId);
    assert.equal(detail.result,"success");
    assert.equal(detail.deliveryStatus,"waiting_origin");
    assert.equal(detail.chatCallbacks[0].receipt.output.dispatchEventId,dispatch!.eventId);
    runtime.completeExecution(execution.executionId,{adapterId:"fixture",workspace:repo,providerSessionId:"alice",
      chatDecision:{schema:"ChatDecision@2",speech:{action:"silent",reason:"wait"},presence:{scope:"topic",mode:"available",wakeKeywords:[]}}},new Date().toISOString());
    assert.equal(admitChatWorkReturns({repoRoot:repo,runtimeDirectory:f.root,database,runtime}).eventIds.length,1);
    assert.equal((await f.invoke(["run","inspect",response.body.runId])).body.deliveryStatus,"admitted");
    const invalid = await f.submit("preflight",{...f.observe,resultDestinationRef:"rs-chat:evt_missing"});
    assert.equal(invalid.code,2);
    assert.ok(invalid.body.diagnostics.some((d:{code:string})=>d.code === "DESTINATION_INVALID"));
  } finally {runtime.close();database.close();}
});
