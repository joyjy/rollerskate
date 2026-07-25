<script setup lang="ts">
import type { RuntimeAuditOutput } from "@/api/schema";
import { deriveLifecycle } from "@/utils/events";

const props = defineProps<{ audit: RuntimeAuditOutput }>();
const chatMessageChild = () =>
  props.audit.directChildren.find((child) => child.type === "chat.message");
function nodeClass(status?: string): string {
  if (!status) return "pending";
  if (["succeeded", "delivered"].includes(status)) return "success";
  if (["failed", "delivery_failed"].includes(status)) return "danger";
  if (["running", "retry_wait"].includes(status)) return "info";
  if (status === "queued") return "muted";
  return "pending";
}
</script>

<template>
  <div class="chain-overview">
    <div class="chain-node" :class="nodeClass('succeeded')">
      <div class="chain-label">Event</div>
      <div class="chain-id mono">{{ audit.event.eventId }}</div>
      <div class="chain-status">{{ audit.event.type }}</div>
    </div>
    <template v-if="audit.execution && audit.event.type === 'chat.dispatch'">
      <div class="chain-arrow">→</div>
      <div class="chain-node" :class="nodeClass(audit.execution.status)">
        <div class="chain-label">AgentHandler</div>
        <div class="chain-id mono">{{ audit.execution.executionId }}</div>
        <div class="chain-status">{{ audit.execution.status }}</div>
      </div>
      <div class="chain-arrow">→</div>
      <div class="chain-node" :class="nodeClass(chatMessageChild() ? 'succeeded' : 'pending')">
        <div class="chain-label">chat.message</div>
        <div class="chain-id mono">{{ chatMessageChild()?.eventId ?? "—" }}</div>
        <div class="chain-status">{{ chatMessageChild() ? "recorded" : "pending" }}</div>
      </div>
    </template>
    <template v-else-if="audit.execution && audit.event.type !== 'agent.result'">
      <div class="chain-arrow">→</div>
      <div class="chain-node" :class="nodeClass(audit.execution.status)">
        <div class="chain-label">AgentHandler</div>
        <div class="chain-id mono">{{ audit.execution.executionId }}</div>
        <div class="chain-status">{{ audit.execution.status }}</div>
      </div>
      <div class="chain-arrow">→</div>
      <div class="chain-node" :class="nodeClass(audit.resultEvent?.outcome)">
        <div class="chain-label">agent.result</div>
        <div class="chain-id mono">{{ audit.resultEvent?.eventId ?? "—" }}</div>
        <div class="chain-status">{{ audit.resultEvent?.outcome ?? "pending" }}</div>
      </div>
      <div class="chain-arrow">→</div>
      <div class="chain-node" :class="nodeClass(audit.resultExecution?.status)">
        <div class="chain-label">ResultHandler</div>
        <div class="chain-id mono">{{ audit.resultExecution?.executionId ?? "—" }}</div>
        <div class="chain-status">{{ audit.resultExecution?.status ?? "pending" }}</div>
      </div>
      <div class="chain-arrow">→</div>
      <div class="chain-node" :class="nodeClass(audit.deliveries.length === 0 ? (audit.resultEvent ? 'succeeded' : 'pending') : deriveLifecycle(audit) === 'delivered' ? 'delivered' : deriveLifecycle(audit) === 'delivery_failed' ? 'delivery_failed' : 'running')">
        <div class="chain-label">Delivery</div>
        <div class="chain-id mono">{{ audit.deliveries[0]?.delivery.deliveryId ?? "—" }}</div>
        <div class="chain-status">{{ audit.deliveries.length === 0 ? (audit.resultEvent ? "none" : "pending") : deriveLifecycle(audit) }}</div>
      </div>
    </template>
    <template v-else-if="audit.execution">
      <div class="chain-arrow">→</div>
      <div class="chain-node" :class="nodeClass(audit.execution.status)">
        <div class="chain-label">ResultHandler</div>
        <div class="chain-id mono">{{ audit.execution.executionId }}</div>
        <div class="chain-status">{{ audit.execution.status }}</div>
      </div>
      <div class="chain-arrow">→</div>
      <div class="chain-node" :class="nodeClass(audit.deliveries.length === 0 ? 'succeeded' : deriveLifecycle(audit) === 'delivered' ? 'delivered' : deriveLifecycle(audit) === 'delivery_failed' ? 'delivery_failed' : 'running')">
        <div class="chain-label">Delivery</div>
        <div class="chain-id mono">{{ audit.deliveries[0]?.delivery.deliveryId ?? "—" }}</div>
        <div class="chain-status">{{ audit.deliveries.length === 0 ? "none" : deriveLifecycle(audit) }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chain-overview { display: flex; align-items: stretch; gap: 4px; margin-bottom: 22px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
.chain-node { flex: 1 1 0; min-width: 0; padding: 8px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); text-align: center; overflow: hidden; }
.chain-node.pending { opacity: .6; }
.chain-node.success { border-color: var(--success); background: var(--success-soft); }
.chain-node.info { border-color: var(--primary); background: var(--primary-soft); }
.chain-node.warning { border-color: var(--warning); background: var(--warning-soft); }
.chain-node.danger { border-color: var(--danger); background: var(--danger-soft); }
.chain-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: var(--text-secondary); margin-bottom: 3px; }
.chain-id { font-family: var(--mono); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 3px; }
.chain-status { font-size: 11px; font-weight: 600; }
.chain-arrow { display: flex; align-items: center; color: var(--text-dim); font-size: 12px; flex-shrink: 0; }
@media (max-width: 1100px) { .chain-overview { flex-wrap: wrap; } .chain-arrow { display: none; } }
</style>
