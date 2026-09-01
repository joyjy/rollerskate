import { RuntimeStore } from "../../core/runtime/store.js";
import { runtimePaths } from "../../infrastructure/runtime/config.js";

const DELIVERY_FAILURE_PREFIX = "failure:delivery:";

export interface DeliveryRetryReceipt {
  readonly schemaVersion: "DeliveryRetryReceipt@1";
  readonly failureRef: string;
  readonly deliveryId: string;
  readonly previousStatus: "failed" | "pending" | "delivering" | "retry_wait" | "delivered";
  readonly status: "failed" | "pending" | "delivering" | "retry_wait" | "delivered";
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: string;
}

export function retryRuntimeFailure(
  repoRoot: string,
  failureRef: string,
  runtimeDirectory?: string,
  at = new Date().toISOString()
): DeliveryRetryReceipt {
  if (!failureRef.startsWith(DELIVERY_FAILURE_PREFIX)) {
    throw new Error("failure retry only supports failure:delivery:<delivery-id>");
  }
  const deliveryId = failureRef.slice(DELIVERY_FAILURE_PREFIX.length);
  if (deliveryId === "" || deliveryId.includes(":")) {
    throw new Error("failure retry requires one exact Delivery failure ref");
  }
  const store = new RuntimeStore(runtimePaths(repoRoot, runtimeDirectory).database);
  try {
    const previous = store.delivery(deliveryId);
    if (previous === undefined) throw new Error(`Delivery not found: ${deliveryId}`);
    const delivery = store.retryFailedDelivery(deliveryId, at);
    return {
      schemaVersion: "DeliveryRetryReceipt@1",
      failureRef,
      deliveryId,
      previousStatus: previous.status,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      maxAttempts: delivery.maxAttempts,
      nextAttemptAt: delivery.nextAttemptAt
    };
  } finally {
    store.close();
  }
}
