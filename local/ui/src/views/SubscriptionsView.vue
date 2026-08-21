<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { requestJson } from "@/api/client";
import { subscriptionSchema, subscriptionsSchema } from "@/api/schema";
import { useApi } from "@/composables/useApi";
import { useMutation } from "@/composables/useMutation";
import SubscriptionList from "@/components/SubscriptionList.vue";
import SubscriptionTrace from "@/components/SubscriptionTrace.vue";
import QuickHint from "@/components/QuickHint.vue";

const route = useRoute();
const initialSubscriptionId = Array.isArray(route.query.subscriptionId)
  ? route.query.subscriptionId[0]
  : route.query.subscriptionId;

const selectedId = ref(initialSubscriptionId ?? "");
const mutationPaused = ref(false);
const { data, loading, error: loadError, refresh: refreshSubscriptions } = useApi({
  url: "/api/subscriptions",
  schema: subscriptionsSchema,
  interval: 3_000,
  paused: mutationPaused
});
const subscriptions = computed(() => data.value ?? []);
const selected = computed(() => {
  if (selectedId.value === "") {
    return subscriptions.value[0] ?? null;
  }
  return subscriptions.value.find((item) => item.id === selectedId.value) ?? null;
});
watch(subscriptions, (next) => {
  if (selectedId.value === "" && next.length > 0) {
    selectedId.value = next[0]!.id;
  }
}, { immediate: true });
async function refreshAll() {
  await refreshSubscriptions();
}

const actionMutation = useMutation({
  async execute(input: {
    id: string;
    action: "pause" | "resume" | "cancel";
  }, signal) {
    return requestJson(
      `/api/subscriptions/${encodeURIComponent(input.id)}/${input.action}`,
      subscriptionSchema,
      {
        method: "POST",
        headers: { "X-Rollerskate-Request": "console" },
        signal
      }
    );
  },
  refresh: refreshAll
});
const error = computed(() => actionMutation.error.value ?? loadError.value);

function onSelect(id: string) {
  selectedId.value = id;
}

async function act(action: "pause" | "resume" | "cancel") {
  if (!selected.value) return;
  mutationPaused.value = true;
  await actionMutation.execute({ id: selected.value.id, action });
  mutationPaused.value = false;
}
</script>

<template>
  <div v-if="loading" class="state">Loading durable Subscriptions…</div>
  <div v-else-if="error" class="state error" role="alert">Failed to load Subscriptions: {{ error }}</div>
  <div v-else-if="selectedId && !selected" class="state">Subscription {{ selectedId }} not found.</div>
  <div v-else-if="!selected" class="state">No Subscription is registered.</div>
  <div v-else class="subscriptions-layout layout-base gap-lg layout-three-pane-wide">
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
      <QuickHint
        :subscription="selected"
        :busy="actionMutation.pending.value"
        :error="actionMutation.error.value"
        @action="act"
      />
    </div>
  </div>
</template>

<style scoped>
.subscriptions-layout { grid-template-columns: 280px 1fr 300px; }

@media (max-width: 1100px) {
  .subscriptions-layout {
    grid-template-columns: 1fr;
  }
}
</style>
