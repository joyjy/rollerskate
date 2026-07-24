<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { formatDateTime } from "@/utils/format";
import DispatchCard from "./DispatchCard.vue";
import type { ChatListItem } from "@/types/chat";
import type { LocalAgent } from "@/types/local";
import type { RuntimeEvent } from "@/types/runtime";

const props = defineProps<{
  chat: ChatListItem | null;
  events: readonly RuntimeEvent[];
  agents: readonly LocalAgent[];
  activeAgents: readonly LocalAgent[];
  pending: string | null;
}>();

const emit = defineEmits<{
  (e: "dispatch", sourceMessageEventId: string, principalId: string): void;
}>();

type TimelineItem =
  | { kind: "message"; event: RuntimeEvent }
  | { kind: "system"; event: RuntimeEvent }
  | { kind: "dispatch"; event: RuntimeEvent };

const timelineItems = computed<TimelineItem[]>(() => {
  const items: TimelineItem[] = [];
  const inlineSourceIds = new Set<string>();

  for (const event of props.events) {
    if (event.type === "chat.message") {
      const isSystem = event.sender?.kind === "system";
      items.push({ kind: isSystem ? "system" : "message", event });
      if (event.dispatchCard) {
        inlineSourceIds.add(event.dispatchCard.sourceMessageEventId);
      }
    } else if (event.type === "chat.dispatch") {
      const sourceId = event.sourceMessageEventId;
      if (!sourceId || !inlineSourceIds.has(sourceId)) {
        items.push({ kind: "dispatch", event });
      }
    }
  }
  return items;
});

const timeline = ref<HTMLElement | null>(null);

function scrollToBottom() {
  const el = timeline.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

function isNearBottom() {
  const el = timeline.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

watch(() => props.events.length, async () => {
  await nextTick();
  if (isNearBottom()) scrollToBottom();
});

onMounted(() => scrollToBottom());

defineExpose({ scrollToBottom });
</script>

<template>
  <div class="chat-header">
    <div class="chat-title">
      <div class="eyebrow">{{ chat?.kind === "server" ? "Server Topic" : "Local Topic" }}</div>
      <h1>{{ chat?.handle ?? "—" }}</h1>
    </div>
    <div class="chat-header-meta">
      <span>{{ activeAgents.length }} active Agent{{ activeAgents.length === 1 ? "" : "s" }}</span>
      <span class="status-dot">{{ chat?.kind === "server" ? "server" : "local only" }}</span>
    </div>
  </div>

  <div v-if="events.length === 0" class="state">
    <strong>Local is ready.</strong>
    <div>Mention an Agent, or send without a mention and choose from the dispatch card.</div>
  </div>
  <div v-else ref="timeline" class="timeline" aria-live="polite">
    <template v-for="item in timelineItems" :key="item.event.eventId">
      <article v-if="item.kind === 'message'" class="message" :class="item.event.sender?.kind">
        <div class="avatar">{{ item.event.sender?.handleSnapshot.slice(0, 1).toUpperCase() }}</div>
        <div class="message-content">
          <div class="message-head">
            <strong>{{ item.event.sender?.kind === "owner" ? "You" : item.event.sender?.handleSnapshot }}</strong>
            <span>{{ formatDateTime(item.event.createdAt) }}</span>
          </div>
          <p>{{ item.event.body }}</p>
          <div v-if="item.event.target" class="target-chip">to @{{ item.event.target.handleSnapshot }}</div>
          <DispatchCard
            :event="item.event"
            :events="events"
            :agents="agents"
            :pending="pending"
            @dispatch="(sourceId, principalId) => emit('dispatch', sourceId, principalId)"
          />

        </div>
      </article>

      <div v-else-if="item.kind === 'system'" class="system-message">
        <div class="system-card">
          <span>{{ item.event.body }}</span>
        </div>
        <DispatchCard
          :event="item.event"
          :events="events"
          :agents="agents"
          :compact="true"
          :pending="pending"
          @dispatch="(sourceId, principalId) => emit('dispatch', sourceId, principalId)"
        />
      </div>

      <div v-else-if="item.kind === 'dispatch'" class="system-card">
        Dispatched to <strong>@{{ item.event.targetHandleSnapshot }}</strong>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-shrink: 0;
}
.chat-title h1 { margin: 0; font-size: 20px; line-height: 1.2; }
.eyebrow { color: var(--primary); font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.chat-header-meta { display: flex; gap: 12px; color: var(--text-secondary); font-size: 12px; }
.status-dot::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 5px; border-radius: 50%; background: var(--success); }
.timeline { flex: 1; overflow-y: auto; padding: 16px 20px; }
.message {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.avatar {
  width: 34px; height: 34px; display: grid; place-items: center;
  border-radius: 8px; background: var(--muted-soft); color: var(--text-secondary); font-weight: 800;
}
.message.agent .avatar { background: var(--success-soft); color: var(--success); }
.message-head { display: flex; align-items: baseline; gap: 8px; }
.message-head span { color: var(--text-dim); font-size: 11px; }
.message p { margin: 3px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.target-chip {
  display: inline-block;
  margin-top: 7px;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 11px;
  font-weight: 700;
}
.system-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
}
</style>
