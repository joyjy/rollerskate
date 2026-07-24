<script setup lang="ts">
import { computed } from "vue";
import type { LocalAgent } from "@/types/local";
import type { RuntimeEvent } from "@/types/runtime";

const props = defineProps<{
  event: RuntimeEvent;
  events: readonly RuntimeEvent[];
  agents: readonly LocalAgent[];
  compact?: boolean;
  pending: string | null;
}>();

const emit = defineEmits<{
  (e: "dispatch", sourceMessageEventId: string, principalId: string): void;
}>();

const activeAgents = computed(() =>
  props.agents.filter((agent) => agent.status === "active")
);

const dispatchReceipt = computed(() => {
  const sourceId = props.event.dispatchCard?.sourceMessageEventId;
  if (!sourceId) return undefined;
  return props.events.find((event) =>
    event.type === "chat.dispatch" &&
    event.sourceMessageEventId === sourceId
  );
});

const availableCandidates = computed(() => {
  const active = new Set(activeAgents.value.map((agent) => agent.principalId));
  return props.event.dispatchCard?.candidates.filter((candidate) =>
    active.has(candidate.principalId)
  ) ?? [];
});

const sourceMessageEventId = computed(() =>
  props.event.dispatchCard?.sourceMessageEventId ?? ""
);
</script>

<template>
  <div v-if="dispatchReceipt" class="system-card success">
    Dispatched to <strong>@{{ dispatchReceipt.targetHandleSnapshot }}</strong>
  </div>
  <div v-else-if="event.dispatchCard" class="dispatch-card" :class="{ compact }">
    <div v-if="!compact">
      <strong>Choose an Agent</strong>
      <span>This message can be dispatched once.</span>
    </div>
    <div v-if="availableCandidates.length" class="dispatch-options">
      <button
        v-for="candidate in availableCandidates"
        :key="candidate.principalId"
        type="button"
        :disabled="pending !== null"
        @click="emit('dispatch', sourceMessageEventId, candidate.principalId)"
      >
        {{ pending === sourceMessageEventId ? "Dispatching…" : `@${candidate.handle}` }}
      </button>
    </div>
    <span v-else class="no-candidates">No active Agents. Resume or add one from Agents.</span>
  </div>
</template>

<style scoped>
.dispatch-card {
  margin-top: 10px;
  padding: 12px;
  border: 1px solid #bfdbfe;
  border-radius: 8px;
  background: var(--primary-soft);
}
.dispatch-card > div:first-child { display: flex; justify-content: space-between; gap: 12px; color: var(--text-secondary); font-size: 12px; }
.dispatch-card strong { color: var(--text); }
.dispatch-options { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.dispatch-options button {
  appearance: none; border: 1px solid #93c5fd; background: var(--surface);
  color: var(--primary); padding: 6px 10px; border-radius: 6px;
  font-size: 13px; font-weight: 600; cursor: pointer;
}
.dispatch-options button:hover:not(:disabled) { background: var(--surface-2); }
.dispatch-options button:disabled { opacity: 0.5; cursor: not-allowed; }
.no-candidates { color: var(--warning); font-size: 12px; }
.dispatch-card.compact {
  margin-top: 0;
  padding: 8px 10px;
  background: transparent;
  border: 0;
}
.dispatch-card.compact .dispatch-options { margin-top: 0; }
</style>
