<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { LocalAgentClient } from "@/types/local";

defineProps<{
  handle: string;
  client: LocalAgentClient;
  launchArgsText: string;
  pending: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  "update:handle": [value: string];
  "update:client": [value: LocalAgentClient];
  "update:launchArgsText": [value: string];
  close: [];
  add: [];
}>();
const handleInput = ref<HTMLInputElement | null>(null);
onMounted(() => handleInput.value?.focus());
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="add-agent-title">
      <div class="modal-header"><h3 id="add-agent-title">Add Agent</h3></div>
      <div class="modal-body">
        <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
        <div class="field">
          <label for="new-handle">Handle</label>
          <input
            id="new-handle"
            ref="handleInput"
            :value="handle"
            type="text"
            maxlength="32"
            placeholder="researcher"
            autocomplete="off"
            :disabled="pending"
            @input="emit('update:handle', ($event.target as HTMLInputElement).value)"
          />
          <div class="preview">将显示为 <strong>@{{ handle.trim() || "researcher" }}</strong>，大小写不敏感且唯一。</div>
        </div>
        <div class="field">
          <label for="new-client">Client</label>
          <select
            id="new-client"
            :value="client"
            :disabled="pending"
            @change="emit('update:client', ($event.target as HTMLSelectElement).value as LocalAgentClient)"
          >
            <option value="codex">Codex</option>
            <option value="claude-code">Claude Code</option>
            <option value="kimi-code">Kimi Code</option>
          </select>
          <div class="preview">决定该 Agent 使用哪个执行 adapter。</div>
        </div>
        <div class="field">
          <label for="new-launch-args">Launch arguments</label>
          <textarea
            id="new-launch-args"
            :value="launchArgsText"
            rows="4"
            placeholder="--model&#10;claude-sonnet-4-6"
            :disabled="pending"
            @input="emit('update:launchArgsText', ($event.target as HTMLTextAreaElement).value)"
          />
          <div class="preview">每行一个 argv 参数；协议、Session、工作区和权限参数由 adapter 控制。</div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="secondary-button" :disabled="pending" @click="emit('close')">Cancel</button>
        <button type="button" class="primary-button" :disabled="!handle.trim() || pending" @click="emit('add')">
          {{ pending ? "Adding…" : "Add Agent" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 16px; }
.modal { background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow-lg); width: 100%; max-width: 420px; overflow: hidden; }
.modal-header { padding: 16px; border-bottom: 1px solid var(--border); }
.modal-header h3 { margin: 0; font-size: 16px; }
.modal-body { padding: 16px; }
.modal-footer { padding: 12px 16px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 10px; }
.field { margin-bottom: 14px; }
.field label { display: block; font-size: 12px; font-weight: 700; color: var(--text-secondary); margin-bottom: 6px; }
.field input, .field select, .field textarea { width: 100%; border: 1px solid var(--border); border-radius: 7px; padding: 9px 10px; font: inherit; background: var(--surface); color: var(--text); }
.field textarea { resize: vertical; font-family: var(--mono); font-size: 12px; }
.preview { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }
</style>
