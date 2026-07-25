<script setup lang="ts">
import { formatDateTime } from "@/utils/format";
import type { Subscription } from "@/types/subscription";
import StatusBadge from "./StatusBadge.vue";

defineProps<{ subscription: Subscription }>();
</script>

<template>
  <div class="main-body">
    <div class="panel-title">{{ subscription.title }}</div>
    <div class="panel-subtitle">
      {{ subscription.id }} ·
      {{ subscription.probe.plugin.id }}@{{ subscription.probe.plugin.schemaVersion }} ·
      <StatusBadge :status="subscription.status" />
    </div>

    <div class="section-title">Registration</div>
    <dl class="kv">
      <dt>Owner</dt>
      <dd>@{{ subscription.owner.handle }} · {{ subscription.owner.client }}</dd>
      <dt>Provider Session</dt>
      <dd class="mono">{{ subscription.callback.providerSessionId }}</dd>
      <dt>Local Session</dt>
      <dd class="mono">{{ subscription.callback.localSessionId ?? "materializes on terminal" }}</dd>
      <dt>Adapter</dt>
      <dd class="mono">{{ subscription.callback.adapterId }}</dd>
      <dt>Workspace</dt>
      <dd class="mono">{{ subscription.callback.workspace }}</dd>
      <dt>Prompt</dt>
      <dd>{{ subscription.callback.prompt }}</dd>
      <dt>Schedule</dt>
      <dd>{{ subscription.schedule.attemptCount }}/{{ subscription.schedule.maxAttempts }} attempts · every {{ subscription.schedule.intervalMilliseconds }}ms · deadline {{ formatDateTime(subscription.schedule.deadlineAt) }}</dd>
      <dt>Plugin</dt>
      <dd class="mono">{{ subscription.probe.plugin.path }}</dd>
      <dt>Policy</dt>
      <dd>{{ subscription.probe.policy.allowedHttpOrigins.length }} HTTP origin(s) · {{ subscription.probe.policy.allowedExecutables.length }} executable(s)</dd>
    </dl>

    <div class="section-title">One-shot Fire</div>
    <div class="fire-card" :class="{ complete: subscription.fireEventId }">
      <strong>{{ subscription.fireEventId ? "subscription.fire admitted" : "waiting for terminal poll" }}</strong>
      <span v-if="subscription.fireEventId" class="mono">{{ subscription.fireEventId }}</span>
      <span v-else>Poll/status remain debug logs and do not create Events.</span>
    </div>
    <div v-if="subscription.latestError" class="error-card">{{ subscription.latestError }}</div>
  </div>
</template>

<style scoped>
.main-body { padding: 22px; min-height: calc(100vh - 180px); }
.panel-title { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
.panel-subtitle { color: var(--text-secondary); font-size: 13px; margin-bottom: 20px; }
.fire-card { display: flex; flex-direction: column; gap: 6px; padding: 14px; border: 1px solid var(--border); border-radius: 8px; color: var(--text-secondary); }
.fire-card.complete { border-color: var(--success); background: var(--success-soft); color: var(--text); }
.error-card { margin-top: 12px; padding: 12px; border: 1px solid var(--danger); background: var(--danger-soft); color: var(--danger); border-radius: 8px; }
.mono { font-family: var(--mono); word-break: break-all; }
</style>
