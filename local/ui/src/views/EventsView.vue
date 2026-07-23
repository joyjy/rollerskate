<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { RuntimeAudit, RuntimeInfo } from "@/types/runtime";

type Lifecycle = "queued" | "running" | "retrying" | "succeeded" | "failed" | "delivery_pending" | "delivered" | "delivery_failed";

const audits = ref<RuntimeAudit[]>([]);
const selectedEventId = ref("");
const query = ref("");
const filterType = ref<"all" | "agent.request" | "subscription.fire" | "agent.result">("all");
const filterSource = ref<"all" | "cli" | "subscription" | "matrix" | "server" | "handler">("all");
const filterLifecycle = ref<"all" | Lifecycle>("all");
const filterAgent = ref<"all" | string>("all");
const filterTimeStart = ref("");
const filterTimeEnd = ref("");

const page = ref(1);
const pageSize = 5;
const hasNewEvents = ref(false);
const apiError = ref<string | null>(null);
const loading = ref(true);
const runtime = ref<RuntimeInfo | null>(null);

const runtimePaused = computed(() => runtime.value?.status === "paused");
const runtimeStale = computed(() => runtime.value?.stale ?? false);

const agents = computed(() => [...new Set(audits.value.map((a) => a.event.agentId))].sort());

const formatTime = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";

function deriveLifecycle(audit: RuntimeAudit): Lifecycle {
  const execution = audit.execution;
  if (!execution || execution.status === "queued") return "queued";
  if (execution.status === "running") return "running";
  if (execution.status === "retry_wait") return "retrying";
  if (execution.status === "failed") return "failed";
  if (!audit.resultEvent) return "running";
  if (audit.resultEvent.outcome === "failed") return "failed";
  if (audit.deliveries.length === 0) return "succeeded";
  const deliveries = audit.deliveries.map((d) => d.delivery.status);
  if (deliveries.some((s) => s === "failed")) return "delivery_failed";
  if (deliveries.every((s) => s === "delivered")) return "delivered";
  return "delivery_pending";
}

function lifecycleLabel(lifecycle: Lifecycle): string {
  const labels: Record<Lifecycle, string> = {
    queued: "Queued",
    running: "Running",
    retrying: "Retrying",
    succeeded: "Succeeded",
    failed: "Failed",
    delivery_pending: "Delivery Pending",
    delivered: "Delivered",
    delivery_failed: "Delivery Failed"
  };
  return labels[lifecycle];
}

function lifecycleClass(lifecycle: Lifecycle): string {
  const map: Record<Lifecycle, string> = {
    queued: "muted",
    running: "info",
    retrying: "warning",
    succeeded: "success",
    failed: "danger",
    delivery_pending: "warning",
    delivered: "success",
    delivery_failed: "danger"
  };
  return map[lifecycle];
}

function chainNodeClass(status?: string): string {
  if (!status) return "pending";
  if (["succeeded", "delivered"].includes(status)) return "success";
  if (["failed", "delivery_failed"].includes(status)) return "danger";
  if (["running", "retry_wait"].includes(status)) return "info";
  if (status === "queued") return "muted";
  return "pending";
}

const filteredAudits = computed(() => {
  return audits.value.filter((audit) => {
    const event = audit.event;
    const matchesQuery = query.value === "" || event.eventId.includes(query.value) || (event.source.externalId ?? "").includes(query.value);
    const matchesType = filterType.value === "all" || event.type === filterType.value;
    const matchesSource = filterSource.value === "all" || event.source.kind === filterSource.value;
    const lifecycle = deriveLifecycle(audit);
    const matchesLifecycle = filterLifecycle.value === "all" || lifecycle === filterLifecycle.value;
    const matchesAgent = filterAgent.value === "all" || event.agentId === filterAgent.value;
    const created = new Date(event.createdAt).getTime();
    const matchesStart = filterTimeStart.value === "" || created >= new Date(filterTimeStart.value).getTime();
    const matchesEnd = filterTimeEnd.value === "" || created <= new Date(filterTimeEnd.value).getTime();
    return matchesQuery && matchesType && matchesSource && matchesLifecycle && matchesAgent && matchesStart && matchesEnd;
  });
});

const pagedAudits = computed(() => {
  const start = (page.value - 1) * pageSize;
  return filteredAudits.value.slice(start, start + pageSize);
});

