<script setup lang="ts">
import { computed, ref } from "vue";
import type { Subscription, SubscriptionStatus } from "@/types/subscription";
import StatusBadge from "./StatusBadge.vue";

const props = defineProps<{
  subscription: Subscription;
}>();

const emit = defineEmits<{
  (e: "update", subscription: Subscription): void;
}>();

interface Hint { title: string; body: string; variant: "" | "unknown" | "failed"; }

const hints: Record<SubscriptionStatus, Hint> = {
  active: { title: "Polling", body: "Runtime 正按持久 schedule 执行 Plugin 声明的单次 probe。", variant: "" },
  paused: { title: "Paused", body: "Subscription 已暂停，不会执行新的 poll。点击 Resume 恢复。", variant: "" },
  running: { title: "Running", body: "Subscription 已触发，正在执行 continuation。", variant: "" },
  triggered: { title: "Triggered", body: "Subscription 已命中 terminal 条件，等待 admission。", variant: "" },
  completed: { title: "Fired", body: "一次性 Subscription 已原子生成 subscription.fire Event。", variant: "" },
  failed: { title: "Failed", body: "Subscription 处理失败且已耗尽重试。", variant: "failed" },
  unknown: { title: "Unknown", body: "Provider 结果不明，UI 不提供可能重复 side effect 的 retry。", variant: "unknown" },
  cancelled: { title: "Cancelled", body: "Subscription 已被用户取消，不会再自动执行。", variant: "" },
  expired: { title: "Expired", body: "Subscription 已超过 expiry 时间。", variant: "" },
  revoked: { title: "Revoked", body: "关联 grant 已撤销，Subscription 不再有效。", variant: "failed" }
};

const hint = computed(() => hints[props.subscription.status]);

const canPause = computed(() => props.subscription.status === "active");
const canResume = computed(() => props.subscription.status === "paused");
const canCancel = computed(() => ["active", "paused"].includes(props.subscription.status));
const canRevoke = computed(() => ["active", "paused"].includes(props.subscription.status));
const busy = ref(false);

const formatTime = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });

async function act(action: "pause" | "resume" | "cancel" | "revoke") {
  busy.value = true;
  try {
    const response = await fetch(`/api/subscriptions/${encodeURIComponent(props.subscription.id)}/${action}`, {
      method: "POST",
      headers: { Accept: "application/json", "X-Rollerskate-Request": "console" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    emit("update", await response.json() as Subscription);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="inspector-body">
    <div class="hint-card" :class="hint.variant">
      <strong>{{ hint.title }}</strong>
      <div>{{ hint.body }}</div>
    </div>

    <div class="section-title">Summary</div>
    <dl class="mini-kv">
      <dt>Status</dt>
      <dd><StatusBadge :status="subscription.status" /></dd>
      <dt>Session</dt>
      <dd>{{ subscription.sessionId }}</dd>
      <dt>Plugin</dt>
      <dd>{{ subscription.plugin.id }}</dd>
      <dt>Fire Event</dt>
      <dd>{{ subscription.fireEventId ?? "pending" }}</dd>
      <dt>Updated</dt>
      <dd>{{ formatTime(subscription.updatedAt) }}</dd>
    </dl>

    <div class="section-title">Actions</div>
    <div class="actions">
      <button class="primary" :disabled="busy || !canPause" @click="act('pause')">Pause</button>
      <button :disabled="busy || !canResume" @click="act('resume')">Resume</button>
      <button class="warning" :disabled="busy || !canCancel" @click="act('cancel')">Cancel</button>
      <button class="danger" :disabled="busy || !canRevoke" @click="act('revoke')">Revoke</button>
    </div>
  </div>
</template>

<style scoped>
.inspector-body {
  padding: 16px;
}

.hint-card {
  background: var(--primary-soft);
  border: 1px solid #bfdbfe;
  border-radius: 8px;
  padding: 12px;
  font-size: 13px;
  margin-bottom: 14px;
}

.hint-card.unknown {
  background: var(--warning-soft);
  border-color: #fcd34d;
  color: #92400e;
}

.hint-card.failed {
  background: var(--danger-soft);
  border-color: #fecaca;
  color: #991b1b;
}

.hint-card strong {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.mini-kv {
  display: grid;
  grid-template-columns: 70px 1fr;
  gap: 4px 8px;
  font-size: 12px;
  margin-top: 8px;
}

.mini-kv dt {
  color: var(--text-secondary);
}

.mini-kv dd {
  margin: 0;
  word-break: break-word;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
}

button {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  padding: 9px 14px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  text-align: left;
}

button:hover {
  background: var(--bg);
}

button.primary {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}

button.primary:hover {
  background: #1d4ed8;
}

button.danger {
  color: var(--danger);
  border-color: var(--danger);
}

button.danger:hover {
  background: var(--danger-soft);
}

button.warning {
  color: var(--warning);
  border-color: var(--warning);
}

button.warning:hover {
  background: var(--warning-soft);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
