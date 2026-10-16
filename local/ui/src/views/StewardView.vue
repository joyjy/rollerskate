<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";

import { requestJson } from "@/api/client";
import {
  answerAgentRunReceiptSchema,
  agentRunSummariesSchema,
  authorizeAgentRunCapabilityReceiptSchema,
  cancelAgentRunReceiptSchema,
  setAgentRunArchivedReceiptSchema,
  runDetailViewSchema
} from "@/api/schema";
import type { AgentRunDetailViewOutput, RunDetailViewOutput } from "@/api/schema";
import AgentRunOverview from "@/components/AgentRunOverview.vue";
import ListControls from "@/components/ListControls.vue";
import PaginationControls from "@/components/PaginationControls.vue";
import { useApi } from "@/composables/useApi";
import { useMutation } from "@/composables/useMutation";
import { formatDateTime } from "@/utils/format";

const route = useRoute();
const router = useRouter();
const routeRunId = computed(() => {
  const value = route.query.runId;
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
});
const routeCycleId = computed(() => queryText(route.query.cycleId));
const routeOutputId = computed(() => queryText(route.query.outputId));
const selectedId = ref(routeRunId.value);
const mutationPaused = ref(false);
const archivedView = ref(false);
const searchQuery = ref("");
const currentPage = ref(1);
const PAGE_SIZE = 20;

const runsUrl = computed(() => {
  const parameters = new URLSearchParams({
    page: String(currentPage.value),
    pageSize: String(PAGE_SIZE),
    archive: archivedView.value ? "archived" : "current"
  });
  if (searchQuery.value.trim() !== "") parameters.set("q", searchQuery.value.trim());
  return `/api/runs?${parameters}`;
});
const runsQuery = useApi({
  url: runsUrl,
  schema: agentRunSummariesSchema,
  interval: 5_000,
  paused: mutationPaused
});
const detailUrl = computed(() =>
  `/api/runs/${encodeURIComponent(selectedId.value)}`);
const detailQuery = useApi({
  url: detailUrl,
  schema: runDetailViewSchema,
  interval: 5_000,
  paused: computed(() => mutationPaused.value || selectedId.value === ""),
  immediate: false
});

