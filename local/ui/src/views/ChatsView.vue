<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { requestJson } from "@/api/client";
import {
  errorResponseSchema,
  localChatPresenceViewSchema,
  localChatViewSchema
} from "@/api/schema";
import { useApi } from "@/composables/useApi";
import { useMutation } from "@/composables/useMutation";
import ChatList from "@/components/ChatList.vue";
import ChatTimeline from "@/components/ChatTimeline.vue";
import ChatComposer from "@/components/ChatComposer.vue";
import ChatContextPanel from "@/components/ChatContextPanel.vue";
import type { ChatListItem } from "@/types/chat";
import type { LocalAgent } from "@/types/local";

const selectedId = ref<string>("local");
const composer = ref("");
const pending = ref<string | null>(null);
const chatTimelineRef = ref<InstanceType<typeof ChatTimeline> | null>(null);
const pollingPaused = computed(() => pending.value !== null);
const {
  data: chatView,
  loading: chatLoading,
  error: loadError,
  refresh: refreshChat
} = useApi({
  url: "/api/chat",
  schema: localChatViewSchema,
  interval: 2_000,
  paused: pollingPaused
});
const presenceQuery = useApi({
  url: "/api/chat/presence",
  schema: localChatPresenceViewSchema,
  interval: 2_000,
  paused: pollingPaused
});
const mutation = useMutation({
  execute(input: { path: string; body?: object }, signal) {
    return requestJson(input.path, errorResponseSchema, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Rollerskate-Request": "console"
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal
    });
  },
  async refresh() {
    await Promise.all([refreshChat(), presenceQuery.refresh()]);
  }
});
const loading = computed(() => chatLoading.value || presenceQuery.loading.value);
const presenceAgents = computed(() => presenceQuery.data.value?.agents ?? []);
const error = computed(() =>
  mutation.error.value ?? loadError.value ?? presenceQuery.error.value
);

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
  const result = await mutation.execute({
    path: "/api/chat/messages",
    body: { body: text }
  });
  if (result !== null) {
    composer.value = "";
    await nextTick();
    chatTimelineRef.value?.scrollToBottom();
  }
  pending.value = null;
}

async function newSession(agent: LocalAgent) {
  if (pending.value) return;
  pending.value = agent.principalId;
  await mutation.execute({
    path: `/api/chat/agents/${encodeURIComponent(agent.principalId)}/new-session`
  });
  pending.value = null;
}

async function refreshAll() {
  await Promise.all([refreshChat(), presenceQuery.refresh()]);
}

async function setPresence(
  agent: LocalAgent,
  presence: { readonly mode: "available" | "snoozed"; readonly until?: string }
) {
  if (pending.value || agent.status !== "active") return;
  pending.value = `presence:${agent.principalId}`;
  await mutation.execute({
    path: `/api/chat/agents/${encodeURIComponent(agent.principalId)}/presence`,
    body: presence
  });
  pending.value = null;
}
</script>

<template>
  <div class="chats-page">
    <div v-if="loading" class="state">Loading immutable Chat history…</div>
    <div v-else-if="error && !chatView" class="state error" role="alert">
      Could not load Chats: {{ error }}
      <button
        type="button"
        class="secondary-button retry"
        @click="refreshAll"
      >Retry</button>
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
          :messages="chatView?.messages.items ?? []"
          :active-agents="activeAgents"
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
          :presence-agents="presenceAgents"
          :sessions="chatView?.sessions ?? []"
          :pending="pending"
          @new-session="newSession"
          @set-presence="setPresence"
        />
      </section>
    </div>
  </div>
</template>

<style scoped>
.chats-layout {
  grid-template-columns: 260px 1fr 280px;
  height: calc(100vh - 170px);
  height: calc(100dvh - 170px);
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
  .chat-panel { min-height: calc(100vh - 170px); min-height: calc(100dvh - 170px); }
}
</style>
