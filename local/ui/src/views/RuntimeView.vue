<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { requestJson } from "@/api/client";
import {
  cancelAgentRunReceiptSchema,
  latestAgentRunViewSchema,
  runtimeInfoSchema
} from "@/api/schema";
import { useApi } from "@/composables/useApi";
import { useMutation } from "@/composables/useMutation";
import AgentRunOverview from "@/components/AgentRunOverview.vue";
import { formatDateTime } from "@/utils/format";
import type { RuntimeStatus, RuntimeFailure } from "@/types/runtime";

const router = useRouter();
const route = useRoute();
const selectedFailureRef = computed(() => {
  const value = route.query.failureRef;
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
});
const mutationPaused = ref(false);
const {
  data: runtime,
  loading,
  error: loadError,
  stale,
  refresh
} = useApi({
  url: "/api/runtime",
  schema: runtimeInfoSchema,
  interval: 5_000,
  paused: mutationPaused
});
const {
  data: latestAgentRun,
  error: agentRunError,
  refresh: refreshAgentRun
} = useApi({
  url: "/api/runs/latest",
  schema: latestAgentRunViewSchema,
  interval: 5_000,
  paused: mutationPaused
});

const controlMutation = useMutation({
  async execute(action: "pause" | "resume" | "recover", signal) {
    return requestJson(`/api/runtime/${action}`, runtimeInfoSchema, {
      method: "POST",
      headers: { "X-Rollerskate-Request": "console" },
      signal
    });
  },
  refresh
});

const controlling = controlMutation.pending;
const apiError = computed(() => controlMutation.error.value ?? loadError.value);
const cancelRunMutation = useMutation({
  async execute(runId: string, signal) {
    return requestJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, cancelAgentRunReceiptSchema, {
      method: "POST",
      headers: { "X-Rollerskate-Request": "console" },
      signal
    });
  },
  async refresh() {
    await Promise.all([refresh(), refreshAgentRun()]);
  }
});
const cancellingRun = cancelRunMutation.pending;
const cancelRunError = cancelRunMutation.error;

const uptime = computed(() => {
  if (runtime.value?.startedAt === null || runtime.value === null) return "—";
  const ms = new Date(runtime.value.lastRefreshedAt).getTime() - new Date(runtime.value.startedAt).getTime();
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
});

function statusClass(status: RuntimeStatus): string {
  if (status === "running") return "success";
  if (status === "paused") return "muted";
  if (status === "stopped") return "danger";
  return "warning";
}

function phaseClass(phase: string): string {
  return phase === "idle" ? "success" : phase === "in_cycle" ? "primary" : "muted";
}

function hasActionableConsoleTarget(failure: RuntimeFailure): boolean {
  return failure.action.available && (
    failure.action.consoleRoute !== undefined ||
    failure.eventId !== undefined
  );
}

function inspectFailure(failure: RuntimeFailure) {
  const route = failure.action.consoleRoute;
  if (route) {
    void router.push(route);
  } else if (failure.eventId) {
    void router.push({ name: "events", query: { eventId: failure.eventId } });
  }
}

async function control(action: "pause" | "resume" | "recover") {
  mutationPaused.value = true;
  try {
    await controlMutation.execute(action);
  } finally {
    mutationPaused.value = false;
  }
}

async function cancelRun(runId: string) {
  mutationPaused.value = true;
  try {
    await cancelRunMutation.execute(runId);
  } finally {
    mutationPaused.value = false;
  }
}
</script>

