<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import { requestJson } from "@/api/client";
import {
  agentRunDetailViewSchema,
  agentRunSummariesSchema,
  cancelAgentRunReceiptSchema,
  setAgentRunArchivedReceiptSchema
} from "@/api/schema";
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
  schema: agentRunDetailViewSchema,
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
const loading = computed(() =>
  runsQuery.loading.value ||
  (selectedId.value !== "" && detailQuery.loading.value));
const error = computed(() =>
  archiveMutation.error.value ??
  cancelMutation.error.value ??
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

async function cancelRun(runId: string) {
  mutationPaused.value = true;
  try {
    await cancelMutation.execute(runId);
  } finally {
    mutationPaused.value = false;
  }
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
          :run="detail"
          :cycle-id="routeCycleId"
          :output-id="routeOutputId"
          :cancelling="cancelMutation.pending.value"
          :archiving="archiveMutation.pending.value"
          @cancel="cancelRun"
          @archive="archiveRun"
        />
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
</style>
