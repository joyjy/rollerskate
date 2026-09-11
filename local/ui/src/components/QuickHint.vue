<script setup lang="ts">
import { computed } from "vue";
import { formatDateTime } from "@/utils/format";
import type { Subscription, SubscriptionStatus } from "@/types/subscription";
import StatusBadge from "./StatusBadge.vue";

const props = defineProps<{
  subscription: Subscription;
  busy: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  (e: "action", action: "pause" | "resume" | "cancel"): void;
  (e: "archive", archived: boolean): void;
}>();

interface Hint { title: string; body: string; variant: "" | "unknown" | "failed"; }

const hints: Record<SubscriptionStatus, Hint> = {
  active: { title: "Polling", body: "Runtime 正按持久 schedule 执行 Plugin 声明的单次 probe。", variant: "" },
  paused: { title: "Paused", body: "Subscription 已暂停，不会执行新的 poll。点击 Resume 恢复。", variant: "" },
  completed: { title: "Completed", body: "Terminal observation 与已配置 callback 都已持久化收敛。", variant: "" },
  blocked: { title: "Blocked", body: "Agent callback 缺少完成任务所需的权限、凭据、工具或外部前置条件。", variant: "unknown" },
  cancelled: { title: "Cancelled", body: "Subscription 已被用户取消，不会再自动执行。", variant: "" },
  expired: { title: "Expired", body: "Subscription 已超过 expiry 时间。", variant: "" }
};

const hint = computed(() => hints[props.subscription.status]);
const runBound = computed(() => props.subscription.kind === "free"
  ? props.subscription.definition.schema === "SubscriptionDefinition@4"
  : props.subscription.definition.schemaVersion === "ContinuousSubscriptionDefinition@2");

const canPause = computed(() => props.subscription.status === "active");
const canResume = computed(() => props.subscription.status === "paused");
const canCancel = computed(() => ["active", "paused"].includes(props.subscription.status));
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
      <dt>Title</dt>
      <dd>{{ subscription.title }}</dd>
      <dt>Owner</dt>
      <dd v-if="subscription.owner">@{{ subscription.owner.handle }} · {{ subscription.owner.client }}</dd>
      <dd v-else>Run-owned source</dd>
      <dt>Provider Session</dt>
      <dd>{{ runBound ? "Run execution" : (subscription.kind === "free" ? "legacy per callback" : "legacy continuous callbacks") }}</dd>
      <dt>Local Session</dt>
      <dd>{{ subscription.kind === "free" ? subscription.definition.callbackPhaseStatus : (subscription.pendingOccurrenceKey ?? "checkpointed") }}</dd>
      <dt>Plugin</dt>
      <dd>{{ subscription.probe?.plugin.id ?? "File events" }}</dd>
      <dt>Updated</dt>
      <dd>{{ formatDateTime(subscription.updatedAt) }}</dd>
    </dl>

    <div class="section-title">Actions</div>
    <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
    <div class="actions">
      <button type="button" class="primary-button action-button" :disabled="busy || !canPause" @click="emit('action', 'pause')">Pause</button>
      <button type="button" class="secondary-button action-button" :disabled="busy || !canResume" @click="emit('action', 'resume')">Resume</button>
      <button type="button" class="secondary-button warning action-button" :disabled="busy || !canCancel" @click="emit('action', 'cancel')">Cancel</button>
      <button v-if="subscription.availableActions.archive" type="button" class="secondary-button action-button" :disabled="busy" @click="emit('archive', true)">Archive</button>
      <button v-if="subscription.availableActions.unarchive" type="button" class="secondary-button action-button" :disabled="busy" @click="emit('archive', false)">Unarchive</button>
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

.action-button {
  text-align: left;
}
</style>