const totalPages = computed(() => Math.max(1, Math.ceil(filteredAudits.value.length / pageSize)));

const selected = computed(() => filteredAudits.value.find((audit) =>
  audit.event.eventId === selectedEventId.value) ?? pagedAudits.value[0]);

function selectEvent(id: string) {
  selectedEventId.value = id;
}

function applyFilters() {
  page.value = 1;
}

async function load() {
  loading.value = true;
  apiError.value = null;
  try {
    const [eventsResponse, runtimeResponse] = await Promise.all([
      fetch("/api/runtime/events", { headers: { Accept: "application/json" } }),
      fetch("/api/runtime", { headers: { Accept: "application/json" } })
    ]);
    if (!eventsResponse.ok) throw new Error(`Events HTTP ${eventsResponse.status}`);
    if (!runtimeResponse.ok) throw new Error(`Runtime HTTP ${runtimeResponse.status}`);
    audits.value = await eventsResponse.json() as RuntimeAudit[];
    runtime.value = await runtimeResponse.json() as RuntimeInfo;
    const current = audits.value.find((audit) =>
      audit.event.eventId === selectedEventId.value) ?? audits.value[0];
    selectedEventId.value = current?.event.eventId ?? "";
  } catch (reason) {
    apiError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    loading.value = false;
  }
}

function dismissNewEvents() {
  hasNewEvents.value = false;
  void load();
}

onMounted(load);
</script>

