<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { requestJson } from "@/api/client";
import {
  scheduleDetailViewSchema,
  scheduleResolveResponseSchema,
  scheduleRunNowResponseSchema,
  scheduleSummaryViewsSchema,
  type ScheduledRunViewOutput
} from "@/api/schema";
import { useApi } from "@/composables/useApi";
import { useMutation } from "@/composables/useMutation";
import { formatDateTime } from "@/utils/format";

const route = useRoute();
const router = useRouter();
const queryScheduleId = Array.isArray(route.query.scheduleId)
  ? route.query.scheduleId[0] ?? ""
  : route.query.scheduleId ?? "";
const selectedId = ref(queryScheduleId);
const mutationPaused = ref(false);
const receipt = ref<string | null>(null);

const schedulesQuery = useApi({
  url: "/api/schedules",
  schema: scheduleSummaryViewsSchema,
  interval: 5_000,
  paused: mutationPaused
});
const detailUrl = computed(() =>
  `/api/schedules/${encodeURIComponent(selectedId.value || "__unselected__")}`);
const detailQuery = useApi({
  url: detailUrl,
  schema: scheduleDetailViewSchema,
  interval: 5_000,
  paused: mutationPaused,
  immediate: false
});

const schedules = computed(() => schedulesQuery.data.value ?? []);
const detail = detailQuery.data;
const loading = computed(() =>
  schedulesQuery.loading.value || (selectedId.value !== "" && detailQuery.loading.value));
const error = computed(() =>
  lifecycleMutation.error.value ??
  runNowMutation.error.value ??
  resolveMutation.error.value ??
  detailQuery.error.value ??
  schedulesQuery.error.value);

watch(schedules, (next) => {
  if (selectedId.value === "" && next.length > 0) {
    selectedId.value = next[0]!.scheduleId;
  }
}, { immediate: true });

watch(selectedId, (next) => {
  if (next === "") return;
  receipt.value = null;
  detailQuery.data.value = null;
  void router.replace({ name: "schedules", query: { scheduleId: next } });
  void detailQuery.refresh();
}, { immediate: true });

async function refreshAll() {
  await Promise.all([schedulesQuery.refresh(), detailQuery.refresh()]);
}

const lifecycleMutation = useMutation({
  execute(action: "pause" | "resume" | "cancel", signal: AbortSignal) {
    return requestJson(
      `/api/schedules/${encodeURIComponent(selectedId.value)}/${action}`,
      scheduleDetailViewSchema,
      {
        method: "POST",
        headers: { "X-Rollerskate-Request": "console" },
        signal
      }
    );
  },
  refresh: refreshAll
});

const runNowMutation = useMutation({
  execute(_: undefined, signal: AbortSignal) {
    return requestJson(
      `/api/schedules/${encodeURIComponent(selectedId.value)}/run-now`,
      scheduleRunNowResponseSchema,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Rollerskate-Request": "console"
        },
        body: JSON.stringify({ requestId: `console:${crypto.randomUUID()}` }),
        signal
      }
    );
  },
  refresh: refreshAll
});

const resolveMutation = useMutation({
  execute(input: { runId: string; outcome: "succeeded" | "failed" }, signal) {
    return requestJson(
      `/api/schedules/${encodeURIComponent(selectedId.value)}/runs/${encodeURIComponent(input.runId)}/resolve`,
      scheduleResolveResponseSchema,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Rollerskate-Request": "console"
        },
        body: JSON.stringify({ outcome: input.outcome }),
        signal
      }
    );
  },
  refresh: refreshAll
});

const busy = computed(() =>
  lifecycleMutation.pending.value ||
  runNowMutation.pending.value ||
  resolveMutation.pending.value);

async function lifecycle(action: "pause" | "resume" | "cancel") {
  mutationPaused.value = true;
  receipt.value = null;
  const result = await lifecycleMutation.execute(action);
  if (result !== null) receipt.value = `Schedule ${action} succeeded.`;
  mutationPaused.value = false;
}

async function runNow() {
  mutationPaused.value = true;
  receipt.value = null;
  const result = await runNowMutation.execute(undefined);
  if (result !== null) {
    receipt.value = `Run ${result.receipt.status}: ${result.receipt.run.runId}`;
  }
  mutationPaused.value = false;
}

