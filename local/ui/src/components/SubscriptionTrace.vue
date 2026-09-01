<script setup lang="ts">
import { RouterLink } from "vue-router";
import { formatDateTime } from "@/utils/format";
import type { Subscription, SubscriptionVisualStatus } from "@/types/subscription";
import StatusBadge from "./StatusBadge.vue";

defineProps<{
  subscription: Subscription;
}>();
function callbackBadge(status: string): SubscriptionVisualStatus {
  if (status === "pending" || status === "queued") return "paused";
  if (status === "started" || status === "running" || status === "retry_wait") return "running";
  if (status === "succeeded" || status === "completed") return "completed";
  if (status === "blocked") return "blocked";
  if (status === "unknown" || status === "completed_with_unknown") return "unknown";
  if (status === "cancelled") return "cancelled";
  return "failed";
}
function invocationBadge(callback: {
  status: string;
  invocationStatus?: string | null;
}): SubscriptionVisualStatus {
  return callback.invocationStatus === undefined || callback.invocationStatus === null
    ? callback.status === "pending" || callback.status === "started"
      ? callbackBadge(callback.status)
      : "unknown"
    : callbackBadge(callback.invocationStatus);
}
function agentResultBadge(callback: {
  status: string;
  agentResult?: { status: string } | null;
}): SubscriptionVisualStatus {
  if (callback.agentResult !== undefined && callback.agentResult !== null) {
    return callbackBadge(callback.agentResult.status);
  }
  return callback.status === "pending" || callback.status === "started"
    ? callbackBadge(callback.status)
    : "unknown";
}
</script>

