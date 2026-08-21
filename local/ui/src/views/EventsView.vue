<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import {
  runtimeAuditSchema,
  runtimeAuditsSchema,
  runtimeInfoSchema
} from "@/api/schema";
import { useApi } from "@/composables/useApi";
import EventAuditPanel from "@/components/EventAuditPanel.vue";
import EventList from "@/components/EventList.vue";

const route = useRoute();
const initialEventId = Array.isArray(route.query.eventId)
  ? route.query.eventId[0]
  : route.query.eventId;

const eventsQuery = useApi({
  url: "/api/events",
  schema: runtimeAuditsSchema,
  interval: 3_000
});
const runtimeQuery = useApi({
  url: "/api/runtime",
  schema: runtimeInfoSchema,
  interval: 5_000
});
const audits = computed(() => eventsQuery.data.value ?? []);
const runtime = runtimeQuery.data;
const selectedEventId = ref(initialEventId ?? "");
const detailPaused = computed(() => selectedEventId.value === "");
const detailQuery = useApi({
  url: computed(() => `/api/events/${encodeURIComponent(selectedEventId.value)}`),
  schema: runtimeAuditSchema,
  interval: 3_000,
  paused: detailPaused,
  immediate: false
});
const apiError = computed(() =>
  eventsQuery.error.value ?? runtimeQuery.error.value ?? detailQuery.error.value);
const loading = computed(() =>
  eventsQuery.loading.value || runtimeQuery.loading.value ||
  (selectedEventId.value !== "" && detailQuery.loading.value));

const runtimePaused = computed(() => runtime.value?.status === "paused");
const runtimeStale = computed(() => runtime.value?.stale ?? false);

const selected = computed(() => {
  const detail = detailQuery.data.value;
  return detail?.event.eventId === selectedEventId.value ? detail : undefined;
});

watch(audits, (next) => {
  if (selectedEventId.value === "" && next.length > 0) {
    selectedEventId.value = next[0]!.event.eventId;
  }
}, { immediate: true });

watch(selectedEventId, (next) => {
  if (next !== "") void detailQuery.refresh();
}, { immediate: true });

function selectEvent(id: string) {
  selectedEventId.value = id;
}

function refresh() {
  void Promise.all([
    eventsQuery.refresh(),
    runtimeQuery.refresh(),
    ...(selectedEventId.value === "" ? [] : [detailQuery.refresh()])
  ]);
}
</script>

<template>
  <div class="events-layout layout-base layout-two-pane">
    <EventList
      :audits="audits"
      :selected-id="selectedEventId"
      :loading="loading"
      :error="apiError"
      :runtime-paused="runtimePaused"
      :runtime-stale="runtimeStale"
      @select="selectEvent"
      @refresh="refresh"
    />

    <EventAuditPanel :audit="selected" />
  </div>
</template>

<style scoped>
.events-layout { grid-template-columns: minmax(360px, 0.95fr) minmax(520px, 1.55fr); }
@media (max-width: 1100px) {
  .events-layout { grid-template-columns: minmax(0, 1fr); }
  .events-layout > * { min-width: 0; }
}
</style>
