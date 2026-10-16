import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import test from "node:test";

import {inspectRun} from "../src/application/run/query.js";
import {observationPreview} from "../src/application/proactive/return-notice.js";
import {DeterministicApplicationActionRegistry, type DeterministicApplicationActionRegistration} from
  "../src/application/proactive/action-registry.js";
import {SubscriptionStore} from "../src/capabilities/subscription/store.js";
import type {TargetedSubscriptionDefinition} from "../src/capabilities/subscription/model.js";
import {localId} from "../src/core/id.js";
import {RunAdmissionStore} from "../src/infrastructure/files/run-admission-store.js";
import {runtimePaths} from "../src/infrastructure/runtime/config.js";
import {openRuntimeDatabase} from "../src/infrastructure/sqlite/database.js";
import {initializeRuntimeSchema} from "../src/infrastructure/sqlite/schema.js";
import {schemaVersion} from "../src/infrastructure/sqlite/schema/introspection.js";
import {withImmediateTransaction} from "../src/infrastructure/sqlite/transaction.js";
import {migrateV80Schema} from "../src/infrastructure/sqlite/schema/v80-migration.js";
import {deterministicRunId, workDigest, type DeterministicRunIntent} from "../src/modules/run/intent.js";
import {temporaryDirectory} from "./support/temp-directory.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const T0 = "2026-10-16T02:00:00.000Z";
const T1 = "2026-10-16T02:00:01.000Z";
const T3 = "2026-10-16T02:00:03.000Z";
const T4 = "2026-10-16T02:00:04.000Z";
const T5 = "2026-10-16T02:00:05.000Z";
const T6 = "2026-10-16T02:00:06.000Z";
const T9 = "2026-10-16T02:00:09.000Z";
const T10 = "2026-10-16T02:00:10.000Z";

test("checkpoint observation keeps one fixed deadline and survives reopen without replay", () => {
  const fixture = checkpointFixture();
  try {
    const subscriptionId = localId("sub");
    const created = createSubscription(fixture, subscriptionId, 3_000);
    assert.equal(created.deadlineAt, T10);
    assert.deepEqual(created.observationState, {
      schemaVersion:"ObservationState@1",checkpointMilliseconds:3_000,sourceDigest:created.definitionDigest,
      sourceAvailability:"unknown",businessState:"unknown",checkpointIndex:0
    });

    poll(fixture.store, subscriptionId, T1, observation("running-1", 1));
    let state = fixture.store.require(subscriptionId).observationState!;
    assert.equal(state.businessState,"running");
    assert.equal(state.lastSuccessfulQueryAt,T1);
    assert.equal(fixture.notices.length,0);

    poll(fixture.store, subscriptionId, T3, observation("running-1", 1));
    state = fixture.store.require(subscriptionId).observationState!;
    assert.equal(state.checkpointIndex,1);
    assert.equal(state.lastNoticeAt,T3);
    assert.ok(state.lastNoticeReceiptId);
    assert.equal(fixture.notices.length,1);
    assert.equal(asRecord(asRecord(fixture.notices[0]).facts).reason,"checkpoint");
    assert.equal(observationPreview(fixture.notices[0]).status,"running");
    assert.match(observationPreview(fixture.notices[0]).detail!, /source available; business running/u);

    fixture.store.close();
    fixture.store = new SubscriptionStore(fixture.database,{migrate:false,
      applicationActions:new DeterministicApplicationActionRegistry(fixture.database,[fixture.action])});
    poll(fixture.store, subscriptionId, T4, observation("running-1", 1));
    assert.equal(fixture.notices.length,1);
    assert.equal(receiptCount(fixture),1);

    fixture.store.beginAttempt(subscriptionId,T5);
    fixture.store.recordPollFailure(subscriptionId,"source unavailable",T5);
    state = fixture.store.require(subscriptionId).observationState!;
    assert.equal(state.sourceAvailability,"unavailable");
    assert.equal(state.businessState,"unknown");
    assert.equal(state.lastSuccessfulQueryAt,T4);
    assert.equal(asRecord(asRecord(fixture.notices[1]).facts).reason,"source_unavailable");

    poll(fixture.store,subscriptionId,T6,observation("running-1",1));
    state = fixture.store.require(subscriptionId).observationState!;
    assert.equal(state.sourceAvailability,"available");
    assert.equal(state.lastSuccessfulQueryAt,T6);
    assert.equal(asRecord(asRecord(fixture.notices[2]).facts).reason,"checkpoint");

    poll(fixture.store,subscriptionId,T9,{version:"terminal",facts:{status:"success"},terminal:"success"});
    const completed = fixture.store.require(subscriptionId);
    assert.equal(completed.status,"completed");
    assert.equal(completed.deadlineAt,T10);
    assert.equal(completed.observationState?.businessState,"success");
    assert.equal(asRecord(completed.terminalObservation).terminal,"success");
    assert.equal(fixture.notices.length,4);
    assert.equal(receiptCount(fixture),4);
    assert.deepEqual(fixture.store.due(T10),[]);
  } finally { fixture.close(); }
});

