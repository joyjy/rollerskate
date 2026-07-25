<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink, RouterView, useRouter } from "vue-router";

import { runtimeInfoSchema } from "@/api/schema";
import { useApi } from "@/composables/useApi";
import NoticeCenter from "@/components/NoticeCenter.vue";

const browserAddress = window.location.host;
const router = useRouter();
const headerElement = ref<HTMLElement | null>(null);
let headerObserver: ResizeObserver | null = null;
const runtimeQuery = useApi({
  url: "/api/runtime",
  schema: runtimeInfoSchema,
  interval: 5_000
});
const runtimeSummary = runtimeQuery.data;
const runtimeSummaryError = runtimeQuery.error;
const views = [
  { key: "runtime", label: "Runtime" },
  { key: "events", label: "Events" },
  { key: "agents", label: "Agents" },
  { key: "chats", label: "Chats" },
  { key: "reviews", label: "Reviews" },
  { key: "schedules", label: "Schedules" },
  { key: "subscriptions", label: "Subscriptions" }
] as const;

function syncHeaderBottom(): void {
  const bottom = headerElement.value?.getBoundingClientRect().bottom ?? 0;
  document.documentElement.style.setProperty(
    "--console-header-bottom",
    `${Math.max(0, bottom)}px`
  );
}

onMounted(() => {
  syncHeaderBottom();
  window.addEventListener("resize", syncHeaderBottom);
  if (typeof ResizeObserver !== "undefined" && headerElement.value !== null) {
    headerObserver = new ResizeObserver(syncHeaderBottom);
    headerObserver.observe(headerElement.value);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", syncHeaderBottom);
  headerObserver?.disconnect();
  document.documentElement.style.removeProperty("--console-header-bottom");
});
</script>

<template>
  <div class="console">
    <header ref="headerElement">
      <div class="header-inner">
        <div class="brand">
          <div class="brand-dot"></div>
          Rollerskate Console
        </div>
        <nav class="console-nav" aria-label="Console views">
          <RouterLink
            v-for="item in views"
            :key="item.key"
            :to="{ name: item.key }"
            class="nav-tab"
            active-class="active"
          >
            {{ item.label }}
          </RouterLink>
        </nav>
        <NoticeCenter />
      </div>
      <div class="runtime-strip">
        <div class="runtime-strip-inner">
          <span v-if="runtimeSummaryError" class="runtime-strip-error" role="alert">
            Runtime status unavailable: {{ runtimeSummaryError }}
          </span>
          <span>Runtime <strong>v{{ runtimeSummary?.version ?? "unknown" }}</strong></span>
          <span>Local loop <span class="status-pill" :class="runtimeSummary?.status === 'running' ? 'ok' : 'degraded'">{{ runtimeSummary?.status ?? "unavailable" }}</span></span>
          <span>UI <strong>{{ runtimeSummary?.consoleAddress ?? browserAddress }}</strong></span>
          <span>Polling <span class="status-pill ok">core managed</span></span>
        </div>
      </div>
    </header>

    <main>
      <RouterView v-slot="{ Component }">
        <component
          :is="Component"
          @agent-added="router.push({ name: 'chats' })"
        />
      </RouterView>
    </main>
  </div>
</template>
