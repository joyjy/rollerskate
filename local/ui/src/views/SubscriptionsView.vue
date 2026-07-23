<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { Subscription } from "@/types/subscription";
import SubscriptionList from "@/components/SubscriptionList.vue";
import SubscriptionTrace from "@/components/SubscriptionTrace.vue";
import QuickHint from "@/components/QuickHint.vue";

const subscriptions = ref<Subscription[]>([]);
const selectedId = ref("");
const selected = ref<Subscription | null>(null);
const loading = ref(true);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const response = await fetch("/api/subscriptions", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    subscriptions.value = await response.json() as Subscription[];
    const current = subscriptions.value.find((item) => item.id === selectedId.value) ?? subscriptions.value[0] ?? null;
    selected.value = current;
    selectedId.value = current?.id ?? "";
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function onSelect(id: string) {
  selectedId.value = id;
  const found = subscriptions.value.find((s: Subscription) => s.id === id);
  if (found) selected.value = found;
}

function updateSubscription(updated: Subscription) {
  const index = subscriptions.value.findIndex((s: Subscription) => s.id === updated.id);
  if (index >= 0) {
    subscriptions.value[index] = updated;
    selected.value = updated;
  }
}
</script>

<template>
  <div v-if="loading" class="empty-state">Loading durable Subscriptions…</div>
  <div v-else-if="error" class="empty-state error">Failed to load Subscriptions: {{ error }}</div>
  <div v-else-if="!selected" class="empty-state">No Subscription is registered.</div>
  <div v-else class="subscriptions-layout">
    <div class="panel">
      <div class="panel-header">Subscriptions</div>
      <SubscriptionList
        :subscriptions="subscriptions"
        :selected-id="selectedId"
        @select="onSelect"
      />
    </div>

    <div class="panel">
      <SubscriptionTrace :subscription="selected" />
    </div>

    <div class="panel">
      <div class="panel-header">Quick Hint</div>
      <QuickHint :subscription="selected" @update="updateSubscription" />
    </div>
  </div>
</template>

<style scoped>
.subscriptions-layout {
  display: grid;
  grid-template-columns: 280px 1fr 300px;
  gap: 20px;
  max-width: 1500px;
  margin: 0 auto;
  align-items: start;
}

.empty-state {
  max-width: 1500px;
  margin: 0 auto;
  padding: 32px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-secondary);
}

.empty-state.error { color: var(--danger); }

@media (max-width: 1100px) {
  .subscriptions-layout {
    grid-template-columns: 1fr;
  }
}
</style>