async function resolveRun(run: ScheduledRunViewOutput, outcome: "succeeded" | "failed") {
  mutationPaused.value = true;
  receipt.value = null;
  const result = await resolveMutation.execute({ runId: run.runId, outcome });
  if (result !== null) receipt.value = `Run ${run.runId} resolved ${outcome}.`;
  mutationPaused.value = false;
}
</script>

<template>
  <div class="operations-view">
    <aside class="panel operations-list" aria-label="Schedules">
      <div class="panel-header">
        <span>Schedules</span>
        <span class="dim">{{ schedules.length }}</span>
      </div>
      <div v-if="schedulesQuery.loading.value" class="state">Loading Schedules…</div>
      <div v-else-if="schedules.length === 0" class="state">No Schedule has been created.</div>
      <div v-else class="operation-rows">
        <button
          v-for="schedule in schedules"
          :key="schedule.scheduleId"
          type="button"
          class="operation-row"
          :class="{ active: schedule.scheduleId === selectedId }"
          :aria-selected="schedule.scheduleId === selectedId"
          @click="selectedId = schedule.scheduleId"
        >
          <span class="row-top">
            <strong>{{ schedule.kind }} · rev {{ schedule.currentRevision }}</strong>
            <span class="status-pill" :class="schedule.status === 'active' ? 'ok' : schedule.status === 'paused' ? '' : 'degraded'">{{ schedule.status }}</span>
          </span>
          <span class="mono compact-ref">{{ schedule.scheduleId }}</span>
          <span class="row-meta">{{ schedule.expression }}</span>
          <span class="row-meta">{{ schedule.runCounts.running }} running · {{ schedule.runCounts.unknown }} unknown</span>
        </button>
      </div>
    </aside>

    <main class="panel operations-detail">
      <div v-if="loading && !detail" class="state">Loading Schedule detail…</div>
      <div v-else-if="error && !detail" class="state error" role="alert">{{ error }}</div>
      <template v-else-if="detail">
        <div class="detail-heading">
          <div>
            <div class="eyebrow">SCHEDULE</div>
            <h1>{{ detail.summary.kind }} · revision {{ detail.summary.currentRevision }}</h1>
            <div class="mono compact-ref">{{ detail.summary.scheduleId }}</div>
          </div>
          <div class="action-row">
            <button v-if="detail.summary.availableActions.pause" type="button" class="control-button" :disabled="busy" @click="lifecycle('pause')">Pause</button>
            <button v-if="detail.summary.availableActions.resume" type="button" class="control-button primary" :disabled="busy" @click="lifecycle('resume')">Resume</button>
            <button v-if="detail.summary.availableActions.runNow" type="button" class="control-button" :disabled="busy" @click="runNow">Run now</button>
            <button v-if="detail.summary.availableActions.cancel" type="button" class="control-button danger" :disabled="busy" @click="lifecycle('cancel')">Cancel</button>
          </div>
        </div>

        <div v-if="error" class="state error" role="alert">{{ error }}</div>
        <div v-if="receipt" class="control-receipt">{{ receipt }}</div>

        <section class="status-surface" :class="detail.summary.status">
          <div class="status-line">
            <span class="status-word">{{ detail.summary.status }}</span>
            <span>next {{ formatDateTime(detail.summary.nextRunAt) }}</span>
            <span v-if="detail.summary.nextOccurrenceMissing" class="status-pill degraded">DST adjusted</span>
          </div>
          <p>{{ detail.summary.statusReason }}</p>
        </section>

        <section class="detail-grid">
          <div><span class="detail-label">Expression</span><strong class="mono compact-ref">{{ detail.summary.expression }}</strong></div>
          <div><span class="detail-label">Timezone</span><strong>{{ detail.summary.timezone ?? "explicit offset" }}</strong></div>
          <div><span class="detail-label">Target</span><strong>@{{ detail.summary.agent.handle }}</strong><span class="dim">{{ detail.summary.agent.client }}</span></div>
          <div><span class="detail-label">Session</span><strong>{{ detail.summary.sessionPolicy }}</strong><span class="mono compact-ref">{{ detail.summary.fixedSessionId ?? "new per run" }}</span></div>
          <div><span class="detail-label">Misfire</span><strong>{{ detail.revision.misfirePolicy }}</strong><span class="dim">{{ detail.revision.misfireGraceMilliseconds }}ms grace</span></div>
          <div><span class="detail-label">Overlap</span><strong>{{ detail.revision.overlapPolicy }}</strong></div>
        </section>

        <details class="diagnostics-disclosure">
          <summary>Definition</summary>
          <div class="definition-body">
            <div><strong>Prompt:</strong> {{ detail.revision.prompt }}</div>
            <div><strong>Workspace:</strong> <span class="mono compact-ref">{{ detail.revision.workspace }}</span></div>
            <div><strong>Created:</strong> {{ formatDateTime(detail.revision.createdAt) }}</div>
          </div>
        </details>

        <section class="detail-section">
          <div class="section-heading">Runs · {{ detail.runs.length }}</div>
          <div v-if="detail.runs.length === 0" class="empty-inline">No runs recorded.</div>
          <div v-else class="run-list">
            <article v-for="run in detail.runs" :key="run.runId" class="run-row" :class="run.status">
              <div class="run-head">
                <span class="status-pill" :class="run.status === 'succeeded' ? 'ok' : run.status === 'failed' || run.status === 'unknown' ? 'degraded' : ''">{{ run.status }}</span>
                <span class="mono compact-ref">{{ run.runId }}</span>
                <span class="dim">{{ formatDateTime(run.scheduledFor) }}</span>
              </div>
              <p>{{ run.statusReason }}</p>
              <div class="run-refs">
                <span v-if="run.eventId" class="mono">{{ run.eventId }}</span>
                <span v-if="run.sessionId" class="mono">{{ run.sessionId }}</span>
                <RouterLink
                  v-if="run.failure"
                  class="failure-link mono"
                  :to="run.failure.consoleRoute"
                >{{ run.failure.failureRef }} → Runtime Failure</RouterLink>
              </div>
              <div v-if="run.availableActions.resolveSucceeded || run.availableActions.resolveFailed" class="action-row">
                <button type="button" class="text-button" :disabled="busy" @click="resolveRun(run, 'succeeded')">Resolve succeeded</button>
                <button type="button" class="text-button danger" :disabled="busy" @click="resolveRun(run, 'failed')">Resolve failed</button>
              </div>
            </article>
          </div>
        </section>
      </template>
      <div v-else class="state">Select a Schedule.</div>
    </main>
  </div>
