import type { SubscriptionOutput } from "@/api/schema";

export type Subscription = SubscriptionOutput;
export type FreeSubscription = Extract<Subscription, { kind: "free" }>;
export type ContinuousSubscription = Extract<Subscription, { kind: "continuous" }>;
export type SubscriptionStatus = Subscription["status"];
export type SubscriptionVisualStatus =
  | SubscriptionStatus
  | "running"
  | "failed"
  | "unknown";
