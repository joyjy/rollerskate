<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import ChatList from "@/components/ChatList.vue";
import ChatTimeline from "@/components/ChatTimeline.vue";
import ChatComposer from "@/components/ChatComposer.vue";
import ChatContextPanel from "@/components/ChatContextPanel.vue";
import type { ChatListItem, ChatView } from "@/types/chat";
import type { LocalAgent, LocalChatView } from "@/types/local";

const loading = ref(true);
const error = ref<string | null>(null);
const chatView = ref<ChatView | null>(null);
const selectedId = ref<string>("local");
const composer = ref("");
const pending = ref<string | null>(null);
const chatTimelineRef = ref<InstanceType<typeof ChatTimeline> | null>(null);
let timer: number | undefined;

const chats = computed<ChatListItem[]>(() => {
  const local = chatView.value?.chat;
  const list: ChatListItem[] = [];
  if (local) {
    list.push({
      id: local.topicId,
      kind: "local",
      handle: `#${local.handle}`,
      name: "Local",
      status: "active",
      unreadCount: 0
    });
  }
  // Future server rooms will be appended here from /api/chats.
  return list;
});

const selectedChat = computed(() =>
  chats.value.find((chat) => chat.id === selectedId.value) ?? chats.value[0] ?? null
);

const activeAgents = computed(() =>
  chatView.value?.agents.filter((agent) => agent.status === "active") ?? []
);

async function load(background = false) {
  if (!background) loading.value = true;
  try {
    const response = await fetch("/api/chat", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Chat HTTP ${response.status}`);
    const local = await response.json() as LocalChatView;
    chatView.value = {
      chat: local.chat,
      agents: local.agents,
      events: local.events,
      sessions: local.sessions
    };
    error.value = null;
  } catch (reason) {
    error.value = message(reason);
  } finally {
    if (!background) loading.value = false;
  }
}

function mention(agent: LocalAgent) {
  const token = `@${agent.handle} `;
  if (!composer.value.toLocaleLowerCase().includes(`@${agent.handle.toLocaleLowerCase()}`)) {
    composer.value = `${composer.value}${composer.value && !composer.value.endsWith(" ") ? " " : ""}${token}`;
  }
}

async function send(body: string) {
  const text = body.trim();
  if (!text || pending.value) return;
  pending.value = "send";
  error.value = null;
  try {
    await mutate("/api/chat/messages", { body: text }, 201);
    composer.value = "";
    await load(true);
    await nextTick();
    chatTimelineRef.value?.scrollToBottom();
  } catch (reason) {
    error.value = message(reason);
  } finally {
    pending.value = null;
  }
}

async function dispatch(sourceMessageEventId: string, principalId: string) {
  if (pending.value) return;
  pending.value = sourceMessageEventId;
  error.value = null;
  try {
    await mutate(`/api/chat/messages/${encodeURIComponent(sourceMessageEventId)}/dispatch`, {
      principalId
    });
    await load(true);
    await nextTick();
    chatTimelineRef.value?.scrollToBottom();
  } catch (reason) {
    error.value = message(reason);
  } finally {
    pending.value = null;
  }
}

async function newSession(agent: LocalAgent) {
  if (pending.value) return;
  pending.value = agent.principalId;
  error.value = null;
  try {
    await mutate(`/api/chat/agents/${encodeURIComponent(agent.principalId)}/new-session`);
    await load(true);
  } catch (reason) {
    error.value = message(reason);
  } finally {
    pending.value = null;
  }
}

async function mutate(path: string, body?: object, expected = 200) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Rollerskate-Request": "console"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const result = await response.json() as { error?: string };
  if (response.status !== expected) throw new Error(result.error ?? `HTTP ${response.status}`);
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

onMounted(async () => {
  await load();
  timer = window.setInterval(() => {
    if (!pending.value) void load(true);
  }, 2_000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="chats-page">
    <div v-if="loading" class="state">Loading immutable Chat history…</div>
    <div v-else-if="error && !chatView" class="state error" role="alert">
      Could not load Chats: {{ error }}
      <button class="secondary-button retry" @click="load()">Retry</button>
    </div>
    <div v-else-if="!selectedChat" class="state">No chat available.</div>
    <div v-else class="chats-layout layout-base">
      <section class="panel chat-list-panel">
        <div class="panel-header">Chats</div>
        <ChatList :chats="chats" :selected-id="selectedId" @select="selectedId = $event" />
      </section>

      <section class="panel chat-panel">
        <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
        <ChatTimeline
          ref="chatTimelineRef"
          :chat="selectedChat"
          :events="chatView?.events ?? []"
          :agents="chatView?.agents ?? []"
          :active-agents="activeAgents"
          :pending="pending"
          @dispatch="dispatch"
        />
        <ChatComposer
          v-model="composer"
          :agents="chatView?.agents ?? []"
          :active-agents="activeAgents"
          :pending="pending"
          @mention="mention"
          @send="send"
        />
      </section>

      <section class="panel context-panel">
        <div class="panel-header">Agent Sessions</div>
        <ChatContextPanel
          :agents="chatView?.agents ?? []"
          :sessions="chatView?.sessions ?? []"
          :pending="pending"
          @new-session="newSession"
        />
      </section>
    </div>
  </div>
</template>

<style scoped>
.chats-layout {
  grid-template-columns: 260px 1fr 280px;
  height: calc(100vh - 170px);
}
.chat-panel { display: flex; flex-direction: column; height: 100%; }
.chat-list-panel { height: 100%; }
.context-panel { height: 100%; }
.inline-error { padding: 9px 16px; background: var(--danger-soft); color: var(--danger); border-bottom: 1px solid #fecaca; }
.retry { margin-left: 12px; }

@media (max-width: 1100px) {
  .chats-layout { grid-template-columns: 220px 1fr; }
  .context-panel { display: none; }
}
@media (max-width: 768px) {
  .chats-layout { grid-template-columns: 1fr; height: auto; }
  .chat-list-panel { display: none; }
  .chat-panel { min-height: calc(100vh - 170px); }
}
</style>