test("legacy targeted observation remains free of checkpoint state and notices", () => {
  const fixture = checkpointFixture();
  try {
    const subscriptionId = localId("sub");
    assert.equal(createSubscription(fixture,subscriptionId).observationState,undefined);
    poll(fixture.store,subscriptionId,T1,observation("running-1",1));
    fixture.store.beginAttempt(subscriptionId,T3);
    fixture.store.recordPollFailure(subscriptionId,"temporary failure",T3);
    const restored = fixture.store.require(subscriptionId);
    assert.equal(restored.observationState,undefined);
    assert.equal(restored.status,"active");
    assert.equal(fixture.notices.length,0);
    assert.equal(receiptCount(fixture),0);
  } finally { fixture.close(); }
});

test("v80 migration adds opt-in state without backfilling legacy subscriptions", () => {
  const path = `${temporaryDirectory("rollerskate-observation-checkpoint-v79-")}/runtime.db`;
  const database = new DatabaseSync(path);
  try {
    database.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    database.exec("INSERT INTO schema_meta (key,value) VALUES ('schema_version','79')");
    database.exec("CREATE TABLE subscriptions (subscription_id TEXT PRIMARY KEY, marker TEXT NOT NULL)");
    database.prepare("INSERT INTO subscriptions (subscription_id,marker) VALUES (?,?)").run("sub_legacy","keep");
    migrateV80Schema(database,80);
    const row = database.prepare("SELECT marker,observation_state_json FROM subscriptions WHERE subscription_id=?")
      .get("sub_legacy") as {marker:string;observation_state_json:null};
    assert.deepEqual({...row},{marker:"keep",observation_state_json:null});
    assert.equal(schemaVersion(database),80);
  } finally { database.close(); }
});

test("expired checkpoint observation is unknown rather than a business failure at the public Run boundary", () => {
  const runtimeDirectory = temporaryDirectory("rollerskate-observation-checkpoint-run-");
  const paths = runtimePaths(REPO_ROOT,runtimeDirectory);
  initializeRuntimeSchema(paths.database);
  const database = openRuntimeDatabase(paths.database);
  const notices: unknown[] = [];
  const action = captureAction(notices);
  const actions = new DeterministicApplicationActionRegistry(database,[action]);
  const store = new SubscriptionStore(database,{migrate:false,applicationActions:actions});
  const sourceId = localId("sub");
  const intent: DeterministicRunIntent = {schemaVersion:"RunIntent@2",requestId:"checkpoint-expiry",title:"Checkpoint expiry",
    maxWaitMilliseconds:10_000,checkpointMilliseconds:3_000,
    work:{kind:"observe",mode:"until",sourceRef:"plugin:test@1",input:{}}};
  const runId = deterministicRunId(intent.requestId);
  try {
    createSubscription({database,store,action,notices},sourceId,3_000);
    new RunAdmissionStore(runtimeDirectory).reserve({schemaVersion:"RunAdmission@1",runId,sourceId,createdAt:T0,intent,
      intentDigest:workDigest(intent),planDigest:`sha256:${"0".repeat(64)}`});
    assert.deepEqual(store.due(T10),[]);
    assert.equal(store.require(sourceId).status,"expired");
  } finally { store.close(); database.close(); }
  const view = inspectRun(REPO_ROOT,runId,runtimeDirectory);
  if (!("result" in view)) throw new Error("expected deterministic Run view");
  if (view.source?.kind !== "free") throw new Error("expected free observation source");
  assert.equal(view.status,"attention_required");
  assert.equal(view.result,"unknown");
  assert.equal(view.source?.status,"expired");
  const expiry = asRecord(view.source?.terminalObservation);
  assert.equal(expiry.terminal,null);
  assert.equal(asRecord(expiry.facts).businessResult,"unknown");
  assert.equal(fixtureNotice(notices).terminal,null);
  assert.equal(asRecord(fixtureNotice(notices).facts).businessResult,"unknown");
  assert.deepEqual(observationPreview(fixtureNotice(notices)),{status:"unknown / expired",detail:"deadline"});
});

