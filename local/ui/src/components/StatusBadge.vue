<script setup lang="ts">
import type { SubscriptionStatus } from "@/types/subscription";

const props = defineProps<{
  status: SubscriptionStatus;
}>();

const labels: Record<SubscriptionStatus, string> = {
  active: "Active",
  paused: "Paused",
  running: "Running",
  triggered: "Triggered",
  completed: "Completed",
  failed: "Failed",
  unknown: "Unknown",
  cancelled: "Cancelled",
  expired: "Expired"
};
</script>

<template>
  <span class="badge" :class="props.status">
    {{ labels[props.status] }}
  </span>
</template>

<style scoped>
.badge.active { background: var(--success-soft); color: var(--success); }
.badge.paused { background: var(--muted-soft); color: var(--muted); }
.badge.running { background: var(--primary-soft); color: var(--primary); }
.badge.triggered { background: var(--warning-soft); color: var(--warning); }
.badge.completed { background: var(--success-soft); color: var(--success); }
.badge.failed { background: var(--danger-soft); color: var(--danger); }
.badge.unknown { background: var(--warning-soft); color: var(--warning); }
.badge.cancelled { background: var(--muted-soft); color: var(--muted); }
.badge.expired { background: var(--muted-soft); color: var(--muted); }
</style>
