<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { requestJson } from "@/api/client";
import {
  subscriptionArchiveResponseSchema,
  subscriptionSchema,
  subscriptionsSchema
} from "@/api/schema";
import { useApi } from "@/composables/useApi";
import { useMutation } from "@/composables/useMutation";
import SubscriptionList from "@/components/SubscriptionList.vue";
import SubscriptionTrace from "@/components/SubscriptionTrace.vue";
import QuickHint from "@/components/QuickHint.vue";
import ListControls from "@/components/ListControls.vue";
import PaginationControls from "@/components/PaginationControls.vue";

const route = useRoute();
const router = useRouter();
const initialSubscriptionId = Array.isArray(route.query.subscriptionId)
  ? route.query.subscriptionId[0]
  : route.query.subscriptionId;

const selectedId = ref(initialSubscriptionId ?? "");
const mutationPaused = ref(false);
const archivedView = ref(false);
const searchQuery = ref("");
const currentPage = ref(1);
const PAGE_SIZE = 20;
const subscriptionsUrl = computed(() => {
  const parameters = new URLSearchParams({
    page: String(currentPage.value),
    pageSize: String(PAGE_SIZE),
    archive: archivedView.value ? "archived" : "current"
  });
  if (searchQuery.value.trim() !== "") parameters.set("q", searchQuery.value.trim());
  return `/api/subscriptions?${parameters}`;
});
const { data, loading, error: loadError, refresh: refreshSubscriptions } = useApi({
  url: subscriptionsUrl,
  schema: subscriptionsSchema,
  interval: 3_000,
  paused: mutationPaused
});
const subscriptions = computed(() => data.value?.items ?? []);
const total = computed(() => data.value?.total ?? 0);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const detailUrl = computed(() =>
  `/api/subscriptions/${encodeURIComponent(selectedId.value || "__unselected__")}`);
const selectedQuery = useApi({
  url: detailUrl,
  schema: subscriptionSchema,
  interval: 3_000,
  paused: mutationPaused,
  immediate: false
});
const selected = selectedQuery.data;
watch(subscriptions, (next) => {
  if (selectedId.value === "" && next.length > 0) {
    selectedId.value = next[0]!.id;
  }
}, { immediate: true });
watch(selectedId, (next) => {
  selectedQuery.data.value = null;
  if (next === "") {
    void router.replace({ name: "subscriptions" });
    return;
  }
  void router.replace({ name: "subscriptions", query: { subscriptionId: next } });
  void selectedQuery.refresh();
}, { immediate: true });

watch([searchQuery, archivedView], async () => {
  currentPage.value = 1;
  data.value = null;
  selectedQuery.data.value = null;
  selectedId.value = "";
  await refreshSubscriptions();
  selectedId.value = subscriptions.value[0]?.id ?? "";
});

watch(currentPage, async () => {
  await refreshSubscriptions();
  if (!subscriptions.value.some((subscription) => subscription.id === selectedId.value)) {
    selectedQuery.data.value = null;
    selectedId.value = subscriptions.value[0]?.id ?? "";
  }
});
watch(pageCount, (next) => {
  currentPage.value = Math.min(currentPage.value, next);
});
async function refreshAll() {
  await Promise.all([refreshSubscriptions(), selectedQuery.refresh()]);
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
const archiveMutation = useMutation({
  async execute(input: { id: string; archived: boolean }, signal) {
    return requestJson(
      `/api/subscriptions/${encodeURIComponent(input.id)}/${input.archived ? "archive" : "unarchive"}`,
      subscriptionArchiveResponseSchema,
      {
        method: "POST",
        headers: { "X-Rollerskate-Request": "console" },
        signal
      }
    );
  }
});
const error = computed(() =>
  actionMutation.error.value ?? archiveMutation.error.value ??
  selectedQuery.error.value ?? loadError.value);

function onSelect(id: string) {
  selectedId.value = id;
}

async function act(action: "pause" | "resume" | "cancel") {
  if (!selected.value) return;
  mutationPaused.value = true;
  await actionMutation.execute({ id: selected.value.id, action });
  mutationPaused.value = false;
}

async function setArchived(archived: boolean) {
  if (!selected.value) return;
  mutationPaused.value = true;
  try {
    const result = await archiveMutation.execute({ id: selected.value.id, archived });
    if (result === null) return;
    selectedQuery.data.value = null;
    selectedId.value = "";
    await refreshSubscriptions();
    if (subscriptions.value.length === 0 && currentPage.value > 1) {
      currentPage.value -= 1;
      await refreshSubscriptions();
    }
    selectedId.value = subscriptions.value[0]?.id ?? "";
  } finally {
    mutationPaused.value = false;
  }
}

function goToPage(page: number) {
  currentPage.value = Math.min(Math.max(1, page), pageCount.value);
}
</script>

<template>
  <div class="subscriptions-layout layout-base gap-lg layout-three-pane-wide">
    <div class="panel subscriptions-list-panel">
      <ListControls
        title="Subscriptions"
        :total="total"
        :search="searchQuery"
        :archived="archivedView"
        :busy="archiveMutation.pending.value"
        @update:search="searchQuery = $event"
        @toggle-archive="archivedView = !archivedView"
      />
      <div v-if="loading && subscriptions.length === 0" class="state">Loading Subscriptions…</div>
      <div v-else-if="subscriptions.length === 0" class="state">
        {{ archivedView ? "No archived Subscription." : "No Subscription is registered." }}
      </div>
      <SubscriptionList
        v-else
        :subscriptions="subscriptions"
        :selected-id="selectedId"
        @select="onSelect"
      />
      <PaginationControls
        :page="currentPage"
        :page-size="PAGE_SIZE"
        :total="total"
        @page="goToPage"
      />
    </div>

    <div class="panel">
      <div v-if="selectedQuery.loading.value && !selected" class="state">Loading Subscription…</div>
      <div v-else-if="error && !selected" class="state error" role="alert">{{ error }}</div>
      <SubscriptionTrace v-else-if="selected" :subscription="selected" />
      <div v-else class="state">Select a Subscription.</div>
    </div>

    <div class="panel">
      <div class="panel-header">Quick Hint</div>
      <QuickHint v-if="selected"
        :subscription="selected"
        :busy="actionMutation.pending.value || archiveMutation.pending.value"
        :error="error"
        @action="act"
        @archive="setArchived"
      />
      <div v-else class="state">No Subscription selected.</div>
    </div>
  </div>
</template>

<style scoped>
.subscriptions-layout { grid-template-columns: 280px 1fr 300px; }
.subscriptions-list-panel { min-height: 0; display: flex; flex-direction: column; }

@media (max-width: 1100px) {
  .subscriptions-layout {
    grid-template-columns: 1fr;
  }
}
</style>
