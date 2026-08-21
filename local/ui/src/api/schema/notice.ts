import * as v from "valibot";
import { nullableString } from "./shared";

export const noticeSummaryViewSchema = v.object({
  noticeId: v.string(),
  title: v.string(),
  summary: v.string(),
  outcome: v.union([v.literal("succeeded"), v.literal("failed")]),
  deliveryStatus: v.union([
    v.literal("pending"),
    v.literal("delivering"),
    v.literal("retry_wait"),
    v.literal("delivered"),
    v.literal("failed")
  ]),
  statusReason: v.string(),
  source: v.object({
    kind: v.literal("delivery"),
    sourceId: v.string(),
    subscriptionId: nullableString
  }),
  references: v.object({
    eventId: v.string(),
    deliveryId: v.string(),
    destinationId: v.string()
  }),
  sourceAction: v.object({
    label: v.string(),
    consoleRoute: v.string(),
    cliHint: v.string()
  }),
  failure: v.nullable(v.object({
    failureRef: v.string(),
    consoleRoute: v.string()
  })),
  occurredAt: v.string(),
  deliveredAt: nullableString,
  readAt: nullableString,
  acknowledgedAt: nullableString,
  availableActions: v.object({
    markRead: v.boolean(),
    acknowledge: v.boolean()
  })
});

export const noticeDetailViewSchema = v.object({
  summary: noticeSummaryViewSchema,
  projection: v.object({
    projectionUpdatedAt: v.string(),
    stateUpdatedAt: nullableString,
    deliveryError: nullableString
  })
});

export const noticeCenterViewSchema = v.object({
  counts: v.object({
    total: v.number(),
    unread: v.number(),
    unacknowledged: v.number()
  }),
  notices: v.array(noticeSummaryViewSchema)
});

export type NoticeSummaryViewOutput = v.InferOutput<typeof noticeSummaryViewSchema>;
export type NoticeDetailViewOutput = v.InferOutput<typeof noticeDetailViewSchema>;
export type NoticeCenterViewOutput = v.InferOutput<typeof noticeCenterViewSchema>;