<template>
  <div v-if="loading" class="runtime-state">Loading durable Runtime facts…</div>
  <div v-else-if="apiError && !runtime" class="runtime-state error">Runtime API unreachable: {{ apiError }}</div>
  <div v-else-if="runtime" class="runtime-dashboard">
    <div v-if="apiError" class="runtime-state error">{{ apiError }}</div>

    <!-- Part 1: single Runtime status surface -->
    <section class="runtime-status-surface" :class="runtime.status">
      <div class="status-main">
        <span class="status-word" :class="statusClass(runtime.status)">{{ runtime.status }}</span>
        <span class="loop-phase" :class="phaseClass(runtime.loop.phase)">{{ runtime.loop.phase }}</span>
        <span class="dim">Uptime {{ uptime }} · PID {{ runtime.pid ?? "—" }} · {{ runtime.loop.totalCycles.toLocaleString() }} cycles · refreshed {{ formatDateTime(runtime.lastRefreshedAt) }}</span>
      </div>
      <div class="status-actions">
        <button
          v-if="runtime.controls.pause"
          type="button"
          class="control-button"
          :disabled="controlling"
          @click="control('pause')"
        >Pause</button>
        <button
          v-else-if="runtime.controls.resume"
          type="button"
          class="control-button primary"
          :disabled="controlling"
          @click="control('resume')"
        >Resume</button>
      </div>
      <div v-if="runtime.statusReason" class="status-reason">
        <strong>Reason:</strong> {{ runtime.statusReason }}
        <span v-if="runtime.stale || stale" class="stale-tag">stale</span>
      </div>
      <div v-if="runtime.recommendedAction" class="status-action">
        <strong>Recommended:</strong> {{ runtime.recommendedAction }}
      </div>
    </section>

    <!-- Part 2: unified Loop Workload -->
    <section class="panel workload-panel">
      <div class="panel-header">Workload</div>
      <div class="panel-body">
        <div v-if="runtime.workload.total === 0" class="empty-inline">No active workload</div>
        <div v-else class="workload-metrics">
          <div class="workload-metric">
            <div class="metric-value">{{ runtime.workload.ready }}</div>
            <div class="metric-label">Ready</div>
          </div>
          <div class="workload-metric">
            <div class="metric-value">{{ runtime.workload.running }}</div>
            <div class="metric-label">Running</div>
          </div>
          <div class="workload-metric">
            <div class="metric-value">{{ runtime.workload.retrying }}</div>
            <div class="metric-label">Retrying</div>
          </div>
          <div class="workload-metric total">
            <div class="metric-value">{{ runtime.workload.total }}</div>
            <div class="metric-label">Total</div>
          </div>
        </div>
      </div>
    </section>

    <div v-if="cancelRunError" class="runtime-state error">
      {{ cancelRunError }}
    </div>
    <AgentRunOverview
      v-if="latestAgentRun"
      :run="latestAgentRun"
      :cancelling="cancellingRun"
      @cancel="cancelRun"
    />
    <section v-else class="panel agent-run-empty">
      <div class="panel-header">Latest Agent Run</div>
      <div class="panel-body empty-inline">
        {{ agentRunError ? `Agent Run view unavailable: ${agentRunError}` : "No Agent Run yet" }}
      </div>
    </section>

    <!-- Part 5: Failures and recovery -->
    <section v-if="runtime.failures.length > 0 || runtime.controls.recover" class="panel failures-panel">
      <div class="panel-header">
        <span>Failures</span>
        <button
          v-if="runtime.controls.recover"
          type="button"
          class="control-button recovery"
          :disabled="controlling"
          @click="control('recover')"
        >Recover</button>
      </div>
      <div class="panel-body">
        <div v-if="runtime.failures.length === 0" class="empty-inline">No active failures</div>
        <div v-else class="failure-list">
          <div
            v-for="failure in runtime.failures"
            :key="failure.failureRef"
            class="failure-row"
            :class="{ active: failure.failureRef === selectedFailureRef }"
          >
            <div class="failure-head">
              <span class="failure-owner">{{ failure.owner }}</span>
              <span class="mono">{{ failure.failureRef }}</span>
              <span class="dim">{{ formatDateTime(failure.occurredAt) }}</span>
            </div>
            <div class="failure-detail">
              <span class="mono">{{ failure.objectRef }}</span>
              <span v-if="failure.eventId" class="mono">{{ failure.eventId }}</span>
              <span v-if="failure.relatedRef" class="mono">{{ failure.relatedRef }}</span>
            </div>
            <div class="failure-reason">{{ failure.reason }}</div>
            <div class="failure-actions">
              <button
                type="button"
                class="text-button"
                :disabled="!hasActionableConsoleTarget(failure)"
                @click="inspectFailure(failure)"
              >Inspect trace</button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Diagnostics disclosure -->
    <details class="diagnostics-disclosure">
      <summary>Diagnostics</summary>
      <div class="diagnostics-body">
        <div><strong>Version:</strong> v{{ runtime.version }}</div>
        <div><strong>Schema:</strong> v{{ runtime.schemaVersion ?? "—" }}</div>
        <div><strong>Runtime root:</strong> <span class="mono secret">{{ runtime.runtimeRoot }}</span></div>
        <div><strong>Workspace:</strong> <span class="mono secret">{{ runtime.workspaceRoot }}</span></div>
        <div><strong>Started:</strong> {{ formatDateTime(runtime.startedAt) }}</div>
        <div><strong>Last cycle:</strong> {{ formatDateTime(runtime.loop.lastCycleEndAt) }}<span v-if="runtime.loop.lastCycleDurationMs !== null"> · {{ runtime.loop.lastCycleDurationMs }}ms</span></div>
      </div>
    </details>

    <!-- Control result receipt -->
    <section v-if="runtime.controlResult" class="panel control-result-panel">
      <div class="panel-header">Control result · {{ runtime.controlResult.kind }}</div>
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
</template>

