<script setup lang="ts">
import type { ChatListItem } from "@/types/chat";

defineProps<{
  chat: ChatListItem;
  selected: boolean;
}>();

const emit = defineEmits<{
  (e: "select", id: string): void;
}>();
</script>

<template>
  <button
    type="button"
    class="chat-row"
    :class="{ active: selected }"
    @click="emit('select', chat.id)"
  >
    <div class="chat-row-header">
      <span class="chat-handle">{{ chat.handle }}</span>
      <span class="chat-kind">{{ chat.kind }}</span>
    </div>
    <div class="chat-meta">
      <template v-if="chat.kind === 'local'">
        {{ chat.status === "active" ? "active" : chat.status }}
        <span v-if="chat.lastActivityAt">· {{ chat.lastActivityAt }}</span>
      </template>
      <template v-else>
        {{ chat.name }}
        <span v-if="chat.unreadCount > 0" class="unread-badge">{{ chat.unreadCount }}</span>
      </template>
    </div>
  </button>
</template>

<style scoped>
.chat-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 16px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  width: 100%;
}
.chat-row:hover { background: var(--surface-2); }
.chat-row:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
.chat-row.active { background: var(--primary-soft); box-shadow: inset 3px 0 var(--primary); }
.chat-row-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.chat-handle { font-weight: 700; font-size: 14px; }
.chat-meta { font-size: 12px; color: var(--text-secondary); }
.chat-kind { font-size: 10px; text-transform: uppercase; color: var(--text-dim); font-weight: 700; }
.unread-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--danger);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
}
</style>
