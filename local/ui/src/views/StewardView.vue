<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { requestJson } from "@/api/client";
import {
  agentRunDetailViewSchema,
  agentRunSummariesSchema,
  cancelAgentRunReceiptSchema
} from "@/api/schema";
import AgentRunOverview from "@/components/AgentRunOverview.vue";
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
const searchQuery = ref("");
const currentPage = ref(1);
const PAGE_SIZE = 10;

const runsQuery = useApi({
  url: "/api/runs",
  schema: agentRunSummariesSchema,
  interval: 5_000,
  paused: mutationPaused
});
const detailUrl = computed(() =>
  `/api/runs/${encodeURIComponent(selectedId.value)}`);
const detailQuery = useApi({
  url: detailUrl,
  schema: agentRunDetailViewSchema,
  interval: 5_000,
  paused: computed(() => mutationPaused.value || selectedId.value === ""),
  immediate: false
});

const runs = computed(() => {
  const list = runsQuery.data.value ?? [];
  return [...list].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt));
});
const filteredRuns = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (query === "") return runs.value;
  return runs.value.filter((run) => [
    run.mandate.label,
    run.runId,
    run.steward.handle,
    run.status
  ].some((value) => value.toLowerCase().includes(query)));
});
const pageCount = computed(() =>
  Math.max(1, Math.ceil(filteredRuns.value.length / PAGE_SIZE)));
const visibleRuns = computed(() => {
  const start = (currentPage.value - 1) * PAGE_SIZE;
  return filteredRuns.value.slice(start, start + PAGE_SIZE);
});
const pageSlots = computed<Array<number | null>>(() => {
  const total = pageCount.value;
  if (filteredRuns.value.length === 0) return [null, null, null];
  if (total <= 3) {
    return [...Array.from({ length: total }, (_, index) => index + 1),
      ...Array.from({ length: 3 - total }, () => null)];
  }
  if (currentPage.value <= 2) return [1, 2, total];
  if (currentPage.value >= total - 1) return [1, total - 1, total];
  return [1, currentPage.value, total];
});
const detail = detailQuery.data;
const loading = computed(() =>
  runsQuery.loading.value ||
  (selectedId.value !== "" && detailQuery.loading.value));
const error = computed(() =>
  cancelMutation.error.value ??
  detailQuery.error.value ??
  runsQuery.error.value);

watch(runs, (next) => {
  if (selectedId.value === "" && next.length > 0) {
    selectedId.value = next[0]!.runId;
  }
}, { immediate: true });

watch([runs, routeRunId], ([nextRuns, nextRunId]) => {
  if (nextRunId === "" || searchQuery.value.trim() !== "") return;
  const selectedIndex = nextRuns.findIndex((run) => run.runId === nextRunId);
  if (selectedIndex >= 0) {
    currentPage.value = Math.floor(selectedIndex / PAGE_SIZE) + 1;
  }
}, { immediate: true });

watch(searchQuery, () => {
  currentPage.value = 1;
});

watch([() => filteredRuns.value.length, pageCount], () => {
  currentPage.value = Math.min(currentPage.value, pageCount.value);
});

watch(routeRunId, (next) => {
  if (next !== selectedId.value) selectedId.value = next;
});

watch(selectedId, (next) => {
  if (next === "") return;
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
  async execute(runId: string, signal: AbortSignal) {
    return requestJson(
      `/api/runs/${encodeURIComponent(runId)}/cancel`,
      cancelAgentRunReceiptSchema,
      {
        method: "POST",
        headers: { "X-Rollerskate-Request": "console" },
        signal
      }
    );
  },
  async refresh() {
    await Promise.all([runsQuery.refresh(), detailQuery.refresh()]);
  }
});

