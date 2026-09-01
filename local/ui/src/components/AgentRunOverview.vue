<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";

import type { AgentRunDetailViewOutput, AgentRunStepOutput } from "@/api/schema";
import AgentInvocationDetail from "@/components/AgentInvocationDetail.vue";
import AgentRunOutputs from "@/components/AgentRunOutputs.vue";
import { formatDateTime } from "@/utils/format";

const props = defineProps<{
  run: AgentRunDetailViewOutput;
  cancelling?: boolean;
  archiving?: boolean;
  cycleId?: string;
  outputId?: string;
}>();

const emit = defineEmits<{
  cancel: [runId: string];
  archive: [runId: string, archived: boolean];
}>();

const canCancel = computed(() =>
  props.run.summary.status === "active" ||
  props.run.summary.status === "waiting" ||
  props.run.summary.status === "awaiting_source" ||
  props.run.summary.status === "awaiting_orchestrator"
);
const canArchive = computed(() =>
  props.run.summary.status === "succeeded" ||
  props.run.summary.status === "failed" ||
  props.run.summary.status === "needs_human" ||
  props.run.summary.status === "cancelled"
);
const exchangeTotal = computed(() =>
  props.run.exchangeCounts.reduce((total, exchange) => total + exchange.total, 0)
);

function stepDepthPadding(step: AgentRunStepOutput): string {
  return `${step.depth * 16}px`;
}
</script>

<template>
  <section class="panel agent-run-overview">
    <div class="panel-header">
      <span>Agent Run</span>
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
            v-if="canArchive"
            type="button"
            class="archive-button"
            :disabled="archiving"
            @click="emit(
              'archive',
              run.summary.runId,
              run.summary.archivedAt === null
            )"
          >{{ run.summary.archivedAt === null ? "Archive" : "Restore" }}</button>
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
          <span>{{ run.summary.orchestrationMode }} · {{ run.participants.length }} participant{{ run.participants.length === 1 ? "" : "s" }}</span>
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

      <div v-if="run.checkpoint" class="checkpoint">
        <strong>Awaiting Caller decision</strong>
        <span>{{ run.checkpoint.result.outcome }} · {{ run.checkpoint.result.summary }}</span>
        <span class="mono">run version {{ run.projection.version }} · {{ run.decisions.length }} accepted decision{{ run.decisions.length === 1 ? "" : "s" }}</span>
      </div>

      <div v-if="run.triggerSource" class="source-card">
        <div class="source-head">
          <div>
            <span class="label">Trigger source</span>
            <strong>{{ run.triggerSource.kind }} · {{ run.triggerSource.status }}</strong>
          </div>
          <RouterLink class="trace-link" :to="run.triggerSource.diagnosticsRoute">Open trigger diagnostics</RouterLink>
        </div>
        <dl class="source-grid">
          <dt>Definition</dt><dd class="mono">{{ run.triggerSource.id }} · {{ run.triggerSource.definitionRevision }}</dd>
          <dt>Reconcile</dt><dd>{{ run.triggerSource.reconcileStatus }}</dd>
          <dt>Pending</dt><dd class="mono">{{ run.triggerSource.pendingOccurrenceKey ?? "none" }}</dd>
          <dt>Checkpoint</dt><dd class="mono">{{ run.triggerSource.checkpointOccurrenceKey ?? "none" }}</dd>
          <dt>Next source action</dt><dd>{{ run.triggerSource.nextActionAt ? formatDateTime(run.triggerSource.nextActionAt) : "none" }}</dd>
          <template v-if="run.triggerSource.lastOccurrence">
            <dt>Last occurrence</dt>
            <dd class="mono">
              {{ run.triggerSource.lastOccurrence.occurrenceKey }} ·
              {{ run.triggerSource.lastOccurrence.cycleId ?? "no cycle" }} ·
              {{ run.triggerSource.lastOccurrence.status }}
            </dd>
          </template>
        </dl>
        <div v-if="run.triggerSource.latestError" class="source-error">{{ run.triggerSource.latestError }}</div>
      </div>

      <div
        v-if="run.summary.terminalSummary"
        class="terminal"
        :class="run.summary.status"
      >
        <strong>{{ run.summary.status }}</strong>
        <span>{{ run.summary.terminalSummary }}</span>
      </div>

      <AgentRunOutputs
        :run-id="run.summary.runId"
        :folders="run.outputFolders"
        :cycle-id="cycleId"
        :output-id="outputId"
      />

      <div class="steps-section">
        <div class="section-title">
          Steps
          <span class="step-count">{{ run.steps.length }}</span>
        </div>
        <div v-if="run.steps.length === 0" class="empty-inline">No steps recorded.</div>
        <ol v-else class="steps-list">
          <li
            v-for="step in run.steps"
            :key="step.stepId"
            class="step-item"
            :style="{ paddingLeft: stepDepthPadding(step) }"
          >
            <AgentInvocationDetail
              :agent="step.agent"
              :status="step.status"
              :created-at="step.createdAt"
              :completed-at="step.completedAt"
              :prompt="step.prompt"
              :effective-prompt="step.effectivePrompt"
              :result="step.result"
              :raw-output="step.rawOutput"
              :error="step.error"
              :invocation="step.invocation"
              :request-event-id="step.requestEventId"
              :result-event-id="step.resultEventId"
            />
          </li>
        </ol>
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
.archive-button { border: 1px solid var(--border); border-radius: 6px; padding: 5px 9px; background: transparent; color: var(--text-secondary); cursor: pointer; }
.cancel-button:disabled, .archive-button:disabled { cursor: wait; opacity: .55; }
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
.checkpoint { display: grid; gap: 4px; margin-top: 10px; padding: 10px; border: 1px solid var(--primary); border-radius: 7px; background: var(--primary-soft); color: var(--text); font-size: 12px; }
.source-card { display: grid; gap: 10px; margin-top: 10px; padding: 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface-2); font-size: 12px; }
.source-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.source-head > div { display: grid; gap: 3px; }
.source-grid { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 5px 10px; margin: 0; }
.source-grid dt { color: var(--text-dim); }
.source-grid dd { margin: 0; overflow-wrap: anywhere; }
.source-error { padding: 7px 8px; border-radius: 6px; background: var(--warning-soft); color: var(--warning); }
.steps-section { margin-top: 16px; }
.section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--text-secondary); margin-bottom: 10px; }
.step-count { margin-left: 6px; padding: 1px 6px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); font-size: 10px; }
.steps-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.step-item { min-width: 0; }
.empty-inline { color: var(--text-dim); font-size: 13px; }
.mono { font-family: var(--mono); }
@media (max-width: 640px) {
  .run-head { flex-direction: column; }
  .run-grid { grid-template-columns: 1fr; }
  .terminal { flex-direction: column; }
  .source-head { align-items: flex-start; flex-direction: column; }
  .source-grid { grid-template-columns: 1fr; }
}
</style>