<template>
  <div class="events-layout">
    <aside class="panel event-list">
      <div class="panel-header">Events</div>
      <div class="list-toolbar">
        <input v-model="query" type="search" placeholder="Event ID or external ID" class="search-input" @input="applyFilters" />
        <select v-model="filterType" class="filter-select" @change="applyFilters">
          <option value="all">All types</option>
          <option value="agent.request">agent.request</option>
          <option value="subscription.fire">subscription.fire</option>
          <option value="agent.result">agent.result</option>
        </select>
        <select v-model="filterSource" class="filter-select" @change="applyFilters">
          <option value="all">All sources</option>
          <option value="cli">cli</option>
          <option value="subscription">subscription</option>
          <option value="matrix">matrix</option>
          <option value="server">server</option>
          <option value="handler">handler</option>
        </select>
        <select v-model="filterLifecycle" class="filter-select" @change="applyFilters">
          <option value="all">All states</option>
          <option value="queued">Queued</option>
          <option value="running">Running</option>
          <option value="retrying">Retrying</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="delivery_pending">Delivery Pending</option>
          <option value="delivered">Delivered</option>
          <option value="delivery_failed">Delivery Failed</option>
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
      <div v-if="hasNewEvents" class="list-banner new-events">
        New Events arrived
        <button class="refresh-button" @click="dismissNewEvents">Refresh</button>
      </div>

      <div v-if="loading" class="state">Loading durable Events…</div>
      <div v-else-if="apiError" class="state error" role="alert">API unreachable: {{ apiError }}</div>
      <div v-else-if="audits.length === 0" class="state">No Events registered yet. Available ingress: cli, matrix, subscription.fire.</div>
      <div v-else-if="filteredAudits.length === 0" class="state">No Events match the current filters.</div>
      <template v-else>
        <button
          v-for="audit in pagedAudits"
          :key="audit.event.eventId"
          class="event-row"
          :class="{ active: selected?.event.eventId === audit.event.eventId }"
          type="button"
          @click="selectEvent(audit.event.eventId)"
        >
          <span class="event-row-top">
            <span class="event-kind">{{ audit.event.type }}</span>
            <span class="lifecycle-badge" :class="lifecycleClass(deriveLifecycle(audit))">{{ lifecycleLabel(deriveLifecycle(audit)) }}</span>
          </span>
          <span class="mono event-id">{{ audit.event.eventId }}</span>
          <span class="event-meta">{{ audit.event.source.kind }}<span v-if="audit.event.source.externalId"> · {{ audit.event.source.externalId }}</span> · {{ formatTime(audit.event.createdAt) }}</span>
          <span class="event-summary">
            <span>Agent <span class="mono">{{ audit.event.agentId }}</span></span>
            <span>Session {{ audit.session ? "yes" : "no" }}</span>
            <span>Destinations {{ audit.event.destinationIds.length }}</span>
          </span>
          <span v-if="audit.event.boundedPromptSummary" class="event-prompt">{{ audit.event.boundedPromptSummary }}</span>
          <span class="event-lifecycle-change">changed {{ formatTime(audit.lifecycleChangedAt) }}</span>
          <span v-if="audit.reasonForIntervention" class="event-reason">{{ audit.reasonForIntervention }}</span>
        </button>
      </template>

      <div v-if="filteredAudits.length > 0" class="pagination">
        <button :disabled="page <= 1" @click="page--">Prev</button>
        <span>{{ page }} / {{ totalPages }}</span>
        <button :disabled="page >= totalPages" @click="page++">Next</button>
      </div>
    </aside>

    <section v-if="!selected" class="panel audit-detail">
      <div class="panel-header">Event audit</div>
      <div class="state">Select an Event to inspect its durable audit chain.</div>
    </section>
    <section v-else class="panel audit-detail">
      <div class="panel-header">Event audit · {{ selected.event.eventId }}</div>
      <div class="detail-body">
        <div class="chain-overview">
          <div class="chain-node" :class="chainNodeClass('succeeded')">
            <div class="chain-label">Event</div>
            <div class="chain-id mono">{{ selected.event.eventId }}</div>
            <div class="chain-status">{{ selected.event.type }}</div>
          </div>
          <template v-if="selected.event.type !== 'agent.result'">
            <div class="chain-arrow">→</div>
            <div class="chain-node" :class="chainNodeClass(selected.execution.status)">
              <div class="chain-label">AgentHandler</div>
              <div class="chain-id mono">{{ selected.execution.executionId }}</div>
              <div class="chain-status">{{ selected.execution.status }}</div>
            </div>
            <div class="chain-arrow">→</div>
            <div class="chain-node" :class="chainNodeClass(selected.resultEvent?.outcome)">
              <div class="chain-label">agent.result</div>
              <div class="chain-id mono">{{ selected.resultEvent?.eventId ?? "—" }}</div>
              <div class="chain-status">{{ selected.resultEvent?.outcome ?? "pending" }}</div>
            </div>
            <div class="chain-arrow">→</div>
            <div class="chain-node" :class="chainNodeClass(selected.resultExecution?.status)">
              <div class="chain-label">ResultHandler</div>
              <div class="chain-id mono">{{ selected.resultExecution?.executionId ?? "—" }}</div>
              <div class="chain-status">{{ selected.resultExecution?.status ?? "pending" }}</div>
            </div>
            <div class="chain-arrow">→</div>
            <div class="chain-node" :class="chainNodeClass(selected.deliveries.length === 0 ? (selected.resultEvent ? 'succeeded' : 'pending') : deriveLifecycle(selected) === 'delivered' ? 'delivered' : deriveLifecycle(selected) === 'delivery_failed' ? 'delivery_failed' : 'running')">
              <div class="chain-label">Delivery</div>
              <div class="chain-id mono">{{ selected.deliveries.length ? selected.deliveries[0].delivery.deliveryId : "—" }}</div>
              <div class="chain-status">{{ selected.deliveries.length === 0 ? (selected.resultEvent ? "none" : "pending") : deriveLifecycle(selected) }}</div>
            </div>
          </template>
          <template v-else>
            <div class="chain-arrow">→</div>
            <div class="chain-node" :class="chainNodeClass(selected.execution.status)">
              <div class="chain-label">ResultHandler</div>
              <div class="chain-id mono">{{ selected.execution.executionId }}</div>
              <div class="chain-status">{{ selected.execution.status }}</div>
            </div>
            <div class="chain-arrow">→</div>
            <div class="chain-node" :class="chainNodeClass(selected.deliveries.length === 0 ? 'succeeded' : deriveLifecycle(selected) === 'delivered' ? 'delivered' : deriveLifecycle(selected) === 'delivery_failed' ? 'delivery_failed' : 'running')">
              <div class="chain-label">Delivery</div>
              <div class="chain-id mono">{{ selected.deliveries.length ? selected.deliveries[0].delivery.deliveryId : "—" }}</div>
              <div class="chain-status">{{ selected.deliveries.length === 0 ? "none" : deriveLifecycle(selected) }}</div>
            </div>
          </template>
        </div>

        <div class="section-title">Route</div>
        <dl class="kv">
          <dt>Event type</dt><dd class="mono">{{ selected.event.type }}</dd>
          <dt>Handler</dt><dd class="mono">{{ selected.execution.handler }}</dd>
          <dt>Fanout</dt><dd>disabled · exactly one Handler</dd>
        </dl>

        <div class="section-title">Canonical Event</div>
        <dl class="kv">
          <dt>ID</dt><dd class="mono">{{ selected.event.eventId }}</dd>
          <dt>Source</dt><dd>{{ selected.event.source.kind }}<span v-if="selected.event.source.externalId" class="mono"> · {{ selected.event.source.externalId }}</span></dd>
          <dt>Agent</dt><dd class="mono">{{ selected.event.agentId }}</dd>
          <dt>Session</dt><dd class="mono">{{ selected.event.sessionId ?? "new" }}</dd>
          <dt>Destinations</dt><dd>{{ selected.event.destinationIds.length }}</dd>
          <dt>Created</dt><dd>{{ formatTime(selected.event.createdAt) }}</dd>
          <dt v-if="selected.event.prompt">Prompt</dt><dd v-if="selected.event.prompt" class="bounded-text">{{ selected.event.prompt }}</dd>
        </dl>

        <div class="section-title">Causality</div>
        <dl class="kv">
          <dt>Root</dt><dd class="mono">{{ selected.event.causality.rootEventId }}</dd>
          <dt>Parent</dt><dd class="mono">{{ selected.event.causality.parentEventId ?? "none" }}</dd>
          <dt>Hop</dt><dd>{{ selected.event.causality.hop }}</dd>
          <dt>Direct children</dt>
          <dd>
            <span v-if="selected.directChildren.length === 0">none</span>
            <span v-for="child in selected.directChildren" :key="child.eventId" class="mono child-tag">{{ child.eventId }} ({{ child.status }})</span>
          </dd>
          <dt>Boundary</dt><dd>{{ selected.causalityBoundary ?? "complete" }}</dd>
        </dl>

        <div class="section-title">{{ selected.execution.handler === "agent" ? "AgentHandler" : "ResultHandler" }} Execution</div>
        <dl class="kv">
          <dt>ID</dt><dd class="mono">{{ selected.execution.executionId }}</dd>
          <dt>Status</dt><dd>{{ selected.execution.status }}</dd>
          <dt>Attempts</dt><dd>{{ selected.execution.attemptCount }}/{{ selected.execution.maxAttempts }}</dd>
          <dt>First started</dt><dd>{{ formatTime(selected.execution.firstStartedAt) }}</dd>
          <dt>Last attempt</dt><dd>{{ formatTime(selected.execution.lastAttemptAt) }}</dd>
          <dt>Completed</dt><dd>{{ formatTime(selected.execution.completedAt) }}</dd>
          <dt>Next retry</dt><dd>{{ formatTime(selected.execution.nextAttemptAt) }}</dd>
          <dt v-if="selected.execution.lastError">Error</dt><dd v-if="selected.execution.lastError" class="error">{{ selected.execution.lastError }}</dd>
        </dl>

        <template v-if="selected.resultEvent && selected.event.type !== 'agent.result'">
          <div class="section-title">Result Event</div>
          <dl class="kv">
            <dt>ID</dt><dd class="mono">{{ selected.resultEvent.eventId }}</dd>
            <dt>Outcome</dt><dd>{{ selected.resultEvent.outcome }}</dd>
            <dt>Created</dt><dd>{{ formatTime(selected.resultEvent.createdAt) }}</dd>
            <dt>Root</dt><dd class="mono">{{ selected.resultEvent.causality.rootEventId }}</dd>
            <dt>Parent</dt><dd class="mono">{{ selected.resultEvent.causality.parentEventId ?? "none" }}</dd>
            <dt>Output</dt><dd class="bounded-text">{{ selected.resultEvent.output ?? selected.resultEvent.error ?? "—" }}</dd>
          </dl>
        </template>

        <template v-if="selected.resultExecution">
          <div class="section-title">ResultHandler Execution</div>
          <dl class="kv">
            <dt>ID</dt><dd class="mono">{{ selected.resultExecution.executionId }}</dd>
            <dt>Status</dt><dd>{{ selected.resultExecution.status }}</dd>
            <dt>Attempts</dt><dd>{{ selected.resultExecution.attemptCount }}/{{ selected.resultExecution.maxAttempts }}</dd>
            <dt>First started</dt><dd>{{ formatTime(selected.resultExecution.firstStartedAt) }}</dd>
            <dt>Last attempt</dt><dd>{{ formatTime(selected.resultExecution.lastAttemptAt) }}</dd>
            <dt>Completed</dt><dd>{{ formatTime(selected.resultExecution.completedAt) }}</dd>
            <dt>Next retry</dt><dd>{{ formatTime(selected.resultExecution.nextAttemptAt) }}</dd>
            <dt v-if="selected.resultExecution.lastError">Error</dt><dd v-if="selected.resultExecution.lastError" class="error">{{ selected.resultExecution.lastError }}</dd>
          </dl>
        </template>

        <template v-if="selected.session">
          <div class="section-title">Session</div>
          <dl class="kv">
            <dt>ID</dt><dd class="mono">{{ selected.session.sessionId }}</dd>
            <dt>Mode</dt><dd>{{ selected.session.resumedAt ? "resumed" : "created" }}</dd>
            <template v-if="selected.session.resumedAt">
              <dt>Resumed at</dt><dd>{{ formatTime(selected.session.resumedAt) }}</dd>
            </template>
            <template v-else>
              <dt>Created at</dt><dd>{{ formatTime(selected.session.createdAt) }}</dd>
            </template>
            <dt>Agent</dt><dd class="mono">{{ selected.session.agentId }}</dd>
            <dt>Adapter</dt><dd class="mono">{{ selected.session.adapterId }}</dd>
            <dt>Provider</dt><dd class="mono secret">{{ selected.session.providerSessionId }}</dd>
            <dt>Workspace</dt><dd class="mono secret">{{ selected.session.workspace }}</dd>
          </dl>
        </template>
        <div v-else-if="!selected.session && selected.event.sessionId" class="missing-object">Session referenced by Event is missing from audit chain.</div>

        <div class="section-title">Deliveries</div>
        <div v-if="selected.deliveries.length === 0" class="empty-inline">无需外部投递 · No outbound Delivery.</div>
        <dl v-for="item in selected.deliveries" v-else :key="item.delivery.deliveryId" class="kv delivery">
          <dt>ID</dt><dd class="mono">{{ item.delivery.deliveryId }}</dd>
          <dt>Source</dt><dd>{{ item.delivery.source }}</dd>
          <dt>Destination</dt><dd class="mono">{{ item.destination.kind }} · {{ item.destination.destinationId }}</dd>
          <dt>Status</dt><dd>{{ item.delivery.status }}</dd>
          <dt>Attempts</dt><dd>{{ item.delivery.attemptCount }}</dd>
          <dt>Created</dt><dd>{{ formatTime(item.delivery.createdAt) }}</dd>
          <dt>Attempted</dt><dd>{{ formatTime(item.delivery.attemptedAt) }}</dd>
          <dt>Delivered</dt><dd>{{ formatTime(item.delivery.deliveredAt) }}</dd>
          <dt>Receipt</dt><dd class="mono">{{ item.delivery.receipt ?? "—" }}</dd>
          <dt v-if="item.delivery.boundedError">Error</dt><dd v-if="item.delivery.boundedError" class="error">{{ item.delivery.boundedError }}</dd>
        </dl>
      </div>
    </section>
  </div>