const runs = computed(() => {
  return runsQuery.data.value?.items ?? [];
});
const total = computed(() => runsQuery.data.value?.total ?? 0);
const pageCount = computed(() =>
  Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const detail = detailQuery.data;
function isAgentRunDetail(value: RunDetailViewOutput): value is AgentRunDetailViewOutput {
  return "summary" in value;
}
const agentDetail = computed<AgentRunDetailViewOutput | null>(() =>
  detail.value !== null && isAgentRunDetail(detail.value) ? detail.value : null
);
const deterministicDetail = computed<Exclude<RunDetailViewOutput, AgentRunDetailViewOutput> | null>(() =>
  detail.value !== null && !isAgentRunDetail(detail.value) ? detail.value : null
);
const loading = computed(() =>
  runsQuery.loading.value ||
  (selectedId.value !== "" && detailQuery.loading.value));
const error = computed(() =>
  archiveMutation.error.value ??
  cancelMutation.error.value ??
  answerMutation.error.value ??
  capabilityMutation.error.value ??
  detailQuery.error.value ??
  runsQuery.error.value);

watch(runs, (next) => {
  if (selectedId.value === "" && next.length > 0) {
    selectedId.value = next[0]!.runId;
  }
}, { immediate: true });

watch(pageCount, () => {
  currentPage.value = Math.min(currentPage.value, pageCount.value);
});

watch(routeRunId, (next) => {
  if (next !== selectedId.value) selectedId.value = next;
});

watch(selectedId, (next) => {
  if (next === "") {
    if (routeRunId.value !== "") {
      void router.replace({ name: "steward" });
    }
    return;
  }
  detailQuery.data.value = null;
  void router.replace({
    name: "steward",
    query: next === routeRunId.value
      ? {
          runId: next,
          ...(routeCycleId.value ? { cycleId: routeCycleId.value } : {}),
          ...(routeOutputId.value ? { outputId: routeOutputId.value } : {})
        }
      : { runId: next }
  });
  void detailQuery.refresh();
}, { immediate: true });

const cancelMutation = useMutation({
  async execute(input: { runId: string; expectedVersion: number }, signal: AbortSignal) {
    return requestJson(
      `/api/runs/${encodeURIComponent(input.runId)}/cancel`,
      cancelAgentRunReceiptSchema,
      {
        method: "POST",
        headers: { "X-Rollerskate-Request": "console", "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: input.expectedVersion }),
        signal
      }
    );
  },
  async refresh() {
    await Promise.all([runsQuery.refresh(), detailQuery.refresh()]);
  }
});

const answerMutation = useMutation({
  async execute(input: { runId: string; questionId: string; expectedVersion: number; answer: string }, signal: AbortSignal) {
    return requestJson(`/api/runs/${encodeURIComponent(input.runId)}/answer`, answerAgentRunReceiptSchema, {
      method: "POST", headers: { "X-Rollerskate-Request": "console", "Content-Type": "application/json" },
      body: JSON.stringify(input), signal
    });
  },
  async refresh() { await detailQuery.refresh(); }
});
const capabilityMutation = useMutation({
  async execute(input: { runId: string; requestEventId: string; expectedVersion: number }, signal: AbortSignal) {
    return requestJson(`/api/runs/${encodeURIComponent(input.runId)}/authorize-network`, authorizeAgentRunCapabilityReceiptSchema, {
      method: "POST", headers: { "X-Rollerskate-Request": "console", "Content-Type": "application/json" },
      body: JSON.stringify(input), signal
    });
  },
  async refresh() { await detailQuery.refresh(); }
});

const archiveMutation = useMutation({
  async execute(
    input: { readonly runId: string; readonly archived: boolean },
    signal: AbortSignal
  ) {
    const action = input.archived ? "archive" : "unarchive";
    return requestJson(
      `/api/runs/${encodeURIComponent(input.runId)}/${action}`,
      setAgentRunArchivedReceiptSchema,
      {
        method: "POST",
        headers: { "X-Rollerskate-Request": "console" },
        signal
      }
    );
  }
});

async function cancelRun(runId: string, expectedVersion?: number) {
  mutationPaused.value = true;
  try {
    const run = agentDetail.value;
    const version = expectedVersion ?? (run === null ? undefined : run.projection.version);
    if (run !== null && typeof version === "number" && Number.isSafeInteger(version) && version > 0) {
      await cancelMutation.execute({ runId, expectedVersion: version });
    }
  } finally {
    mutationPaused.value = false;
  }
}

async function answerRun(runId: string, questionId: string, expectedVersion: number, answer: string) {
  mutationPaused.value = true;
  try { await answerMutation.execute({ runId, questionId, expectedVersion, answer }); }
  finally { mutationPaused.value = false; }
}
async function authorizeCapability(runId: string, requestEventId: string, expectedVersion: number) {
  mutationPaused.value = true;
  try { await capabilityMutation.execute({ runId, requestEventId, expectedVersion }); }
  finally { mutationPaused.value = false; }
}
async function denyCapability(runId: string, expectedVersion: number) {
  await cancelRun(runId, expectedVersion);
}

async function archiveRun(runId: string, archived: boolean) {
  mutationPaused.value = true;
  try {
    const result = await archiveMutation.execute({ runId, archived });
    if (result === null) return;
    detailQuery.data.value = null;
    selectedId.value = "";
    await runsQuery.refresh();
    if (runs.value.length === 0 && currentPage.value > 1) {
      currentPage.value -= 1;
      await runsQuery.refresh();
    }
    selectedId.value = runs.value[0]?.runId ?? "";
  } finally {
    mutationPaused.value = false;
  }
}

watch([searchQuery, archivedView], async () => {
  currentPage.value = 1;
  runsQuery.data.value = null;
  detailQuery.data.value = null;
  selectedId.value = "";
  await runsQuery.refresh();
  selectedId.value = runs.value[0]?.runId ?? "";
});

watch(currentPage, async () => {
  await runsQuery.refresh();
  if (!runs.value.some((run) => run.runId === selectedId.value)) {
    detailQuery.data.value = null;
    selectedId.value = runs.value[0]?.runId ?? "";
  }
});

function queryText(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return typeof value === "string" ? value : "";
}

function goToPage(page: number) {
  currentPage.value = Math.min(Math.max(1, page), pageCount.value);
}
</script>

<template>
  <div class="operations-view">
    <aside class="panel operations-list" aria-label="Steward Runs">
      <ListControls
        title="Steward"
        :total="total"
        :search="searchQuery"
        :archived="archivedView"
        :busy="archiveMutation.pending.value"
        @update:search="searchQuery = $event"
        @toggle-archive="archivedView = !archivedView"
      />
      <div v-if="runsQuery.loading.value && runs.length === 0" class="state">
        Loading Steward Runs…
      </div>
      <div v-else class="list-body">
        <div v-if="runs.length === 0" class="state list-state">
          {{ archivedView
            ? "No archived Steward Runs."
            : "No Steward Run has been created." }}
        </div>
        <div v-else class="operation-rows">
        <button
          v-for="run in runs"
          :key="run.runId"
          type="button"
          class="operation-row"
          :class="{ active: run.runId === selectedId }"
          :aria-selected="run.runId === selectedId"
          @click="selectedId = run.runId"
        >
          <span class="row-top">
            <strong class="run-title" :title="run.mandate.label">{{ run.mandate.label }}</strong>
            <span class="run-status" :class="run.status">{{ run.status }}</span>
          </span>
          <span class="mono compact-ref" :title="run.runId">{{ run.runId }}</span>
          <span class="row-meta">
            @{{ run.steward.handle }} · {{ formatDateTime(run.updatedAt) }}
          </span>
          <span v-if="run.source" class="row-meta">
            {{ run.source.kind }} · {{ run.source.id }}
          </span>
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
      <div v-if="loading && !detail" class="state">Loading Steward Run…</div>
      <div v-else-if="error && !detail" class="state error" role="alert">{{ error }}</div>
      <template v-else-if="detail">
        <div v-if="error" class="state error" role="alert">{{ error }}</div>
        <AgentRunOverview
          v-if="agentDetail"
          :run="agentDetail"
          :cycle-id="routeCycleId"
          :output-id="routeOutputId"
          :cancelling="cancelMutation.pending.value"
          :answering="answerMutation.pending.value"
          :authorizing="capabilityMutation.pending.value"
          :archiving="archiveMutation.pending.value"
          @cancel="cancelRun"
          @answer="answerRun"
          @authorize-capability="authorizeCapability"
          @deny-capability="denyCapability"
          @archive="archiveRun"
        />
        <section v-else-if="deterministicDetail" class="panel deterministic-detail">
          <div class="panel-header">
            <span>{{ deterministicDetail.kind === "command" ? "Command Run" : "Observation Run" }}</span>
            <span class="status" :class="deterministicDetail.status">{{ deterministicDetail.status }}</span>
          </div>
          <div class="panel-body">
            <div class="run-head">
              <div>
                <strong>{{ deterministicDetail.title }}</strong>
                <div class="dim">{{ formatDateTime(deterministicDetail.updatedAt) }}</div>
              </div>
            </div>
            <dl class="detail-grid">
              <dt>Run</dt><dd class="mono">{{ deterministicDetail.runId }}</dd>
              <dt>Request</dt><dd class="mono">{{ deterministicDetail.requestId }}</dd>
              <dt>Result</dt><dd>{{ deterministicDetail.result ?? "unknown" }}</dd>
              <dt>Return</dt><dd>{{ deterministicDetail.deliveryStatus }}</dd>
            </dl>
            <div v-if="deterministicDetail.errors.length" class="source-error">
              {{ deterministicDetail.errors.join("; ") }}
            </div>
            <p class="detail-note">Command and observation Runs use their source-owned controls. Agent answer, capability, and cancel controls are available only on Agent Run details.</p>
          </div>
        </section>
      </template>
      <div v-else class="state">Select a Steward Run.</div>
    </main>
  </div>
</template>

<style scoped>
.list-body { min-height: 0; flex: 1 1 0; display: flex; flex-direction: column; }
.operation-rows { min-height: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 6px; padding: 8px; overflow: auto; }
.operation-row { min-height: 68px; flex: 0 0 auto; display: flex; flex-direction: column; gap: 5px; width: 100%; padding: 10px; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: inherit; text-align: left; cursor: pointer; }
.operation-row:hover, .operation-row.active { border-color: var(--primary); }
.operation-row.active { outline: 2px solid var(--primary-soft); }
.row-top { min-width: 0; display: flex; align-items: center; gap: 8px; }
.run-title, .compact-ref, .row-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-title { flex: 1 1 auto; }
.row-meta, .detail-label { color: var(--text-secondary); font-size: 12px; }
.run-status { flex: 0 0 auto; margin-left: auto; padding: 2px 7px; border-radius: 999px; background: var(--primary-soft); color: var(--primary); font-size: 10px; font-weight: 700; text-transform: uppercase; }
.run-status.succeeded { background: var(--success-soft); color: var(--success); }
.run-status.failed, .run-status.needs_human { background: var(--warning-soft); color: var(--warning); }
.run-status.cancelled { background: var(--muted-soft); color: var(--muted); }
.deterministic-detail { border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); overflow: hidden; }
.deterministic-detail .panel-header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--text-secondary); }
.deterministic-detail .panel-body { padding: 14px; }
.deterministic-detail .status { margin-left: auto; padding: 2px 7px; border-radius: 999px; background: var(--primary-soft); color: var(--primary); font-size: 10px; }
.deterministic-detail .status.succeeded { background: var(--success-soft); color: var(--success); }
.deterministic-detail .status.failed, .deterministic-detail .status.attention_required { background: var(--warning-soft); color: var(--warning); }
.deterministic-detail .status.cancelled { background: var(--muted-soft); color: var(--muted); }
.detail-grid { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 6px 10px; margin: 14px 0 0; }
.detail-grid dt { color: var(--text-dim); }
.detail-grid dd { margin: 0; overflow-wrap: anywhere; }
.detail-note { margin: 14px 0 0; color: var(--text-secondary); font-size: 12px; }
</style>
