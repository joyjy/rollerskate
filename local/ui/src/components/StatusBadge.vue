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
  expired: "Expired",
  revoked: "Revoked"
};
</script>

<template>
  <span class="badge" :class="props.status">
    {{ labels[props.status] }}
  </span>
</template>

<style scoped>
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.badge.active { background: var(--success-soft); color: var(--success); }
.badge.paused { background: var(--muted-soft); color: var(--muted); }
.badge.running { background: var(--primary-soft); color: var(--primary); }
.badge.triggered { background: var(--warning-soft); color: var(--warning); }
.badge.completed { background: var(--success-soft); color: var(--success); }
.badge.failed { background: var(--danger-soft); color: var(--danger); }
.badge.unknown { background: var(--warning-soft); color: var(--warning); }
.badge.cancelled { background: var(--muted-soft); color: var(--muted); }
.badge.expired { background: var(--muted-soft); color: var(--muted); }
.badge.revoked { background: var(--danger-soft); color: var(--danger); }
</style>
