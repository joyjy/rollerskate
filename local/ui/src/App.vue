<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { ConsoleView } from "@/types/subscription";
import type { RuntimeInfo } from "@/types/runtime";
import type { LocalSnapshot } from "@/types/local";
import SubscriptionsView from "@/views/SubscriptionsView.vue";
import RuntimeView from "@/views/RuntimeView.vue";
import EventsView from "@/views/EventsView.vue";
import AgentsView from "@/views/AgentsView.vue";
import ChatsView from "@/views/ChatsView.vue";

const routableViews: readonly ConsoleView[] = [
  "runtime", "events", "agents", "chats", "subscriptions"
];
function viewFromPath(): ConsoleView | null {
  const requestedView = window.location.pathname.split("/").filter(Boolean).at(-1);
  return routableViews.includes(requestedView as ConsoleView)
    ? requestedView as ConsoleView
    : null;
}

const explicitView = viewFromPath();
const browserAddress = window.location.host;
const activeView = ref<ConsoleView | null>(explicitView);
const runtimeSummary = ref<RuntimeInfo | null>(null);

const views: { key: ConsoleView; label: string }[] = [
  { key: "runtime", label: "Runtime" },
  { key: "events", label: "Events" },
  { key: "agents", label: "Agents" },
  { key: "chats", label: "Chats" },
  { key: "subscriptions", label: "Subscriptions" }
];

function setView(view: ConsoleView) {
  activeView.value = view;
  window.history.pushState({}, "", `/console/${view}`);
}

function syncViewFromHistory() {
  const view = viewFromPath();
  if (view !== null) activeView.value = view;
}

async function loadRuntimeSummary() {
  try {
    const response = await fetch("/api/runtime", { headers: { Accept: "application/json" } });
    if (response.ok) runtimeSummary.value = await response.json() as RuntimeInfo;
  } catch {
    runtimeSummary.value = null;
  }
}

async function selectInitialView() {
  if (explicitView !== null) return;
  try {
    const response = await fetch("/api/local", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Local HTTP ${response.status}`);
    const local = await response.json() as LocalSnapshot;
    activeView.value = local.agents.some((agent) => agent.status === "active")
      ? "chats"
      : "agents";
  } catch {
    activeView.value = "agents";
  }
  window.history.replaceState({}, "", `/console/${activeView.value}`);
}

onMounted(() => {
  window.addEventListener("popstate", syncViewFromHistory);
  void loadRuntimeSummary();
  void selectInitialView();
});

onBeforeUnmount(() => {
  window.removeEventListener("popstate", syncViewFromHistory);
});
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
          <button
            v-for="item in views"
            :key="item.key"
            type="button"
            class="nav-tab"
            :class="{ active: activeView === item.key }"
            @click="setView(item.key)"
          >
            {{ item.label }}
          </button>
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
      <div v-if="activeView === null" class="app-loading">Starting Local Console…</div>
      <RuntimeView v-else-if="activeView === 'runtime'" />
      <EventsView v-else-if="activeView === 'events'" />
      <AgentsView v-else-if="activeView === 'agents'" @agent-added="setView('chats')" />
      <ChatsView v-else-if="activeView === 'chats'" />
      <SubscriptionsView v-else />
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

.console-nav .nav-tab {
  padding: 9px 20px;
  border: 0;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  letter-spacing: 0.01em;
}

.console-nav .nav-tab:hover {
  background: var(--bg);
  color: var(--text);
}

.console-nav .nav-tab.active {
  background: var(--primary);
  color: #fff;
  box-shadow: 0 2px 6px rgba(37, 99, 235, 0.35);
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

.app-loading {
  max-width: 1120px;
  margin: 80px auto;
  color: var(--text-secondary);
  text-align: center;
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

.panel-body {
  padding: 20px;
}

.primary-button {
  appearance: none;
  border: 1px solid var(--primary);
  background: var(--primary);
  color: #fff;
  padding: 9px 18px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.primary-button:hover:not(:disabled) {
  background: #1d4ed8;
}

.primary-button:disabled {
  opacity: .55;
  cursor: not-allowed;
}

.secondary-button {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  padding: 7px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.secondary-button:hover:not(:disabled) {
  background: var(--surface-2);
}

.secondary-button:disabled {
  opacity: .55;
  cursor: not-allowed;
}

.secondary-button.danger {
  color: var(--danger);
  border-color: var(--danger);
}

.secondary-button.warning {
  color: var(--warning);
  border-color: var(--warning);
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.state {
  padding: 28px 18px;
  color: var(--text-secondary);
  text-align: center;
}

.state.error {
  color: var(--danger);
}

.empty-inline {
  padding: 12px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  color: var(--text-secondary);
}

.inline-error {
  padding: 10px 12px;
  margin-bottom: 14px;
  border-radius: 6px;
  color: var(--danger);
  background: var(--danger-soft);
  border: 1px solid #fecaca;
  font-size: 13px;
}

.list-banner {
  padding: 8px 12px;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}

.list-banner.stale {
  background: var(--warning-soft);
  color: var(--warning);
}

.list-banner.paused {
  background: var(--muted-soft);
  color: var(--muted);
}

.list-banner.new-events {
  background: var(--primary-soft);
  color: var(--primary);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.system-card {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 5px 0;
  color: var(--text-secondary);
  font-size: 12px;
}

.system-card::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--primary);
}

.system-card.success { color: var(--success); }
.system-card.success::before { background: var(--success); }
.system-card strong { color: var(--text); font-weight: 600; }

.layout-base {
  max-width: 1500px;
  margin: 0 auto;
  display: grid;
  gap: 18px;
  align-items: start;
}

.layout-base.narrow { max-width: 1120px; }
.layout-base.gap-lg { gap: 20px; }

.layout-two-pane { grid-template-columns: minmax(360px, 0.95fr) minmax(520px, 1.55fr); }
.layout-two-pane-compact { grid-template-columns: minmax(300px, 0.9fr) minmax(420px, 1.1fr); }
.layout-three-pane { grid-template-columns: 260px 1fr 280px; }
.layout-three-pane-wide { grid-template-columns: 280px 1fr 300px; }

@media (max-width: 1100px) {
  .layout-two-pane,
  .layout-two-pane-compact,
  .layout-three-pane,
  .layout-three-pane-wide { grid-template-columns: 1fr; }
}

@media (max-width: 768px) {
  .layout-three-pane,
  .layout-three-pane-wide { grid-template-columns: 1fr; }
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

  .console-nav .nav-tab {
    padding: 7px 9px;
    font-size: 12px;
  }

  main {
    padding: 14px 12px 28px;
  }
}
</style>