<template>
  <div class="main-body">
    <div class="panel-title">{{ subscription.title }}</div>
    <div class="panel-subtitle">
      {{ subscription.id }} ·
      {{ subscription.probe.plugin.id }}@{{ subscription.probe.plugin.schemaVersion }} ·
      <StatusBadge :status="subscription.status" />
    </div>

    <template v-if="subscription.kind === 'free'">
      <div class="section-title">Versioned definition</div>
      <dl class="kv">
        <dt>Schema</dt><dd>{{ subscription.definition.schema }}</dd>
        <dt>Revision</dt><dd class="mono">{{ subscription.definition.revision }}</dd>
        <dt>Definition digest</dt><dd class="mono">{{ subscription.definition.digest }}</dd>
        <dt>Probe artifact</dt><dd class="mono">{{ subscription.definition.artifactRevision }} · {{ subscription.definition.artifactDigest }}</dd>
        <dt>Callback phase</dt><dd><StatusBadge :status="callbackBadge(subscription.definition.callbackPhaseStatus)" /></dd>
      </dl>
      <template v-if="subscription.definition.schema === 'SubscriptionDefinition@4'">
        <div class="section-title registration-title">Run trigger binding</div>
        <div class="fire-card">The Subscription owns observation lifecycle only. Its terminal occurrence activates a Run cycle.</div>
        <pre>{{ JSON.stringify(subscription.definition.sourceBinding, null, 2) }}</pre>
        <dl class="kv">
          <dt>Run</dt>
          <dd>
            <RouterLink
              v-if="subscription.agentRunId"
              :to="{ name: 'steward', query: { runId: subscription.agentRunId, ...(subscription.cycleId ? { cycleId: subscription.cycleId } : {}) } }"
            >{{ subscription.agentRunId }}<template v-if="subscription.cycleId"> / {{ subscription.cycleId }}</template> → Run Workspace</RouterLink>
            <span v-else>Awaiting terminal occurrence</span>
          </dd>
          <dt>Admission receipt</dt><dd>{{ subscription.admissionReceipt ? "durable" : "pending" }}</dd>
        </dl>
        <pre v-if="subscription.admissionReceipt">{{ JSON.stringify(subscription.admissionReceipt, null, 2) }}</pre>
      </template>
      <template v-else>
        <div class="section-title registration-title">Legacy callback grants · non-public</div>
        <div v-if="subscription.definition.callbacks.length === 0" class="fire-card">No callbacks. Terminal observation is the final product state.</div>
        <article v-for="callback in subscription.definition.callbacks" :key="callback.callbackId" class="callback-card">
          <header><strong>{{ callback.kind }}</strong></header>
          <div class="callback-columns"><div><span>Definition</span><pre>{{ JSON.stringify(callback.definition, null, 2) }}</pre></div><div><span>Exact grant</span><pre>{{ JSON.stringify(callback.grant, null, 2) }}</pre></div></div>
        </article>
        <div v-if="subscription.callbacks.length > 0" class="section-title registration-title">Legacy callback occurrences</div>
        <article v-for="callback in subscription.callbacks" :key="callback.callbackId" class="callback-card">
          <header>
            <strong>#{{ callback.ordinal + 1 }} {{ callback.kind }}</strong>
            <div v-if="callback.kind === 'agent.invoke'" class="callback-status">
              <span>Invocation {{ callback.invocationStatus ?? "unknown" }}</span><StatusBadge :status="invocationBadge(callback)" />
              <span>Result {{ callback.agentResult?.status ?? "unknown" }}</span><StatusBadge :status="agentResultBadge(callback)" />
            </div>
            <StatusBadge v-else :status="callbackBadge(callback.status)" />
          </header>
          <div v-if="callback.receipt !== undefined"><span class="note">Receipt</span><pre>{{ JSON.stringify(callback.receipt, null, 2) }}</pre></div>
          <div v-if="callback.agentResult && callback.agentResult.status !== 'succeeded'" class="error-card">{{ callback.agentResult.summary }}</div>
          <div v-if="callback.lastError" class="error-card">{{ callback.lastError }}</div>
        </article>
      </template>
      <div v-if="subscription.terminalObservation !== null" class="registration-title"><div class="section-title">Terminal observation</div><pre>{{ JSON.stringify(subscription.terminalObservation, null, 2) }}</pre></div>
    </template>

    <template v-else>
      <div class="section-title">Continuous checkpoint</div>
      <dl class="kv">
        <dt>Poll count</dt><dd>{{ subscription.pollCount }}</dd>
        <dt>Next poll</dt><dd>{{ formatDateTime(subscription.nextPollAt) }}</dd>
        <dt>Checkpoint</dt><dd class="mono">{{ subscription.checkpointOccurrenceKey ?? "none" }}</dd>
        <dt>Pending</dt><dd class="mono">{{ subscription.pendingOccurrenceKey ?? "none" }}</dd>
        <dt>Visible callback occurrence</dt><dd class="mono">{{ subscription.callbackOccurrenceKey ?? "none" }}</dd>
        <dt>Callback state</dt><dd>{{ subscription.callbackSummary.terminal }}/{{ subscription.callbackSummary.total }} terminal · {{ subscription.callbackSummary.started }} started · {{ subscription.callbackSummary.unknown }} unknown</dd>
      </dl>
      <template v-if="subscription.definition.schemaVersion === 'ContinuousSubscriptionDefinition@2'">
        <div class="section-title registration-title">Run trigger binding</div>
        <pre>{{ JSON.stringify(subscription.definition.sourceBinding, null, 2) }}</pre>
        <dl class="kv">
          <dt>Run</dt>
          <dd>
            <RouterLink
              v-if="subscription.agentRunId"
              :to="{ name: 'steward', query: { runId: subscription.agentRunId, ...(subscription.pendingCycleId ? { cycleId: subscription.pendingCycleId } : {}) } }"
            >{{ subscription.agentRunId }}<template v-if="subscription.pendingCycleId"> / {{ subscription.pendingCycleId }}</template> → Run Workspace</RouterLink>
            <span v-else>Awaiting first delta</span>
          </dd>
          <dt>Pending admission</dt><dd>{{ subscription.pendingAdmissionReceipt ? "durable" : "none" }}</dd>
        </dl>
        <pre v-if="subscription.pendingAdmissionReceipt">{{ JSON.stringify(subscription.pendingAdmissionReceipt, null, 2) }}</pre>
      </template>
      <div v-else class="fire-card registration-title">Legacy callbacks · non-public</div>
      <div v-if="subscription.latestError" class="error-card">{{ subscription.latestError }}</div>
      <article v-for="callback in subscription.callbacks" :key="callback.callbackId" class="callback-card">
        <header><strong>#{{ callback.ordinal + 1 }} {{ callback.kind }}</strong><StatusBadge :status="callbackBadge(callback.status)" /></header>
        <div v-if="callback.receipt !== undefined"><span class="note">Receipt</span><pre>{{ JSON.stringify(callback.receipt, null, 2) }}</pre></div>
      </article>
      <div class="section-title registration-title">Checkpoint observation</div>
      <pre>{{ JSON.stringify(subscription.checkpointObservation, null, 2) }}</pre>
    </template>


  </div>
</template>

<style scoped>
.main-body { padding: 22px; min-height: calc(100vh - 180px); }
.panel-title { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
.panel-subtitle { color: var(--text-secondary); font-size: 13px; margin-bottom: 20px; }
.fire-card { display: flex; flex-direction: column; gap: 6px; padding: 14px; border: 1px solid var(--border); border-radius: 8px; color: var(--text-secondary); }
.error-card { margin-top: 12px; padding: 12px; border: 1px solid var(--danger); background: var(--danger-soft); color: var(--danger); border-radius: 8px; }
.registration-title { margin-top: 22px; }
.mono { font-family: var(--mono); word-break: break-all; }
.callback-card { margin-top: 10px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; }.callback-card header { display: flex; justify-content: space-between; gap: 12px; }.callback-status { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 11px; }.callback-columns { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; margin-top: 10px; }.callback-columns span,.note { color: var(--text-secondary); font-size: 11px; text-transform: uppercase; }pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.45 var(--mono); background: var(--surface-muted); border-radius: 6px; padding: 8px; }@media (max-width: 720px) { .callback-columns { grid-template-columns: 1fr; } }
</style>
