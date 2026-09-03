<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { requestJson } from "@/api/client";
import {
  scheduleDetailViewSchema,
  scheduleArchiveResponseSchema,
  scheduleResolveResponseSchema,
  scheduleRunNowResponseSchema,
  scheduleSummaryViewsSchema,
  type ScheduledRunViewOutput
} from "@/api/schema";
import { useApi } from "@/composables/useApi";
import { useMutation } from "@/composables/useMutation";
import AgentInvocationDetail from "@/components/AgentInvocationDetail.vue";
import ListControls from "@/components/ListControls.vue";
import PaginationControls from "@/components/PaginationControls.vue";
import { formatDateTime } from "@/utils/format";

const route = useRoute();
const router = useRouter();
const queryScheduleId = Array.isArray(route.query.scheduleId)
  ? route.query.scheduleId[0] ?? ""
  : route.query.scheduleId ?? "";
const selectedId = ref(queryScheduleId);
const mutationPaused = ref(false);
const receipt = ref<string | null>(null);
const archivedView = ref(false);
const searchQuery = ref("");
const currentPage = ref(1);
const PAGE_SIZE = 20;

const schedulesUrl = computed(() => {
  const parameters = new URLSearchParams({
    page: String(currentPage.value),
    pageSize: String(PAGE_SIZE),
    archive: archivedView.value ? "archived" : "current"
  });
  if (searchQuery.value.trim() !== "") parameters.set("q", searchQuery.value.trim());
  return `/api/schedules?${parameters}`;
});
const schedulesQuery = useApi({
  url: schedulesUrl,
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

const schedules = computed(() => schedulesQuery.data.value?.items ?? []);
const total = computed(() => schedulesQuery.data.value?.total ?? 0);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const detail = detailQuery.data;
const loading = computed(() =>
  schedulesQuery.loading.value || (selectedId.value !== "" && detailQuery.loading.value));
const error = computed(() =>
  lifecycleMutation.error.value ??
  archiveMutation.error.value ??
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

watch([searchQuery, archivedView], async () => {
  currentPage.value = 1;
  schedulesQuery.data.value = null;
  detailQuery.data.value = null;
  selectedId.value = "";
  await schedulesQuery.refresh();
  selectedId.value = schedules.value[0]?.scheduleId ?? "";
});

watch(currentPage, async () => {
  await schedulesQuery.refresh();
  if (!schedules.value.some((schedule) => schedule.scheduleId === selectedId.value)) {
    detailQuery.data.value = null;
    selectedId.value = schedules.value[0]?.scheduleId ?? "";
  }
});

watch(pageCount, (next) => {
  currentPage.value = Math.min(currentPage.value, next);
});

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

const archiveMutation = useMutation({
  execute(archived: boolean, signal: AbortSignal) {
    return requestJson(
      `/api/schedules/${encodeURIComponent(selectedId.value)}/${archived ? "archive" : "unarchive"}`,
      scheduleArchiveResponseSchema,
      {
        method: "POST",
        headers: { "X-Rollerskate-Request": "console" },
        signal
      }
    );
  }
});

const busy = computed(() =>
  lifecycleMutation.pending.value ||
  archiveMutation.pending.value ||
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

async function setArchived(archived: boolean) {
  mutationPaused.value = true;
  receipt.value = null;
  try {
    const result = await archiveMutation.execute(archived);
    if (result === null) return;
    receipt.value = `Schedule ${result.status}.`;
    detailQuery.data.value = null;
    selectedId.value = "";
    await schedulesQuery.refresh();
    if (schedules.value.length === 0 && currentPage.value > 1) {
      currentPage.value -= 1;
      await schedulesQuery.refresh();
    }
    selectedId.value = schedules.value[0]?.scheduleId ?? "";
  } finally {
    mutationPaused.value = false;
  }
}

function goToPage(page: number) {
  currentPage.value = Math.min(Math.max(1, page), pageCount.value);
}

function runConversationStatus(run: ScheduledRunViewOutput): string {
  return run.audit?.resultEvent?.outcome ?? run.audit?.execution?.status ?? run.status;
}

function runConversationCompletedAt(run: ScheduledRunViewOutput): string | null {
  return run.audit?.invocation?.completedAt ??
    run.audit?.resultEvent?.createdAt ??
    run.audit?.execution?.completedAt ??
    run.completedAt;
}

function runConversationError(run: ScheduledRunViewOutput): string | null {
  return run.audit?.resultEvent?.error ?? run.audit?.execution?.lastError ?? null;
}

function proactiveTargetKind(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const kind = (value as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : null;
}

function externalExecution(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
</script>

<template>
  <div class="operations-view">
    <aside class="panel operations-list" aria-label="Schedules">
      <ListControls
        title="Schedules"
        :total="total"
        :search="searchQuery"
        :archived="archivedView"
        :busy="archiveMutation.pending.value"
        @update:search="searchQuery = $event"
        @toggle-archive="archivedView = !archivedView"
      />
      <div v-if="schedulesQuery.loading.value" class="state">Loading Schedules…</div>
      <div v-else class="list-body">
        <div v-if="schedules.length === 0" class="state">
          {{ archivedView ? "No archived Schedule." : "No Schedule has been created." }}
        </div>
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
        <PaginationControls
          :page="currentPage"
          :page-size="PAGE_SIZE"
          :total="total"
          @page="goToPage"
        />
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
            <button v-if="detail.summary.availableActions.archive" type="button" class="control-button" :disabled="busy" @click="setArchived(true)">Archive</button>
            <button v-if="detail.summary.availableActions.unarchive" type="button" class="control-button" :disabled="busy" @click="setArchived(false)">Unarchive</button>
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
          <div v-if="detail.summary.agent"><span class="detail-label">Legacy target</span><strong>@{{ detail.summary.agent.handle }}</strong><span class="dim">{{ detail.summary.agent.client }}</span></div>
          <div v-else><span class="detail-label">Execution owner</span><strong>{{ proactiveTargetKind(detail.summary.target) === "external_workflow" ? "Owner external workflow" : proactiveTargetKind(detail.summary.target) === "application_action" ? "Owner application action" : "Bound Steward Run" }}</strong><span class="dim">Schedule owns timing and occurrence identity</span></div>
          <div v-if="detail.summary.sessionPolicy"><span class="detail-label">Legacy session</span><strong>{{ detail.summary.sessionPolicy }}</strong><span class="mono compact-ref">{{ detail.summary.fixedSessionId ?? "new per run" }}</span></div>
          <div v-else-if="detail.summary.sourceBinding"><span class="detail-label">Source binding</span><strong>RunSourceBinding@1</strong></div>
          <div v-else><span class="detail-label">Target contract</span><strong>ProactiveTarget@1</strong></div>
          <div><span class="detail-label">Misfire</span><strong>{{ detail.revision.misfirePolicy }}</strong><span class="dim">{{ detail.revision.misfireGraceMilliseconds }}ms grace</span></div>
          <div><span class="detail-label">Overlap</span><strong>{{ detail.revision.overlapPolicy }}</strong></div>
        </section>

        <details class="diagnostics-disclosure">
          <summary>Definition</summary>
          <div class="definition-body">
            <template v-if="detail.summary.target">
              <pre class="mono callback-receipt">{{ JSON.stringify(detail.summary.target, null, 2) }}</pre>
            </template>
            <template v-else-if="detail.summary.sourceBinding">
              <pre class="mono callback-receipt">{{ JSON.stringify(detail.summary.sourceBinding, null, 2) }}</pre>
            </template>
            <template v-else>
              <div><strong>Legacy prompt:</strong> {{ detail.revision.prompt }}</div>
              <div><strong>Legacy workspace:</strong> <span class="mono compact-ref">{{ detail.revision.workspace }}</span></div>
            </template>
            <div><strong>Created:</strong> {{ formatDateTime(detail.revision.createdAt) }}</div>
          </div>
        </details>

        <section class="detail-section">
          <div class="section-heading">Occurrences · {{ detail.runs.length }}</div>
          <div v-if="detail.runs.length === 0" class="empty-inline">No occurrences recorded.</div>
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
                  v-if="run.agentRunId"
                  class="failure-link mono"
                  :to="{ name: 'steward', query: { runId: run.agentRunId, ...(run.cycleId ? { cycleId: run.cycleId } : {}) } }"
                >{{ run.agentRunId }}<template v-if="run.cycleId"> / {{ run.cycleId }}</template> → Run Workspace</RouterLink>
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
              <details v-if="externalExecution(run.externalWorkflowExecution)" class="diagnostics-disclosure">
                <summary>External workflow · {{ externalExecution(run.externalWorkflowExecution)?.status }}</summary>
                <pre class="mono callback-receipt">{{ JSON.stringify(run.externalWorkflowExecution, null, 2) }}</pre>
              </details>
              <details v-if="run.callbacks.length > 0" class="diagnostics-disclosure">
                <summary>Callbacks · {{ run.callbacks.length }}</summary>
                <div class="callback-list">
                  <div v-for="callback in run.callbacks" :key="callback.occurrenceId" class="callback-row">
                    <div class="run-head">
                      <strong>{{ callback.ordinal + 1 }}. {{ callback.kind }}</strong>
                      <span class="status-pill" :class="callback.status === 'succeeded' ? 'ok' : callback.status === 'failed' || callback.status === 'unknown' ? 'degraded' : ''">{{ callback.status }}</span>
                      <span class="dim">{{ callback.phase }}</span>
                    </div>
                    <div class="run-refs">
                      <span class="mono compact-ref">{{ callback.occurrenceId }}</span>
                      <span v-if="callback.eventId" class="mono compact-ref">{{ callback.eventId }}</span>
                      <span v-if="callback.deliveryId" class="mono compact-ref">{{ callback.deliveryId }}</span>
                    </div>
                    <div v-if="callback.delivery" class="dim">
                      Delivery {{ callback.delivery.status }} · {{ callback.delivery.attemptCount }}/{{ callback.delivery.maxAttempts }} attempts
                    </div>
                    <div v-if="callback.lastError || callback.delivery?.lastError" class="state error">
                      {{ callback.lastError ?? callback.delivery?.lastError }}
                    </div>
                    <pre v-if="callback.receipt !== null" class="mono callback-receipt">{{ JSON.stringify(callback.receipt, null, 2) }}</pre>
                  </div>
                </div>
              </details>
              <div v-if="run.audit && detail.summary.agent" class="run-conversation">
                <AgentInvocationDetail
                  :agent="detail.summary.agent"
                  :status="runConversationStatus(run)"
                  :created-at="run.audit.event.createdAt"
                  :completed-at="runConversationCompletedAt(run)"
                  :prompt="run.audit.event.prompt ?? detail.revision.prompt ?? undefined"
                  :effective-prompt="run.audit.invocation?.effectivePrompt"
                  :raw-output="run.audit.resultEvent?.output"
                  :error="runConversationError(run)"
                  :invocation="run.audit.invocation"
                  :request-event-id="run.audit.event.eventId"
                  :result-event-id="run.audit.resultEvent?.eventId"
                  :expanded="run === detail.runs[0]"
                  expand-raw-output
                />
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
.list-body { min-height: 0; flex: 1 1 0; display: flex; flex-direction: column; }
.operation-rows { min-height: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 6px; padding: 8px; overflow: auto; }
.operation-row { display: flex; flex-direction: column; gap: 5px; width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: inherit; text-align: left; cursor: pointer; }
.operation-row:hover, .operation-row.active { border-color: var(--primary); }
.operation-row.active { outline: 2px solid var(--primary-soft); }
.row-top, .status-line, .run-head, .action-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.row-top { justify-content: space-between; }
.callback-list { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.callback-row { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius); }
.callback-receipt { margin: 0; max-height: 180px; overflow: auto; white-space: pre-wrap; }
.row-meta, .detail-label { color: var(--text-secondary); font-size: 12px; }
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
.run-conversation { margin-top: 10px; }
.failure-link { color: var(--danger); }
.control-receipt { border: 1px solid var(--success); background: var(--success-soft); border-radius: var(--radius); padding: 9px 11px; }
.compact-ref { overflow-wrap: anywhere; }
@media (max-width: 1000px) {
  .detail-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 900px) {
  .detail-grid { grid-template-columns: minmax(0, 1fr); }
  .detail-heading { flex-direction: column; }
}
</style>
