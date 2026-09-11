import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = process.argv[2];
const load = file => import(pathToFileURL(join(root, 'local/dist/src', file)).href);
const loop = await load('core/loop.js');
const { RuntimeStore } = await load('core/runtime/store.js');
const { RuntimeCycle } = await load('core/runtime/cycle.js');
const { AgentHandler, ResultHandler, DeliveryHandler } = await load('core/runtime/handlers.js');
const hasAdmission = typeof RuntimeStore.prototype.executionSchedulingSnapshot === 'function';
const hasWake = typeof loop.LoopWakeSignal === 'function';
const work = hasWake ? await load('core/runtime/wake.js') : null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quantiles = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const q = p => sorted.length ? Math.round(sorted[Math.ceil(p * sorted.length) - 1] * 100) / 100 : null;
  return { samples: sorted.length, p50: q(.5), p95: q(.95), p99: q(.99) };
};

async function scenario(name) {
  const directory = mkdtempSync(join(tmpdir(), 'rs-scheduler-workload-'));
  const database = join(directory, 'runtime.db');
  const store = new RuntimeStore(database);
  const abort = new AbortController();
  const wake = hasWake ? new loop.LoopWakeSignal() : undefined;
  const unsubscribe = work?.subscribeRuntimeWork(database, () => wake.wake());
  const ready = new Map(), starts = new Map(), claimed = new Map(), resultReady = new Map();
  const resultLatencies = [], failures = [], laneActive = new Map();
  let peakInvoking = 0, invoking = 0, peakClaimed = 0, scans = 0, dueQueries = 0;
  let peakNotInvoking = 0, sourceCalls = 0, settledResults = 0;
  let probeId, seedResultId, releaseTimer, saturationSnapshot;
  const saturated = name === 'hot-lane' || name === 'mixed';
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const originalClaim = store.claimDueExecutions.bind(store);
  store.claimDueExecutions = (...args) => {
    scans++;
    const rows = originalClaim(...args);
    for (const row of rows) claimed.set(row.executionId, row);
    peakClaimed = Math.max(peakClaimed, claimed.size);
    peakNotInvoking = Math.max(peakNotInvoking, [...claimed.values()]
      .filter(row => row.handler === 'agent' && !starts.has(row.eventId)).length);
    if (saturated && [...claimed.values()].filter(row => row.handler === 'agent').length >= (hasAdmission ? (name === 'hot-lane' ? 2 : 4) : 100) && releaseTimer === undefined) releaseTimer = setTimeout(() => {
      saturationSnapshot = { claimed: claimed.size, invoking, waiting: claimed.size - invoking };
      release();
    }, 400);
    return rows;
  };
  for (const key of ['nextDueExecutionAt', 'nextDueDeliveryAt']) {
    if (typeof store[key] === 'function') {
      const original = store[key].bind(store);
      store[key] = (...args) => { dueQueries++; return original(...args); };
    }
  }
  const complete = store.completeExecution.bind(store);
  store.completeExecution = (...args) => {
    const receipt = complete(...args);
    resultReady.set(receipt.eventId, performance.now());
    return receipt;
  };
  const adapterForAgent = agentId => ({ adapterId: 'benchmark', workspace: directory,
    async invoke({ event }) {
      starts.set(event.eventId, performance.now());
      const active = (laneActive.get(agentId) ?? 0) + 1;
      laneActive.set(agentId, active);
      assert.ok(active <= (hasAdmission ? 2 : 1), 'per-Agent invocation limit');
      invoking++;
      peakInvoking = Math.max(peakInvoking, invoking);
      try {
        if (saturated && event.prompt === 'held') await gate;
        await delay(2);
        return { providerSessionId: `bench-${event.eventId}`, outcome: { kind: 'message', body: 'ok' } };
      } finally { invoking--; laneActive.set(agentId, laneActive.get(agentId) - 1); }
    }
  });
  const agent = new AgentHandler({ store, adapterForAgent });
  const result = new ResultHandler(store);
  const handlers = new Map([
    ['agent', { kind: 'agent', ...(hasAdmission ? { resources: event => agent.resources(event) } : {}), async handle(execution) {
      try {
        const outcome = await agent.handle(execution);
        assert.equal(outcome?.outcome, "succeeded", outcome?.error);
      } finally { claimed.delete(execution.executionId); }
    } }],
    ['result', { kind: 'result', async handle(execution) {
      const at = performance.now();
      const enqueued = resultReady.get(execution.eventId);
      assert.notEqual(enqueued, undefined, JSON.stringify(store.event(execution.eventId)));
      resultLatencies.push(at - enqueued);
      if (execution.eventId === seedResultId) starts.set(seedResultId, at);
      try { await result.handle(execution); settledResults++; }
      finally { claimed.delete(execution.executionId); }
    } }]
  ]);
  const cycle = new RuntimeCycle({ store, handlers,
    deliveryHandler: new DeliveryHandler({ store, adapters: new Map() }), onWorkStateChanged: () => wake?.wake() });
  const enqueue = (agentId, prompt = 'short', createdAt) => {
    const receipt = store.appendEvent({ type: 'agent.request', source: { kind: 'cli' }, agentId, prompt,
      maxAttempts: 1, ...(createdAt ? { createdAt } : {}) });
    ready.set(receipt.event.eventId, Math.max(performance.now(), performance.now() + Date.parse(receipt.event.createdAt) - Date.now()));
    return receipt.event.eventId;
  };
  let expected = 0, timer;
  // Prepare a real canonical Result behind the 100 earlier-due held Agents.
  // Fixture priming is outside the timed loop and is not counted as scheduler work.
  if (saturated) {
    const seed = store.appendEvent({ type: 'agent.request', source: { kind: 'cli' }, agentId: 'seed', prompt: 'seed' });
    const seedExecution = originalClaim(1)[0];
    assert.equal(seedExecution.eventId, seed.event.eventId);
    const earlier = new Date(Date.now() - 1000).toISOString();
    for (let i = 0; i < 100; i++) enqueue(name === 'hot-lane' ? 'hot' : `long-${i}`, 'held', earlier);
    const receipt = store.completeExecution(seedExecution.executionId, {
      adapterId: 'benchmark', workspace: directory, providerSessionId: 'seed', output: 'seed result'
    });
    seedResultId = receipt.eventId;
    probeId = enqueue('independent');
    expected = 102; // 101 timed Agent completions plus the primed Result.
  }
  const timeout = setTimeout(() => { release(); abort.abort(); }, 20000);
  const begin = performance.now(), cpu = process.cpuUsage();
  let first = true, finished = false;
  const phases = [{ scope: 'controlled-source', async run() {
    if (name === 'slow-source' && first) { first = false; sourceCalls++; await delay(400); }
  } }, { scope: 'runtime', async run() {
    failures.push(...cycle.poll().failures);
    if (failures.length) abort.abort();
    if (name !== 'idle' && expected > 0 && settledResults === expected) { finished = true; abort.abort(); }
  } }];
  if (name === 'idle') timer = setTimeout(() => { finished = true; abort.abort(); }, 1200);
  else if (!saturated) timer = setTimeout(() => {
    expected = name === 'burst' ? 60 : 1;
    for (let i = 0; i < expected; i++) enqueue(`short-${i}`, 'short',
      name === 'due' ? new Date(Date.now() + 100).toISOString() : undefined);
  }, 30);
  try {
    const loopResult = await loop.runLoop({ statePath: join(directory, 'loop.json'), runtimeDirectory: directory,
      runtimeRevision: 'benchmark', agentNames: [], routeIds: [], paused: () => false, phases,
      ...(hasWake ? { wakeSignal: wake, nextWaitMilliseconds: max => cycle.nextWaitMilliseconds(max) } : {})
    }, abort.signal);
    const elapsedMs = performance.now() - begin;
    const usage = process.cpuUsage(cpu);
    release();
    failures.push(...(await cycle.settle()).failures);
    assert.deepEqual(failures, []);
    assert.ok(finished, `${name} timed out: ${JSON.stringify({ settledResults, expected, started: starts.size, claimed: claimed.size, saturationSnapshot, pending: store.events(1000).map(event => store.executionForEvent(event.eventId)).filter(row => row && !["succeeded", "failed"].includes(row.status)).map(row => ({ handler: row.handler, status: row.status, error: row.lastError })) })}`);
    if (saturated) {
      assert.equal(saturationSnapshot.claimed, hasAdmission ? (name === "hot-lane" ? 2 : 4) : 100);
      assert.equal(saturationSnapshot.invoking, name === "hot-lane" ? (hasAdmission ? 2 : 1) : (hasAdmission ? 4 : 100));
    }
    assert.ok(peakClaimed <= (hasAdmission ? 7 : 100), 'global capacity exceeded');
    assert.equal(starts.size, ready.size + (seedResultId ? 1 : 0), 'all admitted work started');
    for (const eventId of ready.keys()) {
      assert.equal(store.executionForEvent(eventId).status, 'succeeded');
      assert.ok(starts.get(eventId) + 2 >= ready.get(eventId), 'work started before due time');
    }
    return { name, elapsedMs: Math.round(elapsedMs), cycles: loopResult.cycles, claimScans: scans, dueQueries,
      cpuMs: (usage.user + usage.system) / 1000, readyToStartMs: quantiles([...ready].map(([id, at]) => starts.get(id) - at)),
      resultReadyToStartMs: quantiles(resultLatencies), agents: ready.size,
      terminalResults: settledResults, agentThroughputPerSecond: ready.size / (elapsedMs / 1000),
      peakClaimed, peakInvoking, peakClaimedNotInvoking: peakNotInvoking, sourceCalls,
      ...(probeId ? { independentProbeWaitMs: starts.get(probeId) - ready.get(probeId),
        resultProbeWaitMs: starts.get(seedResultId) - resultReady.get(seedResultId), saturationSnapshot, heldUntilCapacityThenMs: 400 } : {}) };
  } finally {
    clearTimeout(timeout); clearTimeout(timer); clearTimeout(releaseTimer);
    release(); abort.abort(); unsubscribe?.(); await cycle.settle(); store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
const scenarios = [];
for (const name of ['idle', 'enqueue', 'due', 'burst', 'slow-source', 'hot-lane', 'mixed']) {
  console.error(`${root.split('/').at(-1)}: ${name}`);
  scenarios.push(await scenario(name));
}
process.stdout.write(JSON.stringify({ hasWake, hasAdmission, scenarios }));
