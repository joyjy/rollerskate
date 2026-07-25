<script setup lang="ts">
import { formatDateTime } from "@/utils/format";
import type { AgentConsoleItem } from "@/types/local";

defineProps<{
  agents: readonly AgentConsoleItem[];
  selectedId: string | null;
}>();

const emit = defineEmits<{
  select: [id: string];
}>();

function sessionSummary(agent: AgentConsoleItem): string {
  if (!agent.currentSession) return "No session yet · 首次调用时创建";
  const session = agent.currentSession;
  return `Generation ${session.generation} · ${session.state} · ${formatDateTime(session.updatedAt)}`;
}
</script>

<template>
  <aside class="panel roster">
    <div class="panel-header">Agent roster · {{ agents.length }}</div>
    <button
      v-for="agent in agents"
      :key="agent.principalId"
      type="button"
      class="roster-row"
      :class="{ active: selectedId === agent.principalId }"
      :aria-selected="selectedId === agent.principalId"
      @click="emit('select', agent.principalId)"
    >
      <div class="avatar">{{ agent.handle.slice(0, 1).toUpperCase() }}</div>
      <div class="row-main">
        <div class="handle">{{ agent.handle }}</div>
        <div class="row-meta">
          <span class="badge" :class="agent.status">{{ agent.status }}</span>
          <span class="badge" :class="agent.availability.state">{{ agent.availability.state }}</span>
          <span class="client">{{ agent.client }}</span>
        </div>
        <div class="row-session">{{ sessionSummary(agent) }}</div>
      </div>
    </button>
  </aside>
</template>

<style scoped>
.roster { max-height: calc(100vh - 220px); max-height: calc(100dvh - 220px); overflow-y: auto; }
.roster-row {
  display: flex; align-items: center; gap: 12px;
  width: 100%; padding: 13px 16px; border: 0; border-bottom: 1px solid var(--border);
  background: var(--surface); color: var(--text); text-align: left; cursor: pointer;
}
.roster-row:hover { background: var(--surface-2); }
.roster-row:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.roster-row.active { background: var(--primary-soft); box-shadow: inset 3px 0 var(--primary); }
.roster-row:last-child { border-bottom: 0; }
.avatar { width: 36px; height: 36px; border-radius: 9px; display: grid; place-items: center; background: var(--primary-soft); color: var(--primary); font-weight: 800; flex-shrink: 0; }
.row-main { flex: 1; min-width: 0; }
.handle { font-weight: 750; }
.handle::before { content: "@"; color: var(--text-dim); font-weight: 500; margin-right: 1px; }
.row-meta { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
.client, .row-session { color: var(--text-secondary); font-size: 12px; }
.row-session { margin-top: 3px; }
.badge.active, .badge.ready { background: var(--success-soft); color: var(--success); }
.badge.suspended { background: var(--muted-soft); color: var(--muted); }
.badge.unavailable { background: var(--danger-soft); color: var(--danger); }
.badge.unknown { background: var(--warning-soft); color: var(--warning); }
@media (max-width: 1100px) { .roster { max-height: 360px; } }
</style>
