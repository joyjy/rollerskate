<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { RuntimeStatus, RuntimeIntegration, RuntimeLogEntry } from "@/types/runtime";
import type { RuntimeInfo } from "@/types/runtime";

const runtime = ref<RuntimeInfo | null>(null);
const loading = ref(true);
const apiError = ref("");
const controlling = ref(false);

const formatTime = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";

const uptime = computed(() => {
  if (runtime.value?.startedAt === null || runtime.value === null) return "—";
  const ms = new Date(runtime.value.lastRefreshedAt).getTime() - new Date(runtime.value.startedAt).getTime();
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
});

function statusClass(status: RuntimeStatus): string {
  return status === "running" ? "success" : status === "paused" ? "muted" : "warning";
}

function integrationClass(status: RuntimeIntegration["status"]): string {
  return status === "connected" ? "success" : status === "degraded" ? "warning" : "danger";
}

function logClass(level: RuntimeLogEntry["level"]): string {
  return level;
}

const loopNext = computed(() => {
  if (runtime.value?.loop.nextCycleAt == null) return "not recorded";
  const remaining = new Date(runtime.value.loop.nextCycleAt).getTime() - new Date(runtime.value.lastRefreshedAt).getTime();
  return remaining > 0 ? `in ${Math.ceil(remaining / 1000)}s` : "due";
});

const logLevelFilter = ref<"all" | RuntimeLogEntry["level"]>("all");
const logSubsystemFilter = ref<"all" | string>("all");
const logSubsystems = computed(() => [...new Set((runtime.value?.recentLogs ?? []).map((l) => l.subsystem))]);

const filteredLogs = computed(() => {
  return (runtime.value?.recentLogs ?? []).filter((log) => {
    const matchesLevel = logLevelFilter.value === "all" || log.level === logLevelFilter.value;
    const matchesSubsystem = logSubsystemFilter.value === "all" || log.subsystem === logSubsystemFilter.value;
    return matchesLevel && matchesSubsystem;
  });
});