</template>

<style scoped>
.operations-view { display: grid; grid-template-columns: minmax(260px, 0.8fr) minmax(0, 2fr); gap: 12px; min-width: 0; }
.operations-list, .operations-detail { min-width: 0; }
.operation-rows { display: flex; flex-direction: column; gap: 6px; padding: 8px; }
.operation-row { display: flex; flex-direction: column; gap: 5px; width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: inherit; text-align: left; cursor: pointer; }
.operation-row:hover, .operation-row.active { border-color: var(--primary); }
.operation-row.active { outline: 2px solid var(--primary-soft); }
.row-top, .status-line, .run-head, .action-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.row-top { justify-content: space-between; }
.row-meta, .detail-label { color: var(--text-secondary); font-size: 12px; }
.operations-detail { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.detail-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.detail-heading h1 { margin: 2px 0 4px; font-size: 20px; }
.status-surface { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; background: var(--surface); }
.status-surface.active { border-color: var(--success); background: var(--success-soft); }
.status-surface.cancelled { border-color: var(--danger); background: var(--danger-soft); }
.status-surface p { margin: 8px 0 0; color: var(--text-secondary); }
.status-word { font-weight: 700; text-transform: uppercase; }
.detail-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.detail-grid > div { display: flex; min-width: 0; flex-direction: column; gap: 3px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); }
.definition-body { display: flex; flex-direction: column; gap: 8px; padding: 10px 0; }
.detail-section { display: flex; flex-direction: column; gap: 8px; }
.section-heading { font-weight: 700; }
.run-list { display: flex; flex-direction: column; gap: 8px; }
.run-row { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px; }
.run-row.unknown, .run-row.failed { border-color: var(--warning); }
.run-row p { margin: 8px 0; color: var(--text-secondary); }
.run-refs { display: flex; flex-wrap: wrap; gap: 8px; }
.failure-link { color: var(--danger); }
.control-receipt { border: 1px solid var(--success); background: var(--success-soft); border-radius: var(--radius); padding: 9px 11px; }
.compact-ref { overflow-wrap: anywhere; }
@media (max-width: 1000px) {
  .detail-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 900px) {
  .operations-view { grid-template-columns: minmax(0, 1fr); }
  .detail-grid { grid-template-columns: minmax(0, 1fr); }
  .detail-heading { flex-direction: column; }
}
</style>
