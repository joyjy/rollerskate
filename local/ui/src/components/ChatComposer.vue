<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import type { LocalAgent } from "@/types/local";

const props = defineProps<{
  modelValue: string;
  agents: readonly LocalAgent[];
  activeAgents: readonly LocalAgent[];
  pending: string | null;
  topicHandle?: string;
  identityLabel?: string;
  replyTo?: { readonly sender: { readonly handleSnapshot: string }; readonly body: string };
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "send", body: string): void;
  (e: "mention", agent: LocalAgent): void;
  (e: "cancelReply"): void;
}>();

const text = ref(props.modelValue);
const textarea = ref<HTMLTextAreaElement | null>(null);
defineExpose({ focus: () => textarea.value?.focus() });

const maximumHeight = 160;

function resize() {
  const element = textarea.value;
  if (element === null) return;
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, maximumHeight)}px`;
  element.style.overflowY = element.scrollHeight > maximumHeight ? "auto" : "hidden";
}

watch(() => props.modelValue, (value) => {
  if (value !== text.value) text.value = value;
  void nextTick(resize);
});

watch(text, (value) => {
  emit("update:modelValue", value);
  void nextTick(resize);
});

onMounted(resize);

function send() {
  const body = text.value.trim();
  if (!body || props.pending !== null) return;
  emit("send", body);
}
</script>

<template>
  <div class="composer">
    <div v-if="replyTo" class="reply-preview">
      <div>
        <strong>Replying to {{ replyTo.sender.handleSnapshot }}</strong>
        <span>{{ replyTo.body }}</span>
      </div>
      <button type="button" aria-label="Cancel reply" @click="emit('cancelReply')">×</button>
    </div>
    <div class="mention-row">
      <span>Quick mention</span>
      <button
        v-for="agent in activeAgents"
        :key="agent.principalId"
        type="button"
        :disabled="pending !== null"
        @click="emit('mention', agent)"
      >
        @{{ agent.handle }}
      </button>
      <span v-if="activeAgents.length === 0">No active Agents</span>
    </div>
    <textarea
      ref="textarea"
      v-model="text"
      rows="1"
      :placeholder="`Message ${topicHandle ?? '#local'}…`"
      :disabled="pending !== null"
      @keydown.meta.enter.prevent="send"
      @keydown.ctrl.enter.prevent="send"
    ></textarea>
    <div class="composer-foot">
      <span>{{ identityLabel ? `${identityLabel} · ` : "" }}⌘/Ctrl + Enter · immutable</span>
      <button
        class="primary-button"
        type="button"
        :disabled="!props.modelValue.trim() || pending !== null"
        @click="send"
      >
        {{ pending === "send" ? "Sending…" : "Send" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.composer {
  padding: 12px 16px 14px;
  border-top: 1px solid var(--border);
  background: var(--surface-2);
  flex-shrink: 0;
}
.reply-preview {
  display: flex; justify-content: space-between; gap: 12px; margin-bottom: 8px;
  padding: 8px 10px; border-left: 3px solid var(--primary); background: var(--surface);
}
.reply-preview div { display: grid; min-width: 0; gap: 2px; }
.reply-preview span { overflow: hidden; color: var(--text-secondary); text-overflow: ellipsis; white-space: nowrap; }
.reply-preview button { border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; }
.mention-row {
  display: flex;
  gap: 7px;
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: 8px;
  color: var(--text-secondary);
  font-size: 11px;
}
.mention-row button {
  appearance: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  padding: 3px 7px;
  font-size: 11px;
  cursor: pointer;
}
.mention-row button:hover:not(:disabled) { background: var(--surface-2); }
.mention-row button:disabled { opacity: 0.5; cursor: not-allowed; }
textarea {
  width: 100%;
  box-sizing: border-box;
  resize: none;
  min-height: 42px;
  max-height: 160px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
}
textarea:focus { outline: 2px solid var(--primary-soft); border-color: var(--primary); }
.composer-foot {
  margin-top: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  color: var(--text-dim);
  font-size: 11px;
}
</style>