<style scoped>
.runtime-dashboard { max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
.runtime-state { max-width: 900px; margin: 0 auto 12px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text-secondary); }
.runtime-status-surface { padding: 14px 16px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; gap: 8px; }
.runtime-status-surface.running { border-color: var(--success); background: var(--success-soft); }
.runtime-status-surface.paused { border-color: var(--muted); background: var(--muted-soft); }
.runtime-status-surface.degraded { border-color: var(--warning); background: var(--warning-soft); }
.runtime-status-surface.stopped { border-color: var(--danger); background: var(--danger-soft); }
.status-main { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.status-word { font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; }
.status-word.success { color: var(--success); }
.status-word.muted { color: var(--muted); }
.status-word.warning { color: var(--warning); }
.status-word.danger { color: var(--danger); }
.loop-phase { display: inline-flex; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
.loop-phase.success { background: var(--success-soft); color: var(--success); }
.loop-phase.primary { background: var(--primary-soft); color: var(--primary); }
.loop-phase.muted { background: var(--muted-soft); color: var(--muted); }
.status-actions { margin-left: auto; display: flex; gap: 8px; }
.status-reason, .status-action { font-size: 13px; color: var(--text-secondary); }
.status-reason strong, .status-action strong { color: var(--text); }
.stale-tag { margin-left: 8px; padding: 1px 6px; border-radius: 4px; background: var(--danger-soft); color: var(--danger); font-size: 10px; font-weight: 700; text-transform: uppercase; }
.panel { border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); overflow: hidden; }
.panel-header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); }
.panel-header .control-button { margin-left: auto; }
.panel-body { padding: 14px; }
.workload-metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.workload-metric { text-align: center; padding: 14px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--border); }
.workload-metric.total { background: var(--primary-soft); border-color: var(--primary); }
.metric-value { font-size: 28px; font-weight: 700; color: var(--text); line-height: 1; }
.metric-label { margin-top: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); }
.failure-list { display: flex; flex-direction: column; gap: 10px; }
.failure-row { padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
.failure-row.active { border-color: var(--danger); outline: 2px solid var(--danger-soft); }
.failure-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 13px; margin-bottom: 6px; }
.failure-owner { padding: 1px 6px; border-radius: 4px; background: var(--danger-soft); color: var(--danger); font-size: 10px; font-weight: 700; text-transform: uppercase; }
.failure-detail { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
.failure-reason { font-size: 13px; color: var(--text); margin-bottom: 8px; }
.failure-actions { display: flex; gap: 10px; }
.text-button { appearance: none; background: transparent; border: none; padding: 0; color: var(--primary); font-size: 12px; font-weight: 600; cursor: pointer; }
.text-button:hover { text-decoration: underline; }
.text-button:disabled { color: var(--text-dim); cursor: not-allowed; text-decoration: none; }
.diagnostics-disclosure { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.diagnostics-disclosure summary { padding: 10px 14px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); cursor: pointer; }
.diagnostics-disclosure summary:hover { background: var(--surface-2); }
.diagnostics-body { padding: 12px 14px; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; font-size: 12px; color: var(--text-secondary); }
.control-button { appearance: none; border: 1px solid var(--border); background: var(--surface); color: var(--text); padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; }
.control-button:hover { background: var(--bg); }
.control-button.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.control-button.primary:hover { background: #1d4ed8; }
.control-button.recovery { border-color: var(--warning); color: var(--warning); }
.control-button.recovery:hover { background: var(--warning-soft); }
.control-button:disabled { opacity: 0.5; cursor: not-allowed; }
.control-result { padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
.control-result.succeeded { border-color: #bbf7d0; background: var(--success-soft); }
.control-result.in-progress { border-color: #bfdbfe; background: var(--primary-soft); }
.control-result.failed { border-color: #fecaca; background: var(--danger-soft); }
.control-result-status { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
.control-result-message { font-size: 13px; color: var(--text-secondary); margin-bottom: 10px; }
.recover-counts { display: flex; gap: 8px; flex-wrap: wrap; }
.metric-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); font-size: 12px; color: var(--text-secondary); }
.metric-chip strong { color: var(--text); font-weight: 700; }
.metric-chip.success { border-color: #bbf7d0; background: var(--success-soft); color: var(--success); }
.metric-chip.warning { border-color: #fde68a; background: var(--warning-soft); color: var(--warning); }
.metric-chip.failed { border-color: #fecaca; background: var(--danger-soft); color: var(--danger); }
.empty-inline { color: var(--text-dim); font-size: 13px; }
.dim { color: var(--text-secondary); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.secret { direction: rtl; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 260px; display: inline-block; vertical-align: bottom; }
@media (max-width: 640px) {
  .status-main { flex-direction: column; align-items: flex-start; gap: 6px; }
  .status-actions { margin-left: 0; }
  .workload-metrics { grid-template-columns: repeat(2, 1fr); }
  .diagnostics-body { grid-template-columns: 1fr; }
}
</style>