async function cancelRun(runId: string) {
  mutationPaused.value = true;
  try {
    await cancelMutation.execute(runId);
  } finally {
    mutationPaused.value = false;
  }
}

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
      <div class="panel-header list-header">
        <span>Steward</span>
        <span class="dim">{{ filteredRuns.length }} Runs</span>
        <input
          v-model="searchQuery"
          class="search-input"
          type="search"
          aria-label="Search Steward Runs"
          placeholder="Search runs…"
        />
      </div>
      <div v-if="runsQuery.loading.value && runs.length === 0" class="state">
        Loading Steward Runs…
      </div>
      <div v-else-if="runs.length === 0" class="state list-state">
        No Steward Run has been created.
      </div>
      <div v-else class="list-body">
        <div class="operation-rows">
          <div v-if="filteredRuns.length === 0" class="state no-matches">
            No matches.
          </div>
        <button
          v-for="run in visibleRuns"
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
        </button>
        </div>
        <nav class="pagination" aria-label="Steward Runs pagination">
          <span class="pagination-info">
            {{ filteredRuns.length === 0 ? "0 results" : `Page ${currentPage}/${pageCount}` }}
          </span>
          <span class="pagination-spacer" />
          <button
            type="button"
            class="page-button direction-button"
            :disabled="currentPage === 1 || filteredRuns.length === 0"
            aria-label="Previous page"
            @click="goToPage(currentPage - 1)"
          >Prev</button>
          <template v-for="(page, index) in pageSlots" :key="`${index}-${page ?? 'empty'}`">
            <button
              v-if="page !== null"
              type="button"
              class="page-button page-number"
              :class="{ active: page === currentPage }"
              :aria-current="page === currentPage ? 'page' : undefined"
              :aria-label="`Page ${page}`"
              @click="goToPage(page)"
            >{{ page }}</button>
            <span v-else class="page-placeholder" aria-hidden="true" />
          </template>
          <button
            type="button"
            class="page-button direction-button"
            :disabled="currentPage === pageCount || filteredRuns.length === 0"
            aria-label="Next page"
            @click="goToPage(currentPage + 1)"
          >Next</button>
        </nav>
      </div>
    </aside>

    <main class="panel operations-detail">
      <div v-if="loading && !detail" class="state">Loading Steward Run…</div>
      <div v-else-if="error && !detail" class="state error" role="alert">{{ error }}</div>
      <template v-else-if="detail">
        <div v-if="error" class="state error" role="alert">{{ error }}</div>
        <AgentRunOverview
          :run="detail"
          :cycle-id="routeCycleId"
          :output-id="routeOutputId"
          :cancelling="cancelMutation.pending.value"
          @cancel="cancelRun"
        />
      </template>
      <div v-else class="state">Select a Steward Run.</div>
    </main>
  </div>
</template>

<style scoped>
.operations-view { display: grid; grid-template-columns: minmax(260px, 0.8fr) minmax(0, 2fr); gap: 12px; min-width: 0; height: 952px; min-height: 600px; }
.operations-list, .operations-detail { min-width: 0; display: flex; flex-direction: column; }
.operations-list { height: 100%; }
.list-header { display: flex; align-items: center; gap: 8px; min-height: 61px; }
.list-header .dim { white-space: nowrap; }
.search-input { min-width: 0; width: 100%; margin-left: auto; padding: 7px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: inherit; font: inherit; text-transform: none; letter-spacing: normal; }
.search-input:focus { outline: 2px solid var(--primary-soft); border-color: var(--primary); }
.list-body { min-height: 0; flex: 1 1 0; display: flex; flex-direction: column; }
.list-state { flex: 1 1 0; }
.operation-rows { min-height: 0; flex: 1 1 0; display: grid; grid-template-rows: repeat(10, minmax(0, 1fr)); gap: 6px; padding: 8px; overflow: auto; }
.no-matches { grid-row: 1 / -1; align-self: center; justify-self: center; }
.operation-row { min-height: 0; display: flex; flex-direction: column; gap: 5px; width: 100%; padding: 10px; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: inherit; text-align: left; cursor: pointer; }
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
.pagination { flex: 0 0 44px; min-width: 0; display: flex; align-items: center; gap: 4px; padding: 0 8px; border-top: 1px solid var(--border); background: var(--surface); }
.pagination-info { flex: 0 0 58px; overflow: hidden; color: var(--text-secondary); font-size: 11px; white-space: nowrap; }
.pagination-spacer { flex: 1 1 auto; min-width: 0; }
.page-button { flex: 0 0 auto; height: 28px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: inherit; cursor: pointer; font-size: 11px; font-weight: 600; }
.direction-button { width: 40px; padding: 0; }
.page-number, .page-placeholder { width: 28px; }
.page-placeholder { flex: 0 0 28px; height: 28px; }
.page-button:hover:not(:disabled), .page-button.active { border-color: var(--primary); color: var(--primary); }
.page-button.active { background: var(--primary); color: white; }
.page-button:disabled { cursor: not-allowed; opacity: .45; }
.operations-detail { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
@media (max-width: 900px) {
  .operations-view { grid-template-columns: minmax(0, 1fr); height: auto; }
  .operations-list { height: 952px; }
}
@media (max-width: 420px) {
  .pagination-info { display: none; }
}
</style>
