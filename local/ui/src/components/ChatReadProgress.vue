<script setup lang="ts">
import { computed } from "vue";
import type { ChatReadProgress } from "@/types/local";

const props = defineProps<{
  progress: ChatReadProgress;
}>();

const degrees = computed(() =>
  props.progress.total === 0
    ? 0
    : Math.round((props.progress.read / props.progress.total) * 360)
);

const label = computed(() =>
  `${props.progress.read} of ${props.progress.total} Agents read this message`
);

function stateLabel(state: ChatReadProgress["agents"][number]["state"]): string {
  switch (state) {
    case "read": return "Read";
    case "reading": return "Reading";
    case "failed": return "Failed";
    case "unread": return "Unread";
  }
}
</script>

<template>
  <details v-if="progress.total > 0" class="read-progress">
    <summary :aria-label="label" :title="label">
      <span
        class="progress-ring"
        :style="{ '--read-degrees': `${degrees}deg` }"
        aria-hidden="true"
      />
      <span class="sr-only">{{ label }}</span>
    </summary>
    <div class="progress-detail" role="status">
      <strong>{{ progress.read }}/{{ progress.total }} read</strong>
      <ul>
        <li v-for="agent in progress.agents" :key="agent.agentId">
          <span class="agent">@{{ agent.handleSnapshot }}</span>
          <span class="agent-state" :class="agent.state">
            {{ stateLabel(agent.state) }}<template v-if="agent.failureReason"> · {{ agent.failureReason }}</template>
          </span>
        </li>
      </ul>
    </div>
  </details>
</template>

<style scoped>
.read-progress {
  position: relative;
  display: inline-flex;
}
.read-progress summary {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin: -4px;
  border-radius: 6px;
  cursor: pointer;
  list-style: none;
}
.read-progress summary::-webkit-details-marker { display: none; }
.read-progress summary:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
.progress-ring {
  --read-degrees: 0deg;
  position: relative;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: conic-gradient(
    var(--success) 0 var(--read-degrees),
    var(--border) var(--read-degrees) 360deg
  );
}
.progress-ring::after {
  content: "";
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: var(--surface);
}
.progress-detail {
  position: absolute;
  z-index: 20;
  top: 22px;
  right: -4px;
  min-width: 190px;
  padding: 10px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 8px 24px rgb(15 23 42 / 12%);
  color: var(--text);
  font-size: 12px;
}
.read-progress:not([open]):not(:hover):not(:focus-within) .progress-detail {
  display: none;
}
.progress-detail strong {
  display: block;
  margin-bottom: 6px;
}
.progress-detail ul {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.progress-detail li {
  display: flex;
  justify-content: space-between;
  gap: 14px;
}
.agent { color: var(--text-secondary); }
.agent-state { max-width: 260px; font-weight: 700; text-align: right; overflow-wrap: anywhere; }
.agent-state.read { color: var(--success); }
.agent-state.reading { color: var(--primary); }
.agent-state.failed { color: var(--danger); }
.agent-state.unread { color: var(--text-dim); }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
