<script setup lang="ts">
import type { RuntimeAuditOutput } from "@/api/schema";
import { formatDateTime } from "@/utils/format";

defineProps<{
  title: string;
  execution: NonNullable<RuntimeAuditOutput["execution"]>;
}>();
</script>

<template>
  <div class="section-title">{{ title }}</div>
  <dl class="kv">
    <dt>ID</dt><dd class="mono">{{ execution.executionId }}</dd>
    <dt>Status</dt><dd>{{ execution.status }}</dd>
    <dt>Attempts</dt><dd>{{ execution.attemptCount }}/{{ execution.maxAttempts }}</dd>
    <dt>First started</dt><dd>{{ formatDateTime(execution.firstStartedAt) }}</dd>
    <dt>Last attempt</dt><dd>{{ formatDateTime(execution.lastAttemptAt) }}</dd>
    <dt>Completed</dt><dd>{{ formatDateTime(execution.completedAt) }}</dd>
    <dt>Next retry</dt><dd>{{ formatDateTime(execution.nextAttemptAt) }}</dd>
    <dt v-if="execution.lastError">Error</dt><dd v-if="execution.lastError" class="error">{{ execution.lastError }}</dd>
  </dl>
</template>

<style scoped>
.section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--text-secondary); margin: 16px 0 10px; }
.kv { display: grid; grid-template-columns: 130px 1fr; gap: 6px 14px; font-size: 13px; }
.kv dt { color: var(--text-secondary); font-weight: 500; }
.kv dd { margin: 0; word-break: break-word; }
.mono { font-family: var(--mono); font-size: 12px; word-break: break-all; }
.error { color: var(--danger); }
</style>
