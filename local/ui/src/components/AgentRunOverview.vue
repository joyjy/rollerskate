<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";

import type { LatestAgentRunViewOutput } from "@/api/schema";
import { formatDateTime } from "@/utils/format";

const props = defineProps<{
  run: NonNullable<LatestAgentRunViewOutput>;
  cancelling?: boolean;
}>();

const emit = defineEmits<{
  cancel: [runId: string];
}>();

const canCancel = computed(() =>
  props.run.summary.status === "active" ||
  props.run.summary.status === "waiting"
);
const exchangeTotal = computed(() =>
  props.run.exchangeCounts.reduce((total, exchange) => total + exchange.total, 0)
);
</script>

<template>
  <section class="panel agent-run-overview">
    <div class="panel-header">
      <span>Latest Agent Run</span>
      <span class="status" :class="run.summary.status">{{ run.summary.status }}</span>
    </div>
    <div class="panel-body">
      <div class="run-head">
        <div>
          <strong>{{ run.summary.mandate.label }}</strong>
          <div class="dim">{{ formatDateTime(run.summary.updatedAt) }}</div>
        </div>
        <div class="run-actions">
          <button
            v-if="canCancel"
            type="button"
            class="cancel-button"
            :disabled="cancelling"
            @click="emit('cancel', run.summary.runId)"
          >Cancel</button>
          <RouterLink
            class="trace-link"
            :to="{ name: 'events', query: { eventId: run.summary.rootEventId } }"
          >Inspect trace</RouterLink>
        </div>
      </div>

      <div class="run-grid">
        <div>
          <span class="label">Mandate</span>
          <strong>{{ run.summary.mandate.workflowRef ?? "inline objective" }}</strong>
          <span>{{ run.summary.mandate.kind }}</span>
        </div>
        <div>
          <span class="label">Steward role</span>
          <strong>@{{ run.summary.steward.handle }}</strong>
          <span>{{ run.participants.length }} participant{{ run.participants.length === 1 ? "" : "s" }}</span>
        </div>
        <div>
          <span class="label">External workspace</span>
          <strong>{{ run.summary.workspace?.access ?? "not granted" }}</strong>
          <span class="mono">{{ run.summary.workspace?.root ?? "uses Agent default workspace" }}</span>
        </div>
        <div>
          <span class="label">Progress</span>
          <strong>{{ run.summary.progress.steps }}/{{ run.summary.progress.maxSteps }} turns</strong>
          <span>depth ≤ {{ run.summary.progress.maxDepth }} · {{ exchangeTotal }} Agent exchange{{ exchangeTotal === 1 ? "" : "s" }}</span>
        </div>
      </div>

      <div
        v-if="run.summary.terminalSummary"
        class="terminal"
        :class="run.summary.status"
      >
        <strong>{{ run.summary.status }}</strong>
        <span>{{ run.summary.terminalSummary }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.panel { border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); overflow: hidden; }
.panel-header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--border); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--text-secondary); }
.panel-body { padding: 14px; }
.status { margin-left: auto; padding: 2px 7px; border-radius: 999px; background: var(--primary-soft); color: var(--primary); font-size: 10px; }
.status.succeeded { background: var(--success-soft); color: var(--success); }
.status.failed, .status.needs_human { background: var(--warning-soft); color: var(--warning); }
.status.cancelled { background: var(--muted-soft); color: var(--muted); }
.run-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.run-actions { display: flex; align-items: center; gap: 10px; }
.cancel-button { border: 1px solid var(--border); border-radius: 6px; padding: 5px 9px; background: transparent; color: var(--warning); cursor: pointer; }
.cancel-button:disabled { cursor: wait; opacity: .55; }
.dim { margin-top: 3px; color: var(--text-dim); font-size: 11px; }
.trace-link { color: var(--primary); font-size: 12px; font-weight: 700; text-decoration: none; }
.run-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.run-grid > div { display: grid; gap: 3px; min-width: 0; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
.run-grid strong, .run-grid span { overflow-wrap: anywhere; }
.run-grid span:not(.label) { color: var(--text-secondary); font-size: 11px; }
.label { color: var(--text-dim); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.terminal { display: flex; gap: 8px; margin-top: 10px; padding: 9px 10px; border-radius: 7px; background: var(--success-soft); color: var(--success); font-size: 12px; }
.terminal.failed, .terminal.needs_human { background: var(--warning-soft); color: var(--warning); }
.terminal.cancelled { background: var(--muted-soft); color: var(--muted); }
.mono { font-family: var(--mono); }
@media (max-width: 640px) {
  .run-head { flex-direction: column; }
  .run-grid { grid-template-columns: 1fr; }
  .terminal { flex-direction: column; }
}
</style>
