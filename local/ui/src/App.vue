<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { ConsoleView } from "@/types/subscription";
import type { RuntimeInfo } from "@/types/runtime";
import SubscriptionsView from "@/views/SubscriptionsView.vue";
import PlaceholderView from "@/views/PlaceholderView.vue";
import RuntimeView from "@/views/RuntimeView.vue";
import EventsView from "@/views/EventsView.vue";

const routableViews: readonly ConsoleView[] = ["runtime", "events", "subscriptions"];
const requestedView = window.location.pathname.split("/").filter(Boolean).at(-1);
const browserAddress = window.location.host;
const activeView = ref<ConsoleView>(
  routableViews.includes(requestedView as ConsoleView)
    ? requestedView as ConsoleView
    : "subscriptions"
);
const runtimeSummary = ref<RuntimeInfo | null>(null);

const views: { key: ConsoleView; label: string; placeholder: boolean }[] = [
  { key: "runtime", label: "Runtime", placeholder: false },
  { key: "events", label: "Events", placeholder: false },
  { key: "agents", label: "Agents", placeholder: true },
  { key: "subscriptions", label: "Subscriptions", placeholder: false },
  { key: "rooms", label: "Rooms", placeholder: true }
];

function setView(view: ConsoleView) {
  activeView.value = view;
  window.history.pushState({}, "", `/console/${view}`);
}

async function loadRuntimeSummary() {
  try {
    const response = await fetch("/api/runtime", { headers: { Accept: "application/json" } });
    if (response.ok) runtimeSummary.value = await response.json() as RuntimeInfo;
  } catch {
    runtimeSummary.value = null;
  }
}

onMounted(loadRuntimeSummary);
</script>

<template>
  <div class="console">
    <header>
      <div class="header-inner">
        <div class="brand">
          <div class="brand-dot"></div>
          Rollerskate Console
        </div>
        <nav class="console-nav">
          <a
            v-for="item in views"
            :key="item.key"
            href="#"
            :class="{ active: activeView === item.key, placeholder: item.placeholder }"
            @click.prevent="!item.placeholder && setView(item.key)"
          >
            {{ item.label }}
          </a>
        </nav>
      </div>
      <div class="runtime-strip">
        <div class="runtime-strip-inner">
          <span>Runtime <strong>v{{ runtimeSummary?.version ?? "unknown" }}</strong></span>
          <span>Local loop <span class="status-pill" :class="runtimeSummary?.status === 'running' ? 'ok' : 'degraded'">{{ runtimeSummary?.status ?? "unavailable" }}</span></span>
          <span>UI <strong>{{ runtimeSummary?.consoleAddress ?? browserAddress }}</strong></span>
          <span>Polling <span class="status-pill ok">core managed</span></span>
        </div>
      </div>
    </header>

    <main>
      <SubscriptionsView v-if="activeView === 'subscriptions'" />
      <RuntimeView v-else-if="activeView === 'runtime'" />
      <EventsView v-else-if="activeView === 'events'" />
      <PlaceholderView v-else :title="activeView" />
    </main>
  </div>
</template>

<style>
:root {
  --bg: #f6f7f9;
  --surface: #ffffff;
  --surface-2: #f8f9fb;
  --text: #1f2329;
  --text-secondary: #5f6b7a;
  --text-dim: #9aa3b2;
  --border: #e1e4e8;
  --primary: #2563eb;
  --primary-soft: #eff6ff;
  --success: #16a34a;
  --success-soft: #f0fdf4;
  --warning: #d97706;
  --warning-soft: #fffbeb;
  --danger: #dc2626;
  --danger-soft: #fef2f2;
  --muted: #6b7280;
  --muted-soft: #f3f4f6;
  --shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  --shadow-lg: 0 10px 25px rgba(0, 0, 0, 0.1);
  --radius: 10px;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.55;
  font-size: 14px;
}

header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 10;
}

.header-inner {
  max-width: 1500px;
  margin: 0 auto;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 32px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  font-size: 17px;
  flex-shrink: 0;
}

.brand-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-soft);
}

.console-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 4px;
}

.console-nav a {
  padding: 9px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-secondary);
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
  letter-spacing: 0.01em;
}

.console-nav a:hover {
  background: var(--bg);
  color: var(--text);
}

.console-nav a.active {
  background: var(--primary);
  color: #fff;
  box-shadow: 0 2px 6px rgba(37, 99, 235, 0.35);
}

.console-nav a.placeholder {
  color: var(--text-dim);
  cursor: not-allowed;
}

.console-nav a.placeholder:hover {
  background: transparent;
  color: var(--text-dim);
}

.runtime-strip {
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}

.runtime-strip-inner {
  max-width: 1500px;
  margin: 0 auto;
  padding: 8px 24px;
  display: flex;
  gap: 22px;
  font-size: 12px;
  color: var(--text-secondary);
  flex-wrap: wrap;
}

.runtime-strip-inner span strong {
  color: var(--text);
  font-weight: 600;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.status-pill::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.status-pill.ok::before {
  background: var(--success);
}

.status-pill.degraded::before {
  background: var(--warning);
}

.status-pill.down::before {
  background: var(--danger);
}

main {
  padding: 20px 24px 40px;
}

.panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
}

.panel-header {
  padding: 12px 16px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
}

.section-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--text-secondary);
  margin: 22px 0 10px;
  font-weight: 700;
}

.section-title:first-child {
  margin-top: 0;
}

.mono {
  font-family: var(--mono);
  font-size: 12px;
}

.secret {
  color: var(--text-secondary);
  font-style: italic;
}

.kv {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 6px 14px;
  font-size: 13px;
}

.kv dt {
  color: var(--text-secondary);
  font-weight: 500;
}

.kv dd {
  margin: 0;
  word-break: break-word;
}

@media (max-width: 1100px) {
  .header-inner {
    flex-wrap: wrap;
    gap: 16px;
  }

  .console-nav {
    order: 3;
    width: 100%;
    min-width: 0;
    overflow-x: auto;
  }
}

@media (max-width: 600px) {
  .header-inner,
  .runtime-strip-inner {
    padding-left: 12px;
    padding-right: 12px;
  }

  .console-nav a {
    padding: 7px 9px;
    font-size: 12px;
  }

  main {
    padding: 14px 12px 28px;
  }
}
</style>