</template>

<style scoped>
.events-layout { max-width: 1500px; margin: 0 auto; display: grid; grid-template-columns: minmax(360px, 0.95fr) minmax(520px, 1.55fr); gap: 18px; align-items: start; }
.event-list { max-height: calc(100vh - 170px); overflow-y: auto; }
.list-toolbar { padding: 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
.search-input, .filter-select { appearance: none; border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; font-size: 13px; background: var(--surface); color: var(--text); }
.search-input:focus, .filter-select:focus { outline: 2px solid var(--primary-soft); border-color: var(--primary); }
.time-range { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.time-range input { flex: 1 1 auto; min-width: 0; }
.time-range span { color: var(--text-secondary); font-size: 12px; }
.list-banner { padding: 8px 12px; font-size: 12px; border-bottom: 1px solid var(--border); }
.list-banner.stale { background: var(--warning-soft); color: var(--warning); }
.list-banner.paused { background: var(--muted-soft); color: var(--muted); }
.list-banner.new-events { background: var(--primary-soft); color: var(--primary); display: flex; justify-content: space-between; align-items: center; }
.refresh-button { appearance: none; border: 1px solid var(--primary); background: var(--primary); color: #fff; border-radius: 4px; padding: 3px 10px; font-size: 12px; cursor: pointer; }
.event-row { width: 100%; display: flex; flex-direction: column; gap: 4px; padding: 13px 16px; border: 0; border-bottom: 1px solid var(--border); background: var(--surface); color: var(--text); text-align: left; cursor: pointer; }
.event-row:hover { background: var(--surface-2); }
.event-row:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.event-row.active { background: var(--primary-soft); box-shadow: inset 3px 0 var(--primary); }
.event-row-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.event-kind { font-weight: 700; }
.event-id { font-size: 12px; color: var(--text-secondary); word-break: break-all; }
.event-meta { color: var(--text-secondary); font-size: 12px; }
.event-summary { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary); }
.event-prompt { color: var(--text-secondary); font-size: 12px; font-style: italic; word-break: break-word; }
.event-lifecycle-change { font-size: 11px; color: var(--text-dim); }
.event-reason { font-size: 12px; color: var(--danger); }
.lifecycle-badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; white-space: nowrap; }
.lifecycle-badge.muted { background: var(--muted-soft); color: var(--muted); }
.lifecycle-badge.info { background: var(--primary-soft); color: var(--primary); }
.lifecycle-badge.warning { background: var(--warning-soft); color: var(--warning); }
.lifecycle-badge.success { background: var(--success-soft); color: var(--success); }
.lifecycle-badge.danger { background: var(--danger-soft); color: var(--danger); }
.pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 12px; border-top: 1px solid var(--border); font-size: 13px; }
.pagination button { appearance: none; border: 1px solid var(--border); background: var(--surface); color: var(--text); padding: 5px 12px; border-radius: 6px; cursor: pointer; }
.pagination button:disabled { opacity: 0.5; cursor: not-allowed; }
.audit-detail { min-height: 420px; }
.detail-body { padding: 20px; }
.state { padding: 28px 18px; color: var(--text-secondary); text-align: center; }
.error { color: var(--danger); }
.empty-inline { padding: 12px; border: 1px dashed var(--border); border-radius: 8px; color: var(--text-secondary); }
.delivery { padding: 12px; border: 1px solid var(--border); border-radius: 8px; }
.bounded-text { color: var(--text-secondary); font-size: 13px; word-break: break-word; }
.missing-object { padding: 12px; border: 1px dashed var(--danger); border-radius: 8px; color: var(--danger); background: var(--danger-soft); margin-bottom: 16px; }
.chain-overview { display: flex; align-items: stretch; gap: 4px; margin-bottom: 22px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
.chain-node { flex: 1 1 0; min-width: 0; padding: 8px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); text-align: center; overflow: hidden; }
.chain-node.pending { opacity: 0.6; }
.chain-node.success { border-color: var(--success); background: var(--success-soft); }
.chain-node.info { border-color: var(--primary); background: var(--primary-soft); }
.chain-node.warning { border-color: var(--warning); background: var(--warning-soft); }
.chain-node.danger { border-color: var(--danger); background: var(--danger-soft); }
.chain-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-secondary); margin-bottom: 3px; }
.chain-id { font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 3px; }
.chain-status { font-size: 11px; font-weight: 600; }
.chain-arrow { display: flex; align-items: center; color: var(--text-dim); font-size: 12px; flex-shrink: 0; }
.child-tag { display: inline-block; padding: 2px 6px; border-radius: 4px; background: var(--surface-2); border: 1px solid var(--border); margin-right: 6px; margin-bottom: 4px; font-size: 12px; }
@media (max-width: 900px) { .events-layout { grid-template-columns: 1fr; } .event-list { max-height: 360px; } .chain-overview { flex-wrap: wrap; } .chain-arrow { display: none; } }
@media (max-width: 375px) { .time-range { flex-direction: column; align-items: stretch; } .time-range input { width: 100%; } }
</style>
