import { runtimePaths } from "../../infrastructure/runtime/config.js";
import {
  NoticeStore,
  type NoticeProjection
} from "../../infrastructure/sqlite/notice-store.js";
import {
  runtimeFailureConsoleRoute,
  runtimeFailureRef
} from "../runtime/failure-query.js";

export interface NoticeSummaryView {
  readonly noticeId: string;
  readonly title: string;
  readonly summary: string;
  readonly outcome: "succeeded" | "failed";
  readonly deliveryStatus:
    | "pending"
    | "delivering"
    | "retry_wait"
    | "delivered"
    | "failed";
  readonly statusReason: string;
  readonly source: {
    readonly kind: "delivery";
    readonly sourceId: string;
    readonly subscriptionId: string | null;
  };
  readonly references: {
    readonly eventId: string;
    readonly deliveryId: string;
    readonly destinationId: string;
  };
  readonly sourceAction: {
    readonly label: string;
    readonly consoleRoute: string;
    readonly cliHint: string;
  };
  readonly failure: {
    readonly failureRef: string;
    readonly consoleRoute: string;
  } | null;
  readonly occurredAt: string;
  readonly deliveredAt: string | null;
  readonly readAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly availableActions: {
    readonly markRead: boolean;
    readonly acknowledge: boolean;
  };
}

export interface NoticeDetailView {
  readonly summary: NoticeSummaryView;
  readonly projection: {
    readonly projectionUpdatedAt: string;
    readonly stateUpdatedAt: string | null;
    readonly deliveryError: string | null;
  };
}

export interface NoticeCenterView {
  readonly counts: {
    readonly total: number;
    readonly unread: number;
    readonly unacknowledged: number;
  };
  readonly notices: readonly NoticeSummaryView[];
}

export function noticeCenterView(
  repoRoot: string,
  runtimeDirectory?: string,
  limit = 100
): NoticeCenterView {
  const store = openStore(repoRoot, runtimeDirectory);
  try {
    return {
      counts: store.counts(),
      notices: store.list(limit).map(noticeSummaryView)
    };
  } finally {
    store.close();
  }
}

export function listNoticeViews(
  repoRoot: string,
  runtimeDirectory?: string,
  limit = 100
): readonly NoticeSummaryView[] {
  return noticeCenterView(repoRoot, runtimeDirectory, limit).notices;
}

export function inspectNoticeView(
  repoRoot: string,
  noticeId: string,
  runtimeDirectory?: string
): NoticeDetailView {
  const store = openStore(repoRoot, runtimeDirectory);
  try {
    return noticeDetailView(store.require(noticeId));
  } finally {
    store.close();
  }
}

export function noticeSummaryView(
  notice: NoticeProjection
): NoticeSummaryView {
  const failureRef = notice.deliveryStatus === "failed"
    ? runtimeFailureRef("delivery", notice.sourceId)
    : null;
  const sourceAction = notice.subscriptionId === null
    ? {
        label: "Inspect Event",
        consoleRoute:
          `/console/events?eventId=${encodeURIComponent(notice.eventId)}`,
        cliHint: `scripts/rs event trace ${notice.eventId}`
      }
    : {
        label: "Inspect Subscription",
        consoleRoute:
          `/console/subscriptions?subscriptionId=${encodeURIComponent(
            notice.subscriptionId
          )}`,
        cliHint: `scripts/rs subscription inspect ${notice.subscriptionId}`
      };
  return {
    noticeId: notice.noticeId,
    title: notice.title,
    summary: notice.summary,
    outcome: notice.outcome,
    deliveryStatus: notice.deliveryStatus,
    statusReason: noticeStatusReason(notice),
    source: {
      kind: notice.sourceKind,
      sourceId: notice.sourceId,
      subscriptionId: notice.subscriptionId
    },
    references: {
      eventId: notice.eventId,
      deliveryId: notice.sourceId,
      destinationId: notice.destinationId
    },
    sourceAction,
    failure: failureRef === null
      ? null
      : {
          failureRef,
          consoleRoute: runtimeFailureConsoleRoute(failureRef)
        },
    occurredAt: notice.occurredAt,
    deliveredAt: notice.deliveredAt,
    readAt: notice.readAt,
    acknowledgedAt: notice.acknowledgedAt,
    availableActions: {
      markRead: notice.readAt === null,
      acknowledge: notice.acknowledgedAt === null
    }
  };
}

export function noticeDetailView(
  notice: NoticeProjection
): NoticeDetailView {
  return {
    summary: noticeSummaryView(notice),
    projection: {
      projectionUpdatedAt: notice.projectionUpdatedAt,
      stateUpdatedAt: notice.stateUpdatedAt,
      deliveryError: notice.deliveryError
    }
  };
}

function noticeStatusReason(notice: NoticeProjection): string {
  if (notice.deliveryError !== null) return notice.deliveryError;
  if (notice.deliveryStatus === "pending") {
    return "The notification is waiting for local delivery.";
  }
  if (notice.deliveryStatus === "delivering") {
    return "The notification delivery is in progress.";
  }
  if (notice.deliveryStatus === "retry_wait") {
    return "The notification is waiting for a bounded retry.";
  }
  if (notice.deliveryStatus === "failed") {
    return "The notification could not be delivered.";
  }
  return notice.outcome === "succeeded"
    ? "The Agent result was delivered as a local notification."
    : "The failed Agent result was delivered as a local notification.";
}

function openStore(
  repoRoot: string,
  runtimeDirectory?: string
): NoticeStore {
  return new NoticeStore(runtimePaths(repoRoot, runtimeDirectory).database, { readOnly: true });
}
