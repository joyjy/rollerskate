<script setup lang="ts">
import type { RuntimeAuditOutput } from "@/api/schema";
import { deriveLifecycle, lifecycleClass, lifecycleLabel } from "@/utils/events";
import { formatDateTime } from "@/utils/format";

defineProps<{
  audit: RuntimeAuditOutput;
  selected: boolean;
}>();
const emit = defineEmits<{ select: [id: string] }>();
</script>

<template>
  <button
    type="button"
    class="event-row"
    :class="{ active: selected }"
    :aria-selected="selected"
    @click="emit('select', audit.event.eventId)"
  >
    <span class="event-row-top">
      <span class="event-kind">{{ audit.event.type }}</span>
      <span class="lifecycle-badge" :class="lifecycleClass(deriveLifecycle(audit))">{{ lifecycleLabel(deriveLifecycle(audit)) }}</span>
    </span>
    <span class="mono event-id">{{ audit.event.eventId }}</span>
    <span class="event-meta">{{ audit.event.source.kind }}<span v-if="audit.event.source.externalId"> · {{ audit.event.source.externalId }}</span> · {{ formatDateTime(audit.event.createdAt) }}</span>
    <span class="event-summary">
      <span>Agent <span class="mono">{{ audit.event.agentId ?? "none" }}</span></span>
      <span>Session {{ audit.session ? "yes" : "no" }}</span>
      <span>Destinations {{ audit.event.destinationIds.length }}</span>
    </span>
    <span v-if="audit.event.boundedPromptSummary" class="event-prompt">{{ audit.event.boundedPromptSummary }}</span>
    <span class="event-lifecycle-change">changed {{ formatDateTime(audit.lifecycleChangedAt) }}</span>
    <span v-if="audit.reasonForIntervention" class="event-reason">{{ audit.reasonForIntervention }}</span>
  </button>
</template>

<style scoped>
.event-row { width: 100%; display: flex; flex-direction: column; gap: 4px; padding: 13px 16px; border: 0; border-bottom: 1px solid var(--border); background: var(--surface); color: var(--text); text-align: left; cursor: pointer; }
.event-row:hover { background: var(--surface-2); }
.event-row:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.event-row.active { background: var(--primary-soft); box-shadow: inset 3px 0 var(--primary); }
.event-row-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.event-kind { font-weight: 700; }
.event-id, .event-meta, .event-summary, .event-prompt, .event-reason { font-size: 12px; }
.event-id, .event-meta, .event-summary, .event-prompt { color: var(--text-secondary); }
.event-id { word-break: break-all; }
.event-summary { display: flex; gap: 10px; flex-wrap: wrap; }
.event-prompt { font-style: italic; word-break: break-word; }
.event-lifecycle-change { font-size: 11px; color: var(--text-dim); }
.event-reason { color: var(--danger); }
.lifecycle-badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; white-space: nowrap; }
.lifecycle-badge.muted { background: var(--muted-soft); color: var(--muted); }
.lifecycle-badge.info { background: var(--primary-soft); color: var(--primary); }
.lifecycle-badge.warning { background: var(--warning-soft); color: var(--warning); }
.lifecycle-badge.success { background: var(--success-soft); color: var(--success); }
.lifecycle-badge.danger { background: var(--danger-soft); color: var(--danger); }
</style>
