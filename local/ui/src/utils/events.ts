import type { RuntimeAuditOutput } from "@/api/schema";

export type EventLifecycle =
  | "queued"
  | "running"
  | "retrying"
  | "succeeded"
  | "failed"
  | "delivery_pending"
  | "delivered"
  | "delivery_failed";

export function deriveLifecycle(audit: RuntimeAuditOutput): EventLifecycle {
  const execution = audit.execution;
  if (!execution) return "succeeded";
  if (execution.status === "queued") return "queued";
  if (execution.status === "running") return "running";
  if (execution.status === "retry_wait") return "retrying";
  if (execution.status === "failed") return "failed";
  if (!audit.resultEvent) return "succeeded";
  if (audit.resultEvent.outcome === "failed") return "failed";
  if (audit.deliveries.length === 0) return "succeeded";
  const statuses = audit.deliveries.map((item) => item.delivery.status);
  if (statuses.some((status) => status === "failed")) return "delivery_failed";
  if (statuses.every((status) => status === "delivered")) return "delivered";
  return "delivery_pending";
}
export function lifecycleLabel(lifecycle: EventLifecycle): string {
  return {
    queued: "Queued",
    running: "Running",
    retrying: "Retrying",
    succeeded: "Succeeded",
    failed: "Failed",
    delivery_pending: "Delivery Pending",
    delivered: "Delivered",
    delivery_failed: "Delivery Failed"
  }[lifecycle];
}

export function lifecycleClass(lifecycle: EventLifecycle): string {
  return {
    queued: "muted",
    running: "info",
    retrying: "warning",
    succeeded: "success",
    failed: "danger",
    delivery_pending: "warning",
    delivered: "success",
    delivery_failed: "danger"
  }[lifecycle];
}
