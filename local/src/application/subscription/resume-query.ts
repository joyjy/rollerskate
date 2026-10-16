import { inspectSubscriptionView } from "./query.js";

export interface SubscriptionResumeReceipt {
  readonly schemaVersion: "SubscriptionResumeReceipt@1";
  readonly subscriptionId: string;
  readonly acceptedAt: string;
  readonly acceptedStateToken: string;
}

/** Read the persisted source state after resume or after a caller's bounded wait. */
export function readSubscriptionResumeOutcome(
  repoRoot: string,
  receipt: SubscriptionResumeReceipt,
  runtimeDirectory?: string
) {
  if (receipt.schemaVersion !== "SubscriptionResumeReceipt@1" ||
    !receipt.subscriptionId || !receipt.acceptedStateToken ||
    !Number.isFinite(Date.parse(receipt.acceptedAt))) {
    throw new Error("Subscription resume requires an exact accepted receipt");
  }
  const view = inspectSubscriptionView(repoRoot, receipt.subscriptionId, runtimeDirectory);
  const status = view.status;
  return {
    schemaVersion: "SubscriptionResumeReadback@1" as const,
    receipt,
    observedAt: new Date().toISOString(),
    subscription: { id: view.id, status, updatedAt: view.updatedAt },
    outcome: status === "blocked" ? "blocked" as const
      : status === "paused" ? "paused" as const
        : status === "active" ? "currently_active" as const
          : "ended" as const,
    reason: status === "blocked" || status === "paused"
      ? view.latestError ?? (status === "paused"
        ? "Subscription is paused; inspect source policy and history for the cause."
        : "Subscription is blocked; inspect its history for the cause.")
      : null,
    final: status !== "active"
  };
}