interface CheckpointFixture {
  readonly database: ReturnType<typeof openRuntimeDatabase>;
  store: SubscriptionStore;
  readonly action: DeterministicApplicationActionRegistration;
  readonly notices: unknown[];
  close(): void;
}

function checkpointFixture(): CheckpointFixture {
  const directory = temporaryDirectory("rollerskate-observation-checkpoint-");
  const databasePath = `${directory}/runtime.db`;
  initializeRuntimeSchema(databasePath);
  const database = openRuntimeDatabase(databasePath);
  const notices: unknown[] = [];
  const action = captureAction(notices);
  const actions = new DeterministicApplicationActionRegistry(database,[action]);
  const store = new SubscriptionStore(database,{migrate:false,applicationActions:actions});
  return {database,store,action,notices,close(){this.store.close();database.close();}};
}

function captureAction(notices: unknown[]): DeterministicApplicationActionRegistration {
  return {ref:"action:subscription.observe@1",inputSchema:"ObserveOnlyInput@1",parseInput(){return {};},
    executeInTransaction(input){notices.push(input.observation);return {status:"succeeded",summary:"captured"};}};
}

function createSubscription(fixture: Pick<CheckpointFixture,"database"|"store"|"action"|"notices">,
  subscriptionId: string, checkpointMilliseconds?: number) {
  const actions = new DeterministicApplicationActionRegistry(fixture.database,[fixture.action]);
  const definition: TargetedSubscriptionDefinition & {readonly subscriptionId:string} = {
    schemaVersion:"SubscriptionDefinition@5",revision:"fixture-v1",subscriptionId,title:"Fixture observation",
    probe:{plugin:{path:"/workspace/probe.ts",id:"fixture",schemaVersion:1,config:{}},
      artifactRevision:"fixture-v1",artifactDigest:`sha256:${"0".repeat(64)}`,
      policy:{workspaceRoot:"/workspace",allowedHttpOrigins:[],allowedExecutables:[],allowedEnvironment:[],timeoutMilliseconds:1_000,maxOutputBytes:4_096}},
    intervalMilliseconds:1_000,maxWaitMilliseconds:10_000,maxAttempts:20,target:actions.compileTarget("action:subscription.observe@1",{}),
    ...(checkpointMilliseconds === undefined ? {} : {checkpointMilliseconds})
  };
  return withImmediateTransaction(fixture.database,()=>fixture.store.createTargetedInTransaction(definition,T0));
}

function poll(store: SubscriptionStore, subscriptionId: string, at: string,
  observationValue: {readonly version:string;readonly facts:Readonly<Record<string,unknown>>;readonly terminal:"success"|"failure"|"cancelled"|null}) {
  store.beginAttempt(subscriptionId,at);
  return store.recordObservation(subscriptionId,observationValue,at);
}

function observation(version: string, progress: number) {
  return {version,facts:{status:"running",progress},terminal:null} as const;
}

function receiptCount(fixture: Pick<CheckpointFixture,"database">): number {
  return (fixture.database.prepare("SELECT count(*) AS n FROM deterministic_action_receipts").get() as {n:number}).n;
}

function asRecord(value: unknown): Readonly<Record<string,unknown>> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Readonly<Record<string,unknown>>;
}

function fixtureNotice(notices: readonly unknown[]): Readonly<Record<string,unknown>> {
  assert.equal(notices.length,1);
  return asRecord(notices[0]);
}
