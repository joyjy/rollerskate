<script setup lang="ts">
import type { RuntimeAuditOutput } from "@/api/schema";
import AgentInvocationDetail from "@/components/AgentInvocationDetail.vue";
import EventChain from "@/components/EventChain.vue";
import ExecutionDetail from "@/components/ExecutionDetail.vue";
import { formatDateTime } from "@/utils/format";

defineProps<{ audit: RuntimeAuditOutput | undefined }>();

function invocationAgent(audit: RuntimeAuditOutput): {
  principalId: string;
  handle: string;
  client: string;
  status: string;
} {
  return {
    principalId: audit.event.agentId ?? "unknown",
    handle: audit.event.agentId ?? "unknown",
    client: "unknown",
    status: "active"
  };
}

function duration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "—";
  return milliseconds < 1_000
    ? `${milliseconds} ms`
    : `${(milliseconds / 1_000).toFixed(1)} s`;
}
</script>

<template>
  <section class="panel audit-detail">
    <div class="panel-header">Event audit<span v-if="audit"> · {{ audit.event.eventId }}</span></div>
    <div v-if="!audit" class="state">Select an Event to inspect its durable audit chain.</div>
    <div v-else class="detail-body">
      <EventChain :audit="audit" />
      <template v-if="(audit.conversationTimeline?.length ?? 0) > 0">
        <div class="section-title">Conversation root timeline</div>
        <ol class="conversation-timeline">
          <li v-for="step in audit.conversationTimeline ?? []" :key="step.eventId">
            <div class="timeline-heading">
              <strong>{{ step.type }}</strong>
              <span class="status-tag">{{ step.status }}</span>
              <span v-if="step.outcome" class="status-tag">{{ step.outcome }}</span>
            </div>
            <div class="timeline-meta">
              <span>{{ formatDateTime(step.createdAt) }}</span>
              <span>duration {{ duration(step.durationMilliseconds) }}</span>
              <span v-if="step.agentHandle">Agent @{{ step.agentHandle }}</span>
              <span v-if="step.sessionId" class="mono">Session {{ step.sessionId }}</span>
              <span v-if="step.executionId" class="mono">Execution {{ step.executionId }}</span>
            </div>
            <div class="mono">Event {{ step.eventId }}</div>
            <div class="mono">Parent {{ step.parentEventId ?? "none" }}</div>
            <div v-if="step.reason" class="timeline-reason">{{ step.reason }}</div>
          </li>
        </ol>
      </template>
      <div class="section-title">Route</div>
      <dl class="kv">
        <dt>Event type</dt><dd class="mono">{{ audit.event.type }}</dd>
        <dt>Handler</dt><dd class="mono">{{ audit.execution?.handler ?? "none" }}</dd>
        <dt>Fanout</dt><dd>disabled · exactly one Handler</dd>
      </dl>
      <div class="section-title">Canonical Event</div>
      <dl class="kv">
        <dt>ID</dt><dd class="mono">{{ audit.event.eventId }}</dd>
        <dt>Source</dt><dd>{{ audit.event.source.kind }}<span v-if="audit.event.source.externalId" class="mono"> · {{ audit.event.source.externalId }}</span></dd>
        <dt>Agent</dt><dd class="mono">{{ audit.event.agentId ?? "none" }}</dd>
        <dt>Session</dt><dd class="mono">{{ audit.event.sessionId ?? "new" }}</dd>
        <dt>Destinations</dt><dd>{{ audit.event.destinationIds.length }}</dd>
        <dt>Created</dt><dd>{{ formatDateTime(audit.event.createdAt) }}</dd>
        <dt v-if="audit.event.prompt">Prompt</dt><dd v-if="audit.event.prompt" class="bounded-text">{{ audit.event.prompt }}</dd>
        <dt v-if="audit.event.body">Body</dt><dd v-if="audit.event.body" class="bounded-text">{{ audit.event.body }}</dd>
      </dl>
      <div class="section-title">Causality</div>
      <dl class="kv">
        <dt>Root</dt><dd class="mono">{{ audit.event.causality.rootEventId }}</dd>
        <dt>Parent</dt><dd class="mono">{{ audit.event.causality.parentEventId ?? "none" }}</dd>
        <dt>Hop</dt><dd>{{ audit.event.causality.hop }}</dd>
        <dt>Direct children</dt>
        <dd>
          <span v-if="audit.directChildren.length === 0">none</span>
          <span v-for="child in audit.directChildren" :key="child.eventId" class="mono child-tag">{{ child.eventId }} ({{ child.status }})</span>
        </dd>
        <dt>Boundary</dt><dd>{{ audit.causalityBoundary ?? "complete" }}</dd>
      </dl>
      <ExecutionDetail
        v-if="audit.execution"
        :title="`${audit.execution.handler === 'agent' ? 'AgentHandler' : 'ResultHandler'} Execution`"
        :execution="audit.execution"
      />
      <AgentInvocationDetail
        v-if="audit.invocation"
        :agent="invocationAgent(audit)"
        :status="audit.execution?.status ?? 'succeeded'"
        :created-at="audit.event.createdAt"
        :completed-at="audit.invocation.completedAt"
        :prompt="audit.event.prompt"
        :effective-prompt="audit.invocation.effectivePrompt"
        :result="null"
        :raw-output="audit.resultEvent?.output ?? null"
        :error="audit.resultEvent?.error ?? audit.execution?.lastError ?? null"
        :invocation="audit.invocation"
        :request-event-id="audit.event.eventId"
        :result-event-id="audit.resultEvent?.eventId ?? null"
      />
      <template v-if="audit.resultEvent && audit.event.type !== 'agent.result'">
        <div class="section-title">Result Event</div>
        <dl class="kv">
          <dt>ID</dt><dd class="mono">{{ audit.resultEvent.eventId }}</dd>
          <dt>Outcome</dt><dd>{{ audit.resultEvent.outcome }}</dd>
          <dt>Created</dt><dd>{{ formatDateTime(audit.resultEvent.createdAt) }}</dd>
          <dt>Root</dt><dd class="mono">{{ audit.resultEvent.causality.rootEventId }}</dd>
          <dt>Parent</dt><dd class="mono">{{ audit.resultEvent.causality.parentEventId ?? "none" }}</dd>
          <dt>Output</dt><dd class="bounded-text">{{ audit.resultEvent.output ?? audit.resultEvent.error ?? "—" }}</dd>
        </dl>
      </template>
      <ExecutionDetail v-if="audit.resultExecution" title="ResultHandler Execution" :execution="audit.resultExecution" />
      <template v-if="audit.session">
        <div class="section-title">Session</div>
        <dl class="kv">
          <dt>ID</dt><dd class="mono">{{ audit.session.sessionId }}</dd>
          <dt>Mode</dt><dd>{{ audit.session.resumedAt ? "resumed" : "created" }}</dd>
          <dt>{{ audit.session.resumedAt ? "Resumed at" : "Created at" }}</dt><dd>{{ formatDateTime(audit.session.resumedAt ?? audit.session.createdAt) }}</dd>
          <dt>Agent</dt><dd class="mono">{{ audit.session.agentId }}</dd>
          <dt>Adapter</dt><dd class="mono">{{ audit.session.adapterId }}</dd>
          <dt>Provider</dt><dd class="mono secret">{{ audit.session.providerSessionId }}</dd>
          <dt>Workspace</dt><dd class="mono secret">{{ audit.session.workspace }}</dd>
        </dl>
      </template>
      <div v-else-if="audit.event.sessionId" class="missing-object">Session referenced by Event is missing from audit chain.</div>
      <div class="section-title">Deliveries</div>
      <div v-if="audit.deliveries.length === 0" class="empty-inline">无需外部投递 · No outbound Delivery.</div>
      <dl v-for="item in audit.deliveries" v-else :key="item.delivery.deliveryId" class="kv delivery">
        <dt>ID</dt><dd class="mono">{{ item.delivery.deliveryId }}</dd>
        <dt>Source</dt><dd>{{ item.delivery.source }}</dd>
        <dt>Destination</dt><dd class="mono">{{ item.destination.kind }} · {{ item.destination.destinationId }}</dd>
        <dt>Status</dt><dd>{{ item.delivery.status }}</dd>
        <dt>Attempts</dt><dd>{{ item.delivery.attemptCount }}</dd>
        <dt>Created</dt><dd>{{ formatDateTime(item.delivery.createdAt) }}</dd>
        <dt>Attempted</dt><dd>{{ formatDateTime(item.delivery.attemptedAt) }}</dd>
        <dt>Delivered</dt><dd>{{ formatDateTime(item.delivery.deliveredAt) }}</dd>
        <dt>Receipt</dt><dd class="mono">{{ item.delivery.receipt ?? "—" }}</dd>
        <dt v-if="item.delivery.boundedError">Error</dt><dd v-if="item.delivery.boundedError" class="error">{{ item.delivery.boundedError }}</dd>
      </dl>
    </div>
  </section>
