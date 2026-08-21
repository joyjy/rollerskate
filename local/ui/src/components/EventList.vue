<script setup lang="ts">
import { computed, ref } from "vue";
import type { RuntimeAuditOutput } from "@/api/schema";
import EventListItem from "@/components/EventListItem.vue";
import { deriveLifecycle, type EventLifecycle } from "@/utils/events";

const props = defineProps<{
  audits: readonly RuntimeAuditOutput[];
  selectedId: string;
  loading: boolean;
  error: string | null;
  runtimePaused: boolean;
  runtimeStale: boolean;
}>();
const emit = defineEmits<{
  select: [id: string];
  refresh: [];
}>();
const query = ref("");
const filterType = ref<"all" | RuntimeAuditOutput["event"]["type"]>("all");
const filterSource = ref<"all" | "cli" | "subscription" | "schedule" | "matrix" | "server" | "handler">("all");
const filterLifecycle = ref<"all" | EventLifecycle>("all");
const filterAgent = ref("all");
const filterTimeStart = ref("");
const filterTimeEnd = ref("");
const page = ref(1);
const pageSize = 5;

const agents = computed(() => [...new Set(props.audits.flatMap((audit) =>
  audit.event.agentId === undefined ? [] : [audit.event.agentId]
))].sort());
const filtered = computed(() => props.audits.filter((audit) => {
  const event = audit.event;
  const created = new Date(event.createdAt).getTime();
  return (query.value === "" || event.eventId.includes(query.value) || (event.source.externalId ?? "").includes(query.value))
    && (filterType.value === "all" || event.type === filterType.value)
    && (filterSource.value === "all" || event.source.kind === filterSource.value)
    && (filterLifecycle.value === "all" || deriveLifecycle(audit) === filterLifecycle.value)
    && (filterAgent.value === "all" || event.agentId === filterAgent.value)
    && (filterTimeStart.value === "" || created >= new Date(filterTimeStart.value).getTime())
    && (filterTimeEnd.value === "" || created <= new Date(filterTimeEnd.value).getTime());
}));
const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)));
const pageItems = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize));
function applyFilters() { page.value = 1; }
</script>

<template>
  <aside class="panel event-list">
    <div class="panel-header">Events</div>
    <div class="list-toolbar">
      <input v-model="query" type="search" placeholder="Event ID or external ID" class="search-input" @input="applyFilters" />
      <select v-model="filterType" class="filter-select" @change="applyFilters">
        <option value="all">All types</option>
        <option v-for="type in ['agent.request', 'subscription.fire', 'agent.result', 'chat.message', 'chat.dispatch']" :key="type" :value="type">{{ type }}</option>
      </select>
      <select v-model="filterSource" class="filter-select" @change="applyFilters">
        <option value="all">All sources</option>
        <option v-for="source in ['cli', 'subscription', 'schedule', 'matrix', 'server', 'handler']" :key="source" :value="source">{{ source }}</option>
      </select>
      <select v-model="filterLifecycle" class="filter-select" @change="applyFilters">
        <option value="all">All states</option>
        <option v-for="state in ['queued', 'running', 'retrying', 'succeeded', 'failed', 'delivery_pending', 'delivered', 'delivery_failed']" :key="state" :value="state">{{ state }}</option>
      </select>
      <select v-model="filterAgent" class="filter-select" @change="applyFilters">
        <option value="all">All agents</option>
        <option v-for="agent in agents" :key="agent" :value="agent">{{ agent }}</option>
      </select>
      <div class="time-range">
        <input v-model="filterTimeStart" type="datetime-local" class="filter-select" @change="applyFilters" />
        <span>to</span>
        <input v-model="filterTimeEnd" type="datetime-local" class="filter-select" @change="applyFilters" />
      </div>
    </div>
    <div v-if="runtimeStale" class="list-banner stale">Data is stale; last refresh exceeded freshness window.</div>
    <div v-if="runtimePaused" class="list-banner paused">Runtime paused. Existing Events remain readable, but no new work will be claimed.</div>
    <div v-if="loading" class="state">Loading durable Events…</div>
    <div v-else-if="error" class="state error" role="alert">
      API unreachable: {{ error }}
      <button type="button" class="refresh-button" @click="emit('refresh')">Retry</button>
    </div>
    <div v-else-if="audits.length === 0" class="state">No Events registered yet. Available ingress: cli, matrix, subscription.fire.</div>
    <div v-else-if="filtered.length === 0" class="state">No Events match the current filters.</div>
    <EventListItem
      v-for="audit in pageItems"
      v-else
      :key="audit.event.eventId"
      :audit="audit"
      :selected="selectedId === audit.event.eventId"
      @select="emit('select', $event)"
    />
    <div v-if="filtered.length > 0" class="pagination">
      <button type="button" :disabled="page <= 1" @click="page--">Prev</button>
      <span>{{ page }} / {{ totalPages }}</span>
      <button type="button" :disabled="page >= totalPages" @click="page++">Next</button>
    </div>
  </aside>
</template>

<style scoped>
.event-list { max-height: calc(100vh - 170px); overflow-y: auto; }
.list-toolbar { padding: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
.search-input, .filter-select { appearance: none; border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; font-size: 13px; background: var(--surface); color: var(--text); }
.search-input:focus, .filter-select:focus { outline: 2px solid var(--primary-soft); border-color: var(--primary); }
.time-range { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.time-range input { flex: 1 1 auto; min-width: 0; }
.time-range span { color: var(--text-secondary); font-size: 12px; }
.refresh-button { appearance: none; border: 1px solid var(--primary); background: var(--primary); color: #fff; border-radius: 4px; padding: 3px 10px; font-size: 12px; cursor: pointer; margin-left: 8px; }
.pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 12px; border-top: 1px solid var(--border); font-size: 13px; }
.pagination button { appearance: none; border: 1px solid var(--border); background: var(--surface); color: var(--text); padding: 5px 12px; border-radius: 6px; cursor: pointer; }
.pagination button:disabled { opacity: .5; cursor: not-allowed; }
.error { color: var(--danger); }
@media (max-width: 1100px) { .event-list { max-height: 360px; } }
@media (max-width: 375px) { .time-range { flex-direction: column; align-items: stretch; } .time-range input { width: 100%; } }
</style>
