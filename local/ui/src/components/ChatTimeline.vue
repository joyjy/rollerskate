<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { formatDateTime } from "@/utils/format";
import ChatReadProgress from "./ChatReadProgress.vue";
import type { ChatListItem, ChatTimelineMessage } from "@/types/chat";
import type { LocalAgent } from "@/types/local";

const props = defineProps<{
  chat: ChatListItem | null;
  messages: readonly ChatTimelineMessage[];
  activeAgents: readonly LocalAgent[];
  currentHumanId?: string;
  allowReply?: boolean;
  allowWorkHandoff?: boolean;
}>();

const emit = defineEmits<{
  reply: [message: ChatTimelineMessage];
  handoff: [message: ChatTimelineMessage];
}>();

type TimelineItem =
  | { kind: "message"; message: ChatTimelineMessage }
  | { kind: "system"; message: ChatTimelineMessage };

const timelineItems = computed<TimelineItem[]>(() => {
  return props.messages.map((message) => ({
    kind: message.sender.kind === "system" ? "system" : "message",
    message
  }));
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

function senderLabel(message: ChatTimelineMessage) {
  if (message.sender.kind === "owner") return "You";
  if (message.sender.kind === "human" &&
    message.sender.principalId === props.currentHumanId) {
    return `${message.sender.handleSnapshot} · You`;
  }
  return message.sender.handleSnapshot;
}

function referencedMessage(message: ChatTimelineMessage) {
  return message.replyToEventId === undefined
    ? undefined
    : props.messages.find((candidate) => candidate.eventId === message.replyToEventId);
}

function scrollToMessage(eventId: string) {
  const target = Array.from(
    timeline.value?.querySelectorAll<HTMLElement>("[data-event-id]") ?? []
  )
    .find((element) => element.dataset.eventId === eventId);
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
  target?.focus({ preventScroll: true });
}

watch(() => props.messages.length, async () => {
  await nextTick();
  if (isNearBottom()) scrollToBottom();
});

onMounted(() => scrollToBottom());

defineExpose({ scrollToBottom, scrollToMessage });
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

  <div v-if="messages.length === 0" class="state">
    <strong>{{ chat?.kind === "server" ? "No messages yet." : "Local is ready." }}</strong>
    <div v-if="chat?.kind === 'server'">This Topic is visible to you even before an Agent joins.</div>
    <div v-else>Mention an Agent, or send freely to the Agents who are listening.</div>
  </div>
  <div v-else ref="timeline" class="timeline" aria-live="polite">
    <template v-for="item in timelineItems" :key="item.message.eventId">
      <article
        v-if="item.kind === 'message'"
        class="message"
        :class="item.message.sender.kind"
        :data-event-id="item.message.eventId"
        tabindex="-1"
      >
        <div class="avatar">{{ item.message.sender.handleSnapshot.slice(0, 1).toUpperCase() }}</div>
        <div class="message-content">
          <div class="message-head">
            <strong>{{ senderLabel(item.message) }}</strong>
            <div class="message-meta">
              <span>{{ formatDateTime(item.message.createdAt) }}</span>
              <button
                v-if="allowReply"
                type="button"
                class="reply-action"
                @click="emit('reply', item.message)"
              >Reply</button>
              <button
                v-if="allowWorkHandoff && item.message.sender.kind === 'owner'"
                type="button"
                class="handoff-action"
                @click="emit('handoff', item.message)"
              >Hand off to Run</button>
              <ChatReadProgress
                v-if="item.message.sender.kind === 'owner' && item.message.readProgress"
                :progress="item.message.readProgress"
              />
            </div>
          </div>
          <button
            v-if="item.message.replyToEventId"
            type="button"
            class="reply-reference"
            :disabled="referencedMessage(item.message) === undefined"
            @click="scrollToMessage(item.message.replyToEventId)"
          >
            <strong>{{ referencedMessage(item.message)?.sender.handleSnapshot ?? "Referenced message" }}</strong>
            <span>{{ referencedMessage(item.message)?.body ?? "Message not in loaded history" }}</span>
          </button>
          <p>{{ item.message.body }}</p>
          <div v-if="item.message.targets" class="target-chip">
            to {{ item.message.targets.map((target) => `@${target.handleSnapshot}`).join(", ") }}
          </div>
        </div>
      </article>

      <div v-else-if="item.kind === 'system'" class="system-message">
        <div class="system-card">
          <span>{{ item.message.body }}</span>
        </div>
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
.message:focus { outline: 2px solid var(--primary-soft); outline-offset: -2px; }
.reply-action, .handoff-action {
  border: 0; background: transparent; color: var(--primary); cursor: pointer; opacity: 0; padding: 0;
}
.message:hover .reply-action, .message:focus-within .reply-action,
.message:hover .handoff-action, .message:focus-within .handoff-action { opacity: 1; }
.reply-reference {
  display: grid; gap: 2px; width: 100%; margin: 6px 0; padding: 7px 9px;
  border: 0; border-left: 3px solid var(--primary); border-radius: 4px;
  background: var(--surface-2); color: var(--text-secondary); text-align: left; cursor: pointer;
}
.reply-reference span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reply-reference:disabled { cursor: default; }
.avatar {
  width: 34px; height: 34px; display: grid; place-items: center;
  border-radius: 8px; background: var(--muted-soft); color: var(--text-secondary); font-weight: 800;
}
.message.agent .avatar { background: var(--success-soft); color: var(--success); }
.message.human .avatar { background: var(--primary-soft); color: var(--primary); }
.message-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.message-head span { color: var(--text-dim); font-size: 11px; }
.message-meta { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
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
