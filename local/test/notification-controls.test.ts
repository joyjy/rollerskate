import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {notificationControlSchemaSql} from '../src/infrastructure/sqlite/schema/v79-migration.js';
import {NotificationControlStore} from '../src/capabilities/subscription/notification-control-store.js';
import type {RuntimeDelivery,RuntimeDestination} from '../src/core/runtime/model.js';

const THREAD='01a13915-bb1c-7c51-bfd8-ed88bb2ccd67';
const RUN='run_01a1425f-ce8a-73d9-b28e-6ab633a7cabd';
const SUB='sub_run_60f6b4614a4a3a0cfb9bb8456e070481';
const T='2026-10-16T10:00:00.000Z';

test('immutable Chat ancestry binds host reply to exact Run; policy does not bind unrelated work',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE agent_runs(run_id TEXT,orchestrator_binding_json TEXT);
    CREATE TABLE run_subscriptions(subscription_id TEXT,run_id TEXT);
    CREATE TABLE events(event_id TEXT,parent_event_id TEXT,source_external_id TEXT,destination_snapshots_json TEXT,payload_json TEXT);`+notificationControlSchemaSql);
  db.prepare('INSERT INTO agent_runs VALUES (?,?)').run(RUN,JSON.stringify({resultDestination:{delivery:{address:{threadId:THREAD}}}}));
  db.prepare('INSERT INTO run_subscriptions VALUES (?,?)').run(SUB,RUN);
  db.prepare('INSERT INTO events(event_id,parent_event_id,source_external_id,destination_snapshots_json) VALUES (?,?,?,?)').run('evt_activation',null,`chat-activation:run-subscription:${SUB}:terminal:run`,'[]');
  db.prepare('INSERT INTO events(event_id,parent_event_id,source_external_id,destination_snapshots_json) VALUES (?,?,?,?)').run('evt_dispatch','evt_activation','dispatch','[]');
  db.prepare('INSERT INTO events(event_id,parent_event_id,source_external_id,destination_snapshots_json) VALUES (?,?,?,?)').run('evt_reply','evt_dispatch','reply','[]');
  const controls=new NotificationControlStore(db);
  db.exec('BEGIN IMMEDIATE');controls.setInTransaction('run',RUN,'muted','Owner mute',T);db.exec('COMMIT');
  const reply={origin:{kind:'host',id:'evt_reply'}} as RuntimeDelivery;
  const destination:RuntimeDestination={destinationId:'dst_01a1425f-ce8a-73d9-b28e-6ab633a7cabd',kind:'codex-desktop',address:{threadId:THREAD},createdAt:T,updatedAt:T};
  assert.equal(controls.forDelivery(reply,destination)?.targetId,RUN);
  assert.equal(controls.forEvent('evt_dispatch')?.mode,'muted');
  assert.equal(controls.runForEvent('evt_unrelated'),undefined);
  assert.equal(controls.forEvent('evt_unrelated'),undefined);
  assert.throws(()=>controls.get('codex-thread',THREAD.toUpperCase()),/exact Codex/);
  db.exec('BEGIN IMMEDIATE');controls.setInTransaction('codex-thread',THREAD,'muted','Owner thread mute',T);
  controls.setInTransaction('run',RUN,'enabled','Owner run resume',T);db.exec('COMMIT');
  assert.equal(controls.forDelivery(reply,destination)?.scope,'codex-thread');
  assert.equal(controls.forEvent('evt_dispatch')?.scope,'codex-thread');
  assert.equal(controls.history('run',RUN).length,2);
  // Chat-origin Runs have no resultDestination. Their original source snapshot is authoritative.
  db.prepare('UPDATE agent_runs SET orchestrator_binding_json=? WHERE run_id=?').run('{}',RUN);
  db.prepare('INSERT INTO events(event_id,parent_event_id,source_external_id,destination_snapshots_json) VALUES (?,?,?,?)').run('evt_owner',null,'owner',JSON.stringify([{kind:'codex-desktop',address:{threadId:THREAD}}]));
  db.prepare('INSERT INTO events(event_id,parent_event_id,source_external_id,destination_snapshots_json,payload_json) VALUES (?,?,?,?,?)').run('evt_original_dispatch',null,'dispatch','[]',JSON.stringify({sourceMessageEventId:'evt_owner'}));
  db.prepare('UPDATE events SET parent_event_id=NULL,payload_json=? WHERE event_id=?').run(JSON.stringify({sourceEventId:'evt_original_dispatch'}),'evt_activation');
  assert.deepEqual(controls.eventThreadIds('evt_dispatch'),[THREAD]);
  assert.equal(controls.forEvent('evt_dispatch')?.scope,'codex-thread');

  db.close();
});