</template>

<style scoped>
.audit-detail { min-height: 420px; }
.detail-body { padding: 20px; }
.section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--text-secondary); margin: 16px 0 10px; }
.kv { display: grid; grid-template-columns: 130px 1fr; gap: 6px 14px; font-size: 13px; }
.kv dt { color: var(--text-secondary); font-weight: 500; }
.kv dd { margin: 0; word-break: break-word; }
.mono { font-family: var(--mono); font-size: 12px; word-break: break-all; }
.secret, .bounded-text { color: var(--text-secondary); }
.secret { font-style: italic; }
.bounded-text { font-size: 13px; word-break: break-word; }
.error { color: var(--danger); }
.delivery { padding: 12px; border: 1px solid var(--border); border-radius: 8px; }
.missing-object { padding: 12px; border: 1px dashed var(--danger); border-radius: 8px; color: var(--danger); background: var(--danger-soft); margin-bottom: 16px; }
.child-tag { display: inline-block; padding: 2px 6px; border-radius: 4px; background: var(--surface-2); border: 1px solid var(--border); margin-right: 6px; margin-bottom: 4px; }
.conversation-timeline { display: grid; gap: 10px; margin: 0; padding-left: 22px; }
.conversation-timeline li { padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
.timeline-heading, .timeline-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.timeline-meta { margin: 4px 0; color: var(--text-secondary); font-size: 11px; }
.status-tag { padding: 1px 6px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-secondary); font-size: 10px; }
.timeline-reason { margin-top: 4px; color: var(--text-secondary); font-size: 12px; }
@media (max-width: 600px) { .kv { grid-template-columns: 100px 1fr; } }
</style>