async function load() {
  loading.value = true;
  apiError.value = "";
  try {
    const response = await fetch("/api/runtime", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    runtime.value = await response.json() as RuntimeInfo;
  } catch (reason) {
    apiError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    loading.value = false;
  }
}

async function control(action: "pause" | "resume" | "recover") {
  controlling.value = true;
  apiError.value = "";
  try {
    const response = await fetch(`/api/runtime/${action}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "X-Rollerskate-Request": "console"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    runtime.value = await response.json() as RuntimeInfo;
  } catch (reason) {
    apiError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    controlling.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-if="loading" class="runtime-state">Loading durable Runtime facts…</div>
  <div v-else-if="apiError && !runtime" class="runtime-state error">Runtime API unreachable: {{ apiError }}</div>
  <div v-else-if="runtime" class="runtime-dashboard">
    <div v-if="apiError" class="runtime-state error">{{ apiError }}</div>
    <div class="status-banner" :class="runtime.status">
      <div class="status-banner-inner">
        <div class="status-main">
          <span class="status-dot"></span>
          <span class="status-word">{{ runtime.status }}</span>
          <span class="status-since">since {{ formatTime(runtime.statusSince) }}</span>
        </div>
        <div class="status-reason">
          <strong>Reason:</strong> {{ runtime.statusReason }}
          <span v-if="runtime.stale" class="stale-tag">stale</span>
        </div>
        <div class="status-action">
          <strong>Recommended:</strong> {{ runtime.recommendedAction }}
        </div>
        <div class="status-meta">
          <span>v{{ runtime.version }}</span>
          <span>PID {{ runtime.pid }}</span>
          <span>Uptime {{ uptime }}</span>
          <span>Schema v{{ runtime.schemaVersion }}</span>
          <span class="freshness" :class="{ stale: runtime.stale }">refreshed {{ formatTime(runtime.lastRefreshedAt) }}</span>
        </div>
      </div>
    </div>

    <div class="dashboard-grid">
      <section class="panel">
        <div class="panel-header">Identity</div>
        <div class="panel-body">
          <dl class="kv compact">
            <dt>Runtime root</dt><dd class="mono secret">{{ runtime.runtimeRoot }}</dd>
            <dt>Workspace</dt><dd class="mono secret">{{ runtime.workspaceRoot }}</dd>
            <dt>Console</dt><dd class="mono">{{ runtime.consoleAddress }}</dd>
            <dt>Started</dt><dd>{{ formatTime(runtime.startedAt) }}</dd>
          </dl>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">Core loop</div>
        <div class="panel-body">
          <dl class="kv compact">
            <dt>State</dt><dd><span class="loop-state" :class="runtime.loop.state">{{ runtime.loop.state }}</span></dd>
            <dt>Total cycles</dt><dd class="mono">{{ runtime.loop.totalCycles.toLocaleString() }}</dd>
            <dt>Last cycle</dt><dd>{{ formatTime(runtime.loop.lastCycleEndAt) }}<span v-if="runtime.loop.lastCycleDurationMs !== null"> · {{ runtime.loop.lastCycleDurationMs }}ms</span></dd>
            <dt>Next cycle</dt><dd>{{ loopNext }}</dd>
            <dt>In cycle</dt><dd>{{ runtime.loop.inCycle ? runtime.loop.currentPhaseSummary ?? "ticking" : "no" }}</dd>
          </dl>
        </div>
      </section>

      <section class="panel wide">
        <div class="panel-header">Workload</div>
        <div class="panel-body">
          <div class="metric-row">
            <div class="metric-group">
              <div class="metric-title">Executions</div>
              <div class="metric-chips">
                <span class="metric-chip">queued <strong>{{ runtime.workload.queuedExecutions }}</strong></span>
                <span class="metric-chip">running <strong>{{ runtime.workload.runningExecutions }}</strong></span>
                <span class="metric-chip">retry-wait <strong>{{ runtime.workload.retryWaitExecutions }}</strong></span>
                <span class="metric-chip failed">failed <strong>{{ runtime.workload.failedExecutions }}</strong></span>
              </div>
            </div>
            <div class="metric-group">
              <div class="metric-title">Results</div>
              <div class="metric-chips">
                <span class="metric-chip success">succeeded <strong>{{ runtime.workload.agentResultSucceeded }}</strong></span>
                <span class="metric-chip failed">failed <strong>{{ runtime.workload.agentResultFailed }}</strong></span>
              </div>
            </div>
            <div class="metric-group">
              <div class="metric-title">Deliveries</div>
              <div class="metric-chips">
                <span class="metric-chip">pending <strong>{{ runtime.workload.pendingDeliveries }}</strong></span>
                <span class="metric-chip warning">retrying <strong>{{ runtime.workload.retryingDeliveries }}</strong></span>
                <span class="metric-chip failed">failed <strong>{{ runtime.workload.failedDeliveries }}</strong></span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="panel wide">
        <div class="panel-header">Local workload</div>
        <div class="panel-body workload-cards">
          <div class="workload-card">
            <div class="workload-label">Agents</div>
            <div class="workload-numbers">
              <span class="ok">{{ runtime.agents.callable }}/{{ runtime.agents.registered }}</span>
              <span v-if="runtime.agents.unavailable" class="bad">{{ runtime.agents.unavailable }} unavailable</span>
            </div>
            <div class="workload-hint">Drill-down: Agents page</div>
          </div>
          <div class="workload-card">
            <div class="workload-label">Events</div>
            <div class="workload-numbers">
              <span>{{ runtime.events.waiting + runtime.events.running }} active</span>
              <span class="ok">{{ runtime.events.succeeded }} ok</span>
              <span v-if="runtime.events.failed" class="bad">{{ runtime.events.failed }} failed</span>
            </div>
            <div class="workload-hint">last {{ formatTime(runtime.events.lastReceivedAt) }} · Events page</div>
          </div>
          <div class="workload-card">
            <div class="workload-label">Sessions</div>
            <div class="workload-numbers">
              <span>{{ runtime.sessions.total }} total</span>
              <span v-if="runtime.sessions.mismatched" class="bad">{{ runtime.sessions.mismatched }} mismatched</span>
            </div>
            <div class="workload-hint">last resumed {{ formatTime(runtime.sessions.lastResumedAt) }}</div>
          </div>
          <div class="workload-card">
            <div class="workload-label">Subscriptions</div>
            <div class="workload-numbers">
              <span class="ok">{{ runtime.subscriptions.active }} active</span>
              <span>{{ runtime.subscriptions.paused }} paused</span>
              <span v-if="runtime.subscriptions.expired" class="bad">{{ runtime.subscriptions.expired }} expired</span>
              <span v-if="runtime.subscriptions.failedUnknown" class="bad">{{ runtime.subscriptions.failedUnknown }} unknown</span>
            </div>
            <div class="workload-hint">Drill-down: Subscriptions page</div>
          </div>
          <div class="workload-card">
            <div class="workload-label">Destinations</div>
            <div class="workload-numbers">
              <span class="ok">{{ runtime.destinations.available }} available</span>
              <span>{{ runtime.destinations.pending }} pending</span>
              <span v-if="runtime.destinations.retrying" class="warning">{{ runtime.destinations.retrying }} retrying</span>
              <span v-if="runtime.destinations.failed" class="bad">{{ runtime.destinations.failed }} failed</span>
            </div>
            <div class="workload-hint">Drill-down: Event detail</div>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">Capabilities</div>
        <div class="panel-body">
          <ul class="integration-list">
            <li v-for="cap in runtime.capabilities" :key="cap.name" class="integration-item">
              <span class="status-pill-small" :class="cap.available ? 'success' : 'danger'"></span>
              <span class="mono">{{ cap.name }}</span>
              <span class="dim">{{ cap.version }}</span>
            </li>
          </ul>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">Integrations</div>
        <div class="panel-body">
          <ul class="integration-list">
            <li v-for="integration in runtime.integrations" :key="integration.name" class="integration-item">
              <span class="status-pill-small" :class="integrationClass(integration.status)"></span>
              <span>{{ integration.name }}</span>
              <span class="dim">{{ integration.status }}</span>
              <span class="dim">last {{ formatTime(integration.lastSuccessAt) }}</span>
              <span v-if="integration.failureReason" class="integration-error">{{ integration.failureReason }}</span>
            </li>
          </ul>
        </div>
      </section>

      <section class="panel wide">
        <div class="panel-header">Recent isolations</div>
        <div class="panel-body">
          <div v-if="runtime.recentIsolations.length === 0" class="empty-inline">No recent exception isolations.</div>
          <div v-for="iso in runtime.recentIsolations" v-else :key="iso.eventId + iso.occurredAt" class="isolation-row">
            <div class="isolation-head">
              <span class="mono">{{ iso.eventId }}</span>
              <span class="dim">{{ formatTime(iso.occurredAt) }}</span>
              <span class="loop-continued">loop {{ iso.loopContinued ? "continued" : "halted" }}</span>
            </div>
            <div class="isolation-detail">
              <span v-if="iso.executionId" class="mono">{{ iso.executionId }}</span>
              <span v-if="iso.subscriptionId" class="mono">{{ iso.subscriptionId }}</span>
              <span v-if="iso.destinationId" class="mono">{{ iso.destinationId }}</span>
            </div>
            <div class="error">{{ iso.boundedError }}</div>
          </div>
        </div>
      </section>

      <section class="panel wide">
        <div class="panel-header">Recent logs</div>
        <div class="panel-body">
          <div class="log-filters">
            <select v-model="logLevelFilter" class="filter-select">
              <option value="all">All levels</option>
              <option value="debug">debug</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </select>
            <select v-model="logSubsystemFilter" class="filter-select">
              <option value="all">All subsystems</option>
              <option v-for="sub in logSubsystems" :key="sub" :value="sub">{{ sub }}</option>
            </select>
          </div>
          <div class="log-list">
            <div v-if="filteredLogs.length === 0" class="empty-inline">No structured runtime logs are currently recorded.</div>
            <div v-for="log in filteredLogs" :key="log.timestamp + log.message" class="log-row">
              <span class="log-level" :class="logClass(log.level)">{{ log.level }}</span>
              <span class="log-subsystem">{{ log.subsystem }}</span>
              <span class="log-message">{{ log.message }}</span>
              <span v-if="log.objectId" class="mono log-object">{{ log.objectId }}</span>
              <span class="log-time">{{ formatTime(log.timestamp) }}</span>
            </div>
          </div>
        </div>
      </section>

      <section class="panel wide controls-panel">
        <div class="panel-header">Controls</div>
        <div class="panel-body">
          <div class="control-row">
            <button class="control-button" :disabled="controlling || runtime.status !== 'running'" @click="control('pause')">Pause</button>
            <p class="control-note">Stop claiming new loop work. In-flight provider calls continue.</p>
          </div>
          <div class="control-row">
            <button class="control-button primary" :disabled="controlling || runtime.status !== 'paused'" @click="control('resume')">Resume</button>
            <p class="control-note">Resume normal claim and show the next cycle outcome.</p>
          </div>
          <div class="control-row">
            <button class="control-button" :disabled="controlling" @click="control('recover')">Recover</button>
            <p class="control-note">Run interrupted-work reconciliation only.</p>
          </div>
        </div>
      </section>

      <section v-if="runtime.controlResult" class="panel wide">
        <div class="panel-header">Last control result · {{ runtime.controlResult.kind }}</div>
        <div class="panel-body">
          <div class="control-result" :class="runtime.controlResult.status">
            <div class="control-result-status">{{ runtime.controlResult.status }}</div>
            <div class="control-result-message">{{ runtime.controlResult.message }}</div>
            <div v-if="runtime.controlResult.kind === 'recover'" class="recover-counts">
              <span class="metric-chip success">recovered <strong>{{ runtime.controlResult.recovered ?? 0 }}</strong></span>
              <span class="metric-chip warning">left unknown <strong>{{ runtime.controlResult.leftUnknown ?? 0 }}</strong></span>
              <span class="metric-chip failed">failed <strong>{{ runtime.controlResult.failed ?? 0 }}</strong></span>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.runtime-dashboard { max-width: 1500px; margin: 0 auto; }
.runtime-state { max-width: 1500px; margin: 0 auto 18px; padding: 18px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text-secondary); }
.status-banner { border-radius: var(--radius); border: 1px solid var(--border); margin-bottom: 18px; overflow: hidden; }
.status-banner-inner { padding: 14px 18px; display: flex; flex-direction: column; gap: 8px; background: var(--surface); }
.status-banner.running { border-color: var(--success); background: var(--success-soft); }
.status-banner.paused { border-color: var(--muted); background: var(--muted-soft); }
.status-banner.degraded { border-color: var(--warning); background: var(--warning-soft); }
.status-main { display: flex; align-items: center; gap: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.status-dot { width: 10px; height: 10px; border-radius: 50%; background: currentColor; }
.status-banner.running .status-dot { background: var(--success); }
.status-banner.paused .status-dot { background: var(--muted); }
.status-banner.degraded .status-dot { background: var(--warning); }
.status-since { font-size: 12px; font-weight: 500; color: var(--text-secondary); text-transform: none; }
.status-reason, .status-action { font-size: 13px; color: var(--text-secondary); }
.status-reason strong, .status-action strong { color: var(--text); }
.stale-tag { margin-left: 8px; padding: 1px 6px; border-radius: 4px; background: var(--danger-soft); color: var(--danger); font-size: 10px; font-weight: 700; text-transform: uppercase; }
.status-meta { display: flex; gap: 16px; font-size: 13px; color: var(--text-secondary); flex-wrap: wrap; }
.status-meta span { white-space: nowrap; }
.freshness.stale { color: var(--danger); font-weight: 600; }
.dashboard-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 18px; }
.panel.wide { grid-column: 1 / -1; }
.panel-body { padding: 16px; }
.kv.compact { gap: 6px 12px; }
.loop-state { display: inline-flex; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
.loop-state.idle { background: var(--success-soft); color: var(--success); }
.loop-state.ticking { background: var(--primary-soft); color: var(--primary); }
.loop-state.paused { background: var(--muted-soft); color: var(--muted); }
.loop-state.degraded { background: var(--warning-soft); color: var(--warning); }
.metric-row { display: flex; gap: 32px; flex-wrap: wrap; }
.metric-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); margin-bottom: 8px; }
.metric-chips { display: flex; gap: 8px; flex-wrap: wrap; }
.metric-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); font-size: 12px; color: var(--text-secondary); }
.metric-chip strong { color: var(--text); font-weight: 700; }
.metric-chip.success { border-color: #bbf7d0; background: var(--success-soft); color: var(--success); }
.metric-chip.warning { border-color: #fde68a; background: var(--warning-soft); color: var(--warning); }
.metric-chip.failed { border-color: #fecaca; background: var(--danger-soft); color: var(--danger); }
.workload-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
.workload-card { padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
.workload-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); margin-bottom: 6px; }
.workload-numbers { display: flex; gap: 10px; flex-wrap: wrap; font-size: 13px; }
.workload-numbers .ok { color: var(--success); font-weight: 600; }
.workload-numbers .bad { color: var(--danger); font-weight: 600; }
.workload-numbers .warning { color: var(--warning); font-weight: 600; }
.workload-hint { margin-top: 6px; font-size: 12px; color: var(--text-dim); }
.integration-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.integration-item { display: flex; align-items: center; gap: 10px; font-size: 13px; flex-wrap: wrap; }
.status-pill-small { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.status-pill-small.success { background: var(--success); }
.status-pill-small.warning { background: var(--warning); }
.status-pill-small.danger { background: var(--danger); }
.integration-error { color: var(--danger); font-size: 12px; }
.isolation-row { padding: 12px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; }
.isolation-row:last-child { margin-bottom: 0; }
.isolation-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 13px; margin-bottom: 6px; }
.loop-continued { margin-left: auto; font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--success); }
.isolation-detail { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
.log-filters { display: flex; gap: 10px; margin-bottom: 12px; }
.filter-select { appearance: none; border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; background: var(--surface); color: var(--text); }
.filter-select:focus { outline: 2px solid var(--primary-soft); border-color: var(--primary); }
.log-list { display: flex; flex-direction: column; gap: 6px; }
.log-row { display: grid; grid-template-columns: 50px 80px 1fr auto auto; gap: 10px; align-items: center; font-size: 12px; padding: 6px 8px; border-radius: 6px; background: var(--surface-2); }
.log-level { text-transform: uppercase; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; text-align: center; }
.log-level.debug { background: var(--muted-soft); color: var(--muted); }
.log-level.info { background: var(--primary-soft); color: var(--primary); }
.log-level.warn { background: var(--warning-soft); color: var(--warning); }
.log-level.error { background: var(--danger-soft); color: var(--danger); }
.log-subsystem { color: var(--text-secondary); font-weight: 600; }
.log-message { color: var(--text); word-break: break-word; }
.log-object { color: var(--text-secondary); }
.log-time { color: var(--text-dim); white-space: nowrap; }
.controls-panel .panel-body { display: flex; gap: 18px; flex-wrap: wrap; }
.control-row { display: flex; align-items: center; gap: 14px; flex: 1 1 280px; }
.control-button { appearance: none; border: 1px solid var(--border); background: var(--surface); color: var(--text); padding: 9px 18px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; min-width: 96px; }
.control-button:hover { background: var(--bg); }
.control-button.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.control-button.primary:hover { background: #1d4ed8; }
.control-button:disabled { opacity: 0.5; cursor: not-allowed; }
.control-note { margin: 0; font-size: 12px; color: var(--text-secondary); }
.control-result { padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
.control-result.succeeded { border-color: #bbf7d0; background: var(--success-soft); }
.control-result.in-progress { border-color: #bfdbfe; background: var(--primary-soft); }
.control-result.failed { border-color: #fecaca; background: var(--danger-soft); }
.control-result-status { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
.control-result-message { font-size: 13px; color: var(--text-secondary); margin-bottom: 10px; }
.recover-counts { display: flex; gap: 8px; flex-wrap: wrap; }
.empty-inline { padding: 12px; border: 1px dashed var(--border); border-radius: 8px; color: var(--text-secondary); }
.dim { color: var(--text-secondary); font-size: 12px; }
@media (max-width: 900px) {
  .dashboard-grid { grid-template-columns: 1fr; }
  .status-banner-inner { flex-direction: column; align-items: flex-start; }
  .metric-row { gap: 18px; }
  .log-row { grid-template-columns: 50px 1fr auto; }
  .log-subsystem { display: none; }
}
</style>
