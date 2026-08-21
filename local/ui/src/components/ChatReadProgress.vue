<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { ChatReadProgress } from "@/types/local";

const props = defineProps<{
  progress: ChatReadProgress;
}>();

const readDegrees = computed(() =>
  props.progress.total === 0
    ? 0
    : Math.round((props.progress.read / props.progress.total) * 360)
);

const reading = computed(() =>
  props.progress.agents.filter((agent) => agent.state === "reading").length
);

const failed = computed(() =>
  props.progress.agents.filter((agent) => agent.state === "failed").length
);

const activeDegrees = computed(() =>
  props.progress.total === 0
    ? 0
    : Math.round(((props.progress.read + reading.value) / props.progress.total) * 360)
);

const resolvedDegrees = computed(() =>
  props.progress.total === 0
    ? 0
    : Math.round(((props.progress.read + reading.value + failed.value) / props.progress.total) * 360)
);

const root = ref<HTMLDetailsElement | null>(null);
const trigger = ref<HTMLElement | null>(null);
const detail = ref<HTMLElement | null>(null);
const opened = ref(false);
const hovering = ref(false);
const detailStyle = ref<Record<string, string>>({ visibility: "hidden" });
const visible = computed(() => opened.value || hovering.value);
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function clearHideTimer() {
  if (hideTimer !== undefined) clearTimeout(hideTimer);
  hideTimer = undefined;
}

function showFromHover() {
  clearHideTimer();
  hovering.value = true;
}

function scheduleHoverHide() {
  clearHideTimer();
  hideTimer = setTimeout(() => {
    hovering.value = false;
    hideTimer = undefined;
  }, 80);
}

function positionDetail() {
  const anchor = trigger.value?.getBoundingClientRect();
  const popover = detail.value?.getBoundingClientRect();
  if (!anchor || !popover) return;

  const edge = 8;
  const gap = 6;
  const roomBelow = window.innerHeight - anchor.bottom;
  const placeBelow = roomBelow >= popover.height + gap || roomBelow >= anchor.top;
  const preferredTop = placeBelow
    ? anchor.bottom + gap
    : anchor.top - popover.height - gap;
  const top = Math.max(edge, Math.min(preferredTop, window.innerHeight - popover.height - edge));
  const left = Math.max(
    edge,
    Math.min(anchor.right - popover.width, window.innerWidth - popover.width - edge)
  );
  detailStyle.value = { top: `${Math.round(top)}px`, left: `${Math.round(left)}px` };
}

function syncOpened() {
  opened.value = root.value?.open ?? false;
}

function startTracking() {
  window.addEventListener("resize", positionDetail);
  window.addEventListener("scroll", positionDetail, true);
}

function stopTracking() {
  window.removeEventListener("resize", positionDetail);
  window.removeEventListener("scroll", positionDetail, true);
}

watch(visible, async (isVisible) => {
  stopTracking();
  if (!isVisible) return;
  await nextTick();
  positionDetail();
  startTracking();
});

onBeforeUnmount(() => {
  clearHideTimer();
  stopTracking();
});

const label = computed(() =>
  `${props.progress.read} of ${props.progress.total} Agents read this message${
    reading.value === 0 ? "" : `; ${reading.value} reading`
  }${failed.value === 0 ? "" : `; ${failed.value} failed`}`
);

function stateLabel(state: ChatReadProgress["agents"][number]["state"]): string {
  switch (state) {
    case "read": return "Done";
    case "reading": return "Reading";
    case "failed": return "Failed";
    case "unread": return "Unread";
  }
}
</script>

<template>
  <details
    v-if="progress.total > 0"
    ref="root"
    class="read-progress"
    @toggle="syncOpened"
    @mouseenter="showFromHover"
    @mouseleave="scheduleHoverHide"
  >
    <summary ref="trigger" :aria-label="label" :title="label">
      <span
        class="progress-ring"
        :style="{
          '--read-degrees': `${readDegrees}deg`,
          '--active-degrees': `${activeDegrees}deg`,
          '--resolved-degrees': `${resolvedDegrees}deg`
        }"
        aria-hidden="true"
      />
      <span class="sr-only">{{ label }}</span>
    </summary>
    <Teleport to="body">
      <div
        v-if="visible"
        ref="detail"
        class="progress-detail"
        :style="detailStyle"
        role="status"
        @mouseenter="showFromHover"
        @mouseleave="scheduleHoverHide"
      >
        <strong>{{ progress.read }}/{{ progress.total }} read</strong>
        <ul>
          <li v-for="agent in progress.agents" :key="agent.agentId">
            <span class="agent">@{{ agent.handleSnapshot }}</span>
            <span
              class="agent-state"
              :class="agent.state"
            >
              {{ stateLabel(agent.state) }}<template v-if="agent.failureReason"> · {{ agent.failureReason }}</template>
            </span>
          </li>
        </ul>
      </div>
    </Teleport>
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
  --active-degrees: 0deg;
  --resolved-degrees: 0deg;
  position: relative;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: conic-gradient(
    var(--success) 0 var(--read-degrees),
    var(--primary) var(--read-degrees) var(--active-degrees),
    var(--danger) var(--active-degrees) var(--resolved-degrees),
    var(--border) var(--resolved-degrees) 360deg
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
  position: fixed;
  z-index: 1000;
  min-width: 190px;
  padding: 10px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 8px 24px rgb(15 23 42 / 12%);
  color: var(--text);
  font-size: 12px;
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
.agent-state.failed {
  color: var(--danger);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
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
