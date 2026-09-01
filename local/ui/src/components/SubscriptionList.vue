<script setup lang="ts">
import type { Subscription } from "@/types/subscription";
import StatusBadge from "./StatusBadge.vue";

defineProps<{
  subscriptions: Subscription[];
  selectedId: string;
}>();

const emit = defineEmits<{
  (e: "select", id: string): void;
}>();

function isRunBound(subscription: Subscription): boolean {
  return subscription.kind === "free"
    ? subscription.definition.schema === "SubscriptionDefinition@4"
    : subscription.definition.schemaVersion === "ContinuousSubscriptionDefinition@2";
}
</script>

<template>
  <div class="list-body">
    <button
      v-for="sub in subscriptions"
      :key="sub.id"
      type="button"
      class="subscription-row"
      :class="{ active: sub.id === selectedId }"
      :aria-selected="sub.id === selectedId"
      @click="emit('select', sub.id)"
    >
      <div class="row-header">
        <div class="row-id">{{ sub.id }}</div>
        <StatusBadge :status="sub.status" />
      </div>
      <div class="row-title">{{ sub.title }}</div>
      <div class="row-meta">{{ sub.probe.plugin.id }}</div>
      <div v-if="sub.owner" class="row-meta">@{{ sub.owner.handle }} · {{ sub.owner.client }}</div>
      <div v-else class="row-meta">Run-owned trigger source</div>
      <div class="row-meta">
        {{ isRunBound(sub) ? "Run binding" : `${sub.callbacks.length} legacy callback(s)` }}
      </div>
    </button>
  </div>
</template>

<style scoped>
.list-body {
  min-height: 0;
  flex: 1 1 auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
}

.subscription-row {
  width: 100%;
  text-align: left;
  background: var(--surface);
  color: inherit;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.subscription-row:hover {
  border-color: var(--primary);
}

.subscription-row.active {
  border-color: var(--primary);
  box-shadow: var(--shadow-lg);
  outline: 2px solid var(--primary-soft);
}

.row-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 6px;
}

.row-id {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-secondary);
  word-break: break-all;
}

.row-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 2px;
}

.row-meta {
  font-size: 12px;
  color: var(--text-secondary);
}
</style>
