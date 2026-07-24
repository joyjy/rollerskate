<script setup lang="ts">
import ChatListItem from "./ChatListItem.vue";
import type { ChatListItem as ChatListItemType } from "@/types/chat";

defineProps<{
  chats: ChatListItemType[];
  selectedId: string;
}>();

const emit = defineEmits<{
  (e: "select", id: string): void;
}>();

function chatsByKind(kind: ChatListItemType["kind"]) {
  return (chats: ChatListItemType[]) => chats.filter((c) => c.kind === kind);
}
</script>

<template>
  <div class="chat-list">
    <div class="list-section-title">Local</div>
    <ChatListItem
      v-for="chat in chatsByKind('local')(chats)"
      :key="chat.id"
      :chat="chat"
      :selected="chat.id === selectedId"
      @select="emit('select', $event)"
    />

    <div class="list-section-title">Server rooms</div>
    <template v-if="chatsByKind('server')(chats).length === 0">
      <div class="state">
        No server rooms yet.<br>
        Server group chats will appear here.
      </div>
    </template>
    <ChatListItem
      v-for="chat in chatsByKind('server')(chats)"
      v-else
      :key="chat.id"
      :chat="chat"
      :selected="chat.id === selectedId"
      @select="emit('select', $event)"
    />
  </div>
</template>

<style scoped>
.chat-list { overflow-y: auto; }
.list-section-title {
  padding: 10px 16px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
}
</style>
